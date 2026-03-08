"use client";

import { useState, useEffect, useRef } from "react";
import { getClient } from "@/lib/pools/client";
import { fetchVaultFlows, fetchBlockTimestamps } from "@/lib/pools/reads";
import { fetchPriceChart, type PriceChartPoint } from "@/lib/pools/prices";
import {
  buildCapitalSnapshot, computePnl, computeCostBasis, buildPnlTimeSeries, computeTwr,
  type PnlAttribution, type CapitalSnapshot, type PnlTimePoint, type TwrResult,
} from "@/lib/pools/pnl";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent, VaultFlow } from "@/lib/pools/types";
import type { Address } from "viem";

/** Cached immutable data (fetched once per pool, never changes) */
interface HistoricalCache {
  capital: CapitalSnapshot;
  costBasisUsd: number;
  deployTimestamp: number;
  flows: VaultFlow[];
  priceChart0: PriceChartPoint[];
  priceChart1: PriceChartPoint[];
  pnlTimeSeries: PnlTimePoint[];
  twrResult: TwrResult | null;
}

/**
 * Computes P&L attribution using on-chain vault events and DeFiLlama prices.
 *
 * Single effect handles both:
 * 1. Building historical cache (vault flows, price charts, TWR) — once per pool
 * 2. Computing current P&L (fetches current prices) — on every state/swaps change
 *
 * Current P&L runs immediately with a zero-capital placeholder if the historical
 * cache isn't ready yet, so USD values appear as soon as pool state loads.
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
    if (!state) return;
    let cancelled = false;

    async function compute() {
      try {
        // 1. Build historical cache if swaps are ready and cache is empty
        if (!swapsLoading && !cacheRef.current) {
          setLoading(true);
          const client = getClient();
          const swapTxHashes = new Set(swaps.map(s => s.transactionHash));

          // Fetch independent data in parallel: vault flows, deploy block timestamp, current block
          const [currentBlock, deployTimestamp] = await Promise.all([
            client.getBlockNumber(),
            client.getBlock({ blockNumber: pool.deployBlock }).then(b => Number(b.timestamp)),
          ]);

          // Vault flows need currentBlock; price charts need deployTimestamp — both now available
          const [flows, priceChart0, priceChart1] = await Promise.all([
            fetchVaultFlows(
              client, pool, state!.supplyVault0, state!.supplyVault1,
              pool.eulerAccount, swapTxHashes, pool.deployBlock, currentBlock,
            ),
            fetchPriceChart(state!.asset0 as Address, deployTimestamp),
            fetchPriceChart(state!.asset1 as Address, deployTimestamp),
          ]);

          const capital = buildCapitalSnapshot(
            flows, state!.asset0Decimals, state!.asset1Decimals,
          );

          const timeSeries = buildPnlTimeSeries(
            swaps, priceChart0, priceChart1,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          // Fetch flow block timestamps for TWR (only if flows exist)
          const flowBlockNums = flows.map(f => f.blockNumber);
          if (flowBlockNums.length > 0) {
            const timestamps = await fetchBlockTimestamps(client, flowBlockNums);
            for (const f of flows) {
              f.timestamp = timestamps.get(f.blockNumber);
            }
          }

          const costBasisUsd = computeCostBasis(
            flows, priceChart0, priceChart1,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          const twrRes = computeTwr(
            flows, swaps, priceChart0, priceChart1,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          cacheRef.current = {
            capital, costBasisUsd, deployTimestamp, flows, priceChart0, priceChart1,
            pnlTimeSeries: timeSeries, twrResult: twrRes,
          };

          if (!cancelled) {
            setPnlTimeSeries(timeSeries);
            setTwrResult(twrRes);
          }
        }

        // 2. Compute current P&L (uses cached capital or zero placeholder)
        if (cancelled) return;
        const capital = cacheRef.current?.capital ?? { netDeposit0: 0, netDeposit1: 0, flowCount: 0 };
        const costBasis = cacheRef.current?.costBasisUsd ?? 0;
        const deployTs = cacheRef.current?.deployTimestamp ?? 0;
        const poolAgeDays = deployTs > 0 ? (Date.now() / 1000 - deployTs) / 86400 : 0;
        const result = await computePnl(state!, swaps, capital, costBasis, poolAgeDays);
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
