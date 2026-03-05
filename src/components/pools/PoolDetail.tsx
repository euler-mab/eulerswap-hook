"use client";

import { useMemo } from "react";
import type { PoolConfig } from "@/lib/pools/config";
import { usePoolState, useSwapHistory } from "@/hooks/usePoolData";
import { swapsToPricePoints } from "@/lib/pools/format";
import SectionCard from "@/components/create/SectionCard";
import PoolOverview from "./PoolOverview";
import PoolCharts from "./PoolCharts";
import SwapTable from "./SwapTable";
import StrategyPanel from "./StrategyPanel";

export default function PoolDetail({ pool }: { pool: PoolConfig }) {
  const { state, loading: stateLoading, error: stateError, refresh } = usePoolState(pool);
  const { swaps, loading: historyLoading } = useSwapHistory(pool);

  const pricePoints = useMemo(() => {
    if (!state || swaps.length === 0) return [];
    return swapsToPricePoints(swaps, state.asset0Decimals, state.asset1Decimals);
  }, [swaps, state]);

  if (stateLoading && !state) {
    return <div className="text-zinc-600 animate-pulse text-sm">Loading pool state...</div>;
  }

  if (stateError && !state) {
    return (
      <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-xs text-red-400">
        {stateError}
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex items-center gap-3 text-[10px] text-zinc-600">
        <span>Block #{state.blockNumber.toString()}</span>
        <span>Updated {new Date(state.fetchedAt).toLocaleTimeString()}</span>
        <button onClick={refresh} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer">
          Refresh
        </button>
        {stateLoading && <span className="animate-pulse">updating...</span>}
      </div>

      {/* Overview */}
      <SectionCard title="Overview" defaultOpen>
        <PoolOverview state={state} pool={pool} />
      </SectionCard>

      {/* Charts */}
      {(pricePoints.length > 0 || historyLoading) && (
        <SectionCard title="Charts" defaultOpen>
          {historyLoading ? (
            <div className="text-xs text-zinc-600 animate-pulse">Loading swap history...</div>
          ) : (
            <PoolCharts pricePoints={pricePoints} state={state} />
          )}
        </SectionCard>
      )}

      {/* Trade Activity */}
      <SectionCard title="Recent Trades" defaultOpen badge={swaps.length > 0 ? `${swaps.length}` : undefined}>
        {historyLoading ? (
          <div className="text-xs text-zinc-600 animate-pulse">Loading...</div>
        ) : swaps.length === 0 ? (
          <div className="text-xs text-zinc-600">No swaps found since block {pool.deployBlock.toString()}</div>
        ) : (
          <SwapTable
            swaps={swaps}
            asset0Decimals={state.asset0Decimals}
            asset1Decimals={state.asset1Decimals}
            asset0Symbol={state.asset0Symbol}
            asset1Symbol={state.asset1Symbol}
          />
        )}
      </SectionCard>

      {/* Strategy */}
      <SectionCard title="Strategy" defaultOpen={false}>
        <StrategyPanel state={state} />
      </SectionCard>
    </div>
  );
}
