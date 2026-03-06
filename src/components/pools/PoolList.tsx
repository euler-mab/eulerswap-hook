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
      className="block rounded-lg border border-gray-200 bg-white shadow-sm p-6 hover:border-gray-400 transition-colors"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{pool.name}</h3>
        {state && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
            active
          </span>
        )}
      </div>

      {pool.description && (
        <p className="text-xs text-gray-400 mb-3">{pool.description}</p>
      )}

      {loading ? (
        <div className="text-sm text-gray-400 animate-pulse">Loading...</div>
      ) : error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : state ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-gray-500">
          <span>Reserves</span>
          <span className="text-gray-700">
            {fmtAmount(state.reserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
            {fmtAmount(state.reserve1, state.asset1Decimals)} {state.asset1Symbol}
          </span>
          <span>Price</span>
          <span className="text-gray-700">
            {state.marginalPrice.toFixed(2)} {state.asset1Symbol}/{state.asset0Symbol}
          </span>
          <span>Fees</span>
          <span className="text-gray-700">
            {fmtFeeBps(state.fee0)} / {fmtFeeBps(state.fee1)}
          </span>
          <span>Pool</span>
          <span className="text-gray-500 font-mono text-xs">{shortAddr(pool.address)}</span>
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
