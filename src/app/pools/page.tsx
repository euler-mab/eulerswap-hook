"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { POOLS } from "@/lib/pools/config";
import PoolList from "@/components/pools/PoolList";
import PoolDetail from "@/components/pools/PoolDetail";

function PoolsContent() {
  const params = useSearchParams();
  const selectedAddr = params.get("pool");

  const pool = selectedAddr
    ? POOLS.find((p) => p.address.toLowerCase() === selectedAddr.toLowerCase())
    : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <header className="flex items-baseline justify-between mb-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pool Monitor</h1>
            <p className="text-sm text-zinc-500 mt-0.5">
              {pool ? pool.name : "Live EulerSwap pool dashboard"}
            </p>
          </div>
          <div className="flex gap-3">
            {pool && (
              <Link href="/pools" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
                &larr; All Pools
              </Link>
            )}
            <Link href="/" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
              Explorer
            </Link>
          </div>
        </header>

        {/* Content */}
        {pool ? (
          <PoolDetail pool={pool} />
        ) : selectedAddr ? (
          <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-xs text-red-400">
            Pool not found: {selectedAddr}
          </div>
        ) : (
          <PoolList />
        )}
      </div>
    </div>
  );
}

export default function PoolsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <PoolsContent />
    </Suspense>
  );
}
