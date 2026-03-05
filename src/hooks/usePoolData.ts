"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getClient } from "@/lib/pools/client";
import { fetchPoolState, fetchSwapEvents, fetchBlockTimestamps } from "@/lib/pools/reads";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState, SwapEvent } from "@/lib/pools/types";

const POLL_INTERVAL = 30_000;

/** Auto-polling hook for current pool state. Refreshes every 30s. */
export function usePoolState(pool: PoolConfig) {
  const [state, setState] = useState<PoolState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const client = getClient();
      const data = await fetchPoolState(client, pool);
      setState(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch pool state");
    } finally {
      setLoading(false);
    }
  }, [pool]);

  useEffect(() => {
    setLoading(true);
    refresh();
    intervalRef.current = setInterval(refresh, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  return { state, loading, error, refresh };
}

/** Fetches historical swap events once on mount. Not auto-polling. */
export function useSwapHistory(pool: PoolConfig) {
  const [swaps, setSwaps] = useState<SwapEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const client = getClient();
        const currentBlock = await client.getBlockNumber();
        const swapEvents = await fetchSwapEvents(
          client, pool.address, pool.deployBlock, currentBlock,
        );

        // Fetch block timestamps (deduplicated)
        if (swapEvents.length > 0) {
          const blockNums = swapEvents.map(e => e.blockNumber);
          const timestamps = await fetchBlockTimestamps(client, blockNums);
          for (const s of swapEvents) {
            s.timestamp = timestamps.get(s.blockNumber);
          }
        }

        if (!cancelled) {
          setSwaps(swapEvents);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to fetch swap history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [pool]);

  return { swaps, loading, error };
}
