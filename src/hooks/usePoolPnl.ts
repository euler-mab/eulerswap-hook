"use client";

import { useState, useEffect } from "react";
import { getClient } from "@/lib/pools/client";
import { computePnl, type PnlAttribution } from "@/lib/pools/pnl";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent } from "@/lib/pools/types";

/**
 * Computes P&L attribution using DeFiLlama historical prices.
 * Fetches deploy-time and current USD prices, then attributes returns.
 *
 * Only runs when both state and swaps are available (swaps loading is complete).
 * Re-runs when state updates (every 30s poll) to reflect latest NAV.
 */
export function usePoolPnl(
  pool: PoolConfig,
  state: PoolState | null,
  swaps: SwapEvent[],
  swapsLoading: boolean,
) {
  const [pnl, setPnl] = useState<PnlAttribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state || swapsLoading) return;
    if (pool.initialDeposit0 === undefined && pool.initialDeposit1 === undefined) return;

    let cancelled = false;

    async function compute() {
      setLoading(true);
      try {
        // Get deploy block timestamp
        const client = getClient();
        const block = await client.getBlock({ blockNumber: pool.deployBlock });
        const deployTimestamp = Number(block.timestamp);

        const result = await computePnl(pool, state!, swaps, deployTimestamp);
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

  return { pnl, loading, error };
}
