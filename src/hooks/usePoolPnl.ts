"use client";

import { useState, useEffect, useRef } from "react";
import { formatUnits } from "viem";
import { getClient } from "@/lib/pools/client";
import { fetchVaultFlows, fetchBlockTimestamps, fetchUniswapPriceAtBlocks } from "@/lib/pools/reads";
import {
  buildCapitalSnapshot, computePnl, computeCostBasis, buildPnlTimeSeries, computeTwr,
  computeVaultInterest,
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
  nonSwapFlows: VaultFlow[];
  allVaultEvents: VaultFlow[];
  blockPrices: Map<bigint, number>;
  pnlTimeSeries: PnlTimePoint[];
  twrResult: TwrResult | null;
}

/**
 * Computes P&L attribution using on-chain vault events and per-block Uniswap prices.
 *
 * Single effect handles both:
 * 1. Building historical cache (vault flows, block prices, TWR) — once per pool
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

          // Fetch deploy timestamp and current block
          const [currentBlock, deployTimestamp] = await Promise.all([
            client.getBlockNumber(),
            client.getBlock({ blockNumber: pool.deployBlock }).then(b => Number(b.timestamp)),
          ]);

          // Fetch ALL vault events (for interest calc) and non-swap events (for capital/rebal)
          const allVaultEvents = await fetchVaultFlows(
            client, pool, state!.supplyVault0, state!.supplyVault1,
            pool.eulerAccount, undefined, // no swap filter → get ALL events
            pool.deployBlock, currentBlock,
          );
          const nonSwapFlows = allVaultEvents.filter(
            ev => !swapTxHashes.has(ev.transactionHash),
          );

          const capital = buildCapitalSnapshot(
            nonSwapFlows, state!.asset0Decimals, state!.asset1Decimals,
          );

          // Collect all unique block numbers for Uniswap price lookups
          const blockNums = new Set<bigint>();
          for (const s of swaps) blockNums.add(s.blockNumber);
          for (const f of nonSwapFlows) blockNums.add(f.blockNumber);

          // Fetch per-block Uniswap prices + flow timestamps in parallel
          const flowBlockNums = nonSwapFlows.map(f => f.blockNumber);
          const [blockPrices, timestamps] = await Promise.all([
            pool.uniswapPool
              ? fetchUniswapPriceAtBlocks(
                  client, pool.uniswapPool as Address, [...blockNums],
                  state!.asset0Decimals, state!.asset1Decimals,
                )
              : Promise.resolve(new Map<bigint, number>()),
            flowBlockNums.length > 0
              ? fetchBlockTimestamps(client, flowBlockNums)
              : Promise.resolve(new Map<bigint, number>()),
          ]);

          // Attach timestamps to flows (needed for TWR duration calc)
          for (const f of nonSwapFlows) {
            f.timestamp = timestamps.get(f.blockNumber);
          }

          const costBasisUsd = computeCostBasis(
            nonSwapFlows, blockPrices,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          const timeSeries = buildPnlTimeSeries(
            swaps, blockPrices,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          const twrRes = computeTwr(
            nonSwapFlows, swaps, blockPrices,
            state!.asset0Decimals, state!.asset1Decimals,
          );

          cacheRef.current = {
            capital, costBasisUsd, deployTimestamp, nonSwapFlows, allVaultEvents,
            blockPrices, pnlTimeSeries: timeSeries, twrResult: twrRes,
          };

          if (!cancelled) {
            setPnlTimeSeries(timeSeries);
            setTwrResult(twrRes);
          }
        }

        // 2. Compute current P&L (uses cached data or zero placeholders)
        if (cancelled) return;
        const capital = cacheRef.current?.capital ?? { extCap0: 0, extCap1: 0, extRebal0: 0, extRebal1: 0, capitalFlowCount: 0, rebalFlowCount: 0 };
        const costBasis = cacheRef.current?.costBasisUsd ?? 0;
        const deployTs = cacheRef.current?.deployTimestamp ?? 0;
        const poolAgeDays = deployTs > 0 ? (Date.now() / 1000 - deployTs) / 86400 : 0;
        const blockPrices = cacheRef.current?.blockPrices ?? new Map<bigint, number>();
        const nonSwapFlows = cacheRef.current?.nonSwapFlows ?? [];
        const allVaultEvents = cacheRef.current?.allVaultEvents ?? [];

        // Compute exact vault interest per asset
        const dep0 = Number(formatUnits(state!.vaultDeposit0, state!.asset0Decimals));
        const dep1 = Number(formatUnits(state!.vaultDeposit1, state!.asset1Decimals));
        const dbt0 = Number(formatUnits(state!.vaultDebt0, state!.asset0Decimals));
        const dbt1 = Number(formatUnits(state!.vaultDebt1, state!.asset1Decimals));
        const interest = computeVaultInterest(
          allVaultEvents, dep0, dep1, dbt0, dbt1,
          state!.asset0Decimals, state!.asset1Decimals,
        );

        const result = await computePnl(
          state!, swaps, capital, nonSwapFlows, blockPrices,
          interest, costBasis, poolAgeDays,
        );
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
