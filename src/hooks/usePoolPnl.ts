"use client";

import { useState, useEffect, useRef } from "react";
import { getClient } from "@/lib/pools/client";
import { fetchVaultFlows, fetchBlockTimestamps } from "@/lib/pools/reads";
import { fetchPriceChart, type PriceChartPoint } from "@/lib/pools/prices";
import {
  buildCapitalSnapshot, computePnl, buildPnlTimeSeries, computeTwr,
  type PnlAttribution, type CapitalSnapshot, type PnlTimePoint, type TwrResult,
} from "@/lib/pools/pnl";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent, VaultFlow } from "@/lib/pools/types";
import type { Address } from "viem";

/** Cached immutable data (fetched once per pool, never changes) */
interface HistoricalCache {
  capital: CapitalSnapshot;
  flows: VaultFlow[];
  priceChart0: PriceChartPoint[];
  priceChart1: PriceChartPoint[];
  pnlTimeSeries: PnlTimePoint[];
  twrResult: TwrResult | null;
}

/**
 * Computes P&L attribution using on-chain vault events and DeFiLlama prices.
 *
 * On first load: scans vault flows, fetches price charts, builds time series + TWR.
 * On each 30s poll: only re-fetches current prices and recomputes P&L attribution.
 */
export function usePoolPnl(
  pool: PoolConfig,
  state: PoolState | null,
  swaps: SwapEvent[],
  swapsLoading: boolean,
) {
  const [pnl, setPnl] = useState<PnlAttribution | null>(null);
  const [pnlTimeSeries, setPnlTimeSeries] = useState<PnlTimePoint[] | null>(null);
  const [twrResult, setTwrResult] = useState<TwrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<HistoricalCache | null>(null);
  const poolAddrRef = useRef<string>("");

  // Reset cache and state when pool changes
  if (pool.address !== poolAddrRef.current) {
    cacheRef.current = null;
    poolAddrRef.current = pool.address;
    setPnl(null);
    setPnlTimeSeries(null);
    setTwrResult(null);
    setError(null);
  }

  useEffect(() => {
    if (!state || swapsLoading) return;

    let cancelled = false;

    async function compute() {
      setLoading(true);
      try {
        // Build historical cache once (vault flows, price charts, time series, TWR)
        if (!cacheRef.current) {
          const client = getClient();
          const currentBlock = await client.getBlockNumber();

          // Build set of swap transaction hashes to filter out swap-induced vault events
          const swapTxHashes = new Set(swaps.map(s => s.transactionHash));

          const flows = await fetchVaultFlows(
            client,
            pool,
            state!.supplyVault0,
            state!.supplyVault1,
            pool.eulerAccount,
            swapTxHashes,
            pool.deployBlock,
            currentBlock,
          );

          const capital = buildCapitalSnapshot(
            flows,
            state!.asset0Decimals,
            state!.asset1Decimals,
          );

          // Fetch historical price charts (2 API calls, cached)
          const deployTimestamp = await client.getBlock({ blockNumber: pool.deployBlock })
            .then(b => Number(b.timestamp));

          const [priceChart0, priceChart1] = await Promise.all([
            fetchPriceChart(state!.asset0 as Address, deployTimestamp),
            fetchPriceChart(state!.asset1 as Address, deployTimestamp),
          ]);

          // Build P&L time series from swap events + historical prices
          const timeSeries = buildPnlTimeSeries(
            swaps,
            priceChart0,
            priceChart1,
            state!.asset0Decimals,
            state!.asset1Decimals,
          );

          // Enrich flows with timestamps for TWR
          const flowBlockNums = flows.map(f => f.blockNumber);
          if (flowBlockNums.length > 0) {
            const timestamps = await fetchBlockTimestamps(client, flowBlockNums);
            for (const f of flows) {
              f.timestamp = timestamps.get(f.blockNumber);
            }
          }

          const twrRes = computeTwr(
            flows,
            swaps,
            priceChart0,
            priceChart1,
            state!.asset0Decimals,
            state!.asset1Decimals,
          );

          cacheRef.current = {
            capital,
            flows,
            priceChart0,
            priceChart1,
            pnlTimeSeries: timeSeries,
            twrResult: twrRes,
          };

          if (!cancelled) {
            setPnlTimeSeries(timeSeries);
            setTwrResult(twrRes);
          }
        }

        // Compute current P&L (re-fetches current prices each poll)
        const result = await computePnl(state!, swaps, cacheRef.current.capital);
        if (!cancelled) {
          setPnl(result);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to compute P&L");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    compute();
    return () => { cancelled = true; };
  }, [pool, state, swaps, swapsLoading]);

  return { pnl, pnlTimeSeries, twrResult, loading, error };
}
