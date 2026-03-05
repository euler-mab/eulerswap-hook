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
    <div className="min-h-screen">
      <div className="max-w-6xl mx-auto px-8 py-8">
        {/* Sub-header for detail view */}
        {pool && (
          <div className="flex items-baseline justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{pool.name}</h2>
              {pool.description && <p className="text-sm text-gray-500 mt-0.5">{pool.description}</p>}
            </div>
            <Link href="/pools" className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
              &larr; All Pools
            </Link>
          </div>
        )}

        {/* Content */}
        {pool ? (
          <PoolDetail pool={pool} />
        ) : selectedAddr ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <PoolsContent />
    </Suspense>
  );
}
