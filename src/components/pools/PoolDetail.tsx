"use client";

import { useMemo } from "react";
import type { PoolConfig } from "@/lib/pools/config";
import { usePoolState, useSwapHistory } from "@/hooks/usePoolData";
import { usePoolPnl } from "@/hooks/usePoolPnl";
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

  const { totalFee0, totalFee1 } = useMemo(() => {
    let f0 = 0n, f1 = 0n;
    for (const s of swaps) { f0 += s.fee0; f1 += s.fee1; }
    return { totalFee0: f0, totalFee1: f1 };
  }, [swaps]);

  const { pnl, error: pnlError } = usePoolPnl(pool, state, swaps, historyLoading);

  if (stateLoading && !state) {
    return <div className="text-gray-400 animate-pulse text-sm">Loading pool state...</div>;
  }

  if (stateError && !state) {
    return (
      <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-600">
        {stateError}
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span>Block #{state.blockNumber.toString()}</span>
        {state.blockTimestamp > 0 && (
          <span>{new Date(state.blockTimestamp * 1000).toLocaleString()}</span>
        )}
        <button onClick={refresh} className="text-gray-500 hover:text-gray-900 transition-colors cursor-pointer">
          Refresh
        </button>
        {stateLoading && <span className="animate-pulse">updating...</span>}
      </div>

      {/* Overview */}
      <SectionCard title="Overview" defaultOpen>
        <PoolOverview state={state} pool={pool} pnl={pnl} pnlError={pnlError} />
      </SectionCard>

      {/* Charts */}
      {(pricePoints.length > 0 || historyLoading) && (
        <SectionCard title="Charts" defaultOpen>
          {historyLoading ? (
            <div className="text-sm text-gray-400 animate-pulse">Loading swap history...</div>
          ) : (
            <PoolCharts pricePoints={pricePoints} state={state} />
          )}
        </SectionCard>
      )}

      {/* Trade Activity */}
      <SectionCard title="Recent Trades" defaultOpen badge={swaps.length > 0 ? `${swaps.length}` : undefined}>
        {historyLoading ? (
          <div className="text-sm text-gray-400 animate-pulse">Loading...</div>
        ) : swaps.length === 0 ? (
          <div className="text-sm text-gray-400">No swaps found since block {pool.deployBlock.toString()}</div>
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
