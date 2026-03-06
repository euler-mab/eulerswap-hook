"use client";

import { useState, useEffect, useRef } from "react";
import { getClient } from "@/lib/pools/client";
import { fetchVaultFlows } from "@/lib/pools/reads";
import { buildCapitalSnapshot, computePnl, type PnlAttribution, type CapitalSnapshot } from "@/lib/pools/pnl";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent } from "@/lib/pools/types";

/**
 * Computes P&L attribution using on-chain vault events and DeFiLlama prices.
 *
 * Capital flows (deposits/withdrawals) are scanned once from vault events and cached.
 * Swap-induced vault events are filtered out using swap transaction hashes.
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
  const capitalRef = useRef<CapitalSnapshot | null>(null);
  const poolAddrRef = useRef<string>("");

  // Reset cache when pool changes
  if (pool.address !== poolAddrRef.current) {
    capitalRef.current = null;
    poolAddrRef.current = pool.address;
  }

  useEffect(() => {
    if (!state || swapsLoading) return;

    let cancelled = false;

    async function compute() {
      setLoading(true);
      try {
        // Build capital snapshot once from vault events (immutable history)
        if (!capitalRef.current) {
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

          capitalRef.current = buildCapitalSnapshot(
            flows,
            state!.asset0Decimals,
            state!.asset1Decimals,
          );
        }

        const result = await computePnl(state!, swaps, capitalRef.current);
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
