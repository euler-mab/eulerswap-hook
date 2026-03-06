"use client";

import { useState, useEffect, useRef } from "react";
import { getClient } from "@/lib/pools/client";
import { fetchDeploySnapshot, computePnl, type PnlAttribution, type DeploySnapshot } from "@/lib/pools/pnl";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent } from "@/lib/pools/types";

/**
 * Computes P&L attribution using DeFiLlama historical prices.
 *
 * Deploy-time data (block timestamp, prices, initial NAV) is fetched once and cached.
 * Only current prices are re-fetched when state updates (every 30s poll).
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
  const deployRef = useRef<DeploySnapshot | null>(null);
  const poolAddrRef = useRef<string>("");

  // Reset cache when pool changes
  if (pool.address !== poolAddrRef.current) {
    deployRef.current = null;
    poolAddrRef.current = pool.address;
  }

  useEffect(() => {
    if (!state || swapsLoading) return;
    if (pool.initialDeposit0 === undefined && pool.initialDeposit1 === undefined) return;

    let cancelled = false;

    async function compute() {
      setLoading(true);
      try {
        // Fetch deploy snapshot once (immutable)
        if (!deployRef.current) {
          const client = getClient();
          const block = await client.getBlock({ blockNumber: pool.deployBlock });
          deployRef.current = await fetchDeploySnapshot(pool, state!, Number(block.timestamp));
        }

        const result = await computePnl(state!, swaps, deployRef.current);
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
