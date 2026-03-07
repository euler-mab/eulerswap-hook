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

  const fetchData = useCallback(async () => {
    setLoading(true);
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

  // Manual refresh: fetch immediately and reset the polling timer
  const refresh = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchData, POLL_INTERVAL);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    refresh();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  return { state, loading, error, refresh };
}

/** Fetches historical swap events. Supports manual refresh. */
export function useSwapHistory(pool: PoolConfig) {
  const [swaps, setSwaps] = useState<SwapEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const refresh = useCallback(async () => {
    cancelRef.current = false;
    setLoading(true);
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

      if (!cancelRef.current) {
        setSwaps(swapEvents);
        setError(null);
      }
    } catch (e) {
      if (!cancelRef.current) setError(e instanceof Error ? e.message : "Failed to fetch swap history");
    } finally {
      if (!cancelRef.current) setLoading(false);
    }
  }, [pool]);

  useEffect(() => {
    refresh();
    return () => { cancelRef.current = true; };
  }, [refresh]);

  return { swaps, loading, error, refresh };
}
