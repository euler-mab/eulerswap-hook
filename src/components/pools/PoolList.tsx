"use client";

import Link from "next/link";
import { POOLS, type PoolConfig } from "@/lib/pools/config";
import { usePoolState } from "@/hooks/usePoolData";
import { fmtAmount, fmtFeeBps, shortAddr } from "@/lib/pools/format";

function PoolCard({ pool }: { pool: PoolConfig }) {
  const { state, loading, error } = usePoolState(pool);

  return (
    <Link
      href={`/pools?pool=${pool.address}`}
      className="block rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-5 hover:border-zinc-700 transition-colors"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{pool.name}</h3>
        {state && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            state.hookPaused ? "bg-red-900/40 text-red-400" : "bg-emerald-900/40 text-emerald-400"
          }`}>
            {state.hookPaused ? "paused" : "active"}
          </span>
        )}
      </div>

      {pool.description && (
        <p className="text-[11px] text-zinc-600 mb-3">{pool.description}</p>
      )}

      {loading ? (
        <div className="text-xs text-zinc-600 animate-pulse">Loading...</div>
      ) : error ? (
        <div className="text-xs text-red-400">{error}</div>
      ) : state ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-zinc-400">
          <span>Reserves</span>
          <span className="text-zinc-300">
            {fmtAmount(state.reserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
            {fmtAmount(state.reserve1, state.asset1Decimals)} {state.asset1Symbol}
          </span>
          <span>Price</span>
          <span className="text-zinc-300">
            {state.marginalPrice.toFixed(2)} {state.asset1Symbol}/{state.asset0Symbol}
          </span>
          <span>Fees</span>
          <span className="text-zinc-300">
            {fmtFeeBps(state.fee0)} / {fmtFeeBps(state.fee1)}
          </span>
          <span>Pool</span>
          <span className="text-zinc-500 font-mono text-[10px]">{shortAddr(pool.address)}</span>
        </div>
      ) : null}
    </Link>
  );
}

export default function PoolList() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {POOLS.map((pool) => (
        <PoolCard key={pool.address} pool={pool} />
      ))}
    </div>
  );
}
