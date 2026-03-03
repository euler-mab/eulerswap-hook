"use client";

import { useState, useMemo } from "react";
import { defaultParams, Params, validateParams } from "@/lib/math";
import ParamControls from "@/components/ParamControls";
import CurveChart from "@/components/CurveChart";
import HealthChart from "@/components/HealthChart";
import OrderBookChart from "@/components/OrderBookChart";

export default function Home() {
  const [params, setParams] = useState<Params>(defaultParams);
  const warnings = useMemo(() => validateParams(params), [params]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">EulerSwap</h1>
          <p className="text-sm text-zinc-500 mt-0.5">AMM curve explorer</p>
        </header>

        <ParamControls params={params} onChange={setParams} />

        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-300 space-y-1">
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}

        <CurveChart params={params} />

        <hr className="border-zinc-800" />

        <HealthChart params={params} />

        <hr className="border-zinc-800" />

        <OrderBookChart params={params} />
      </div>
    </div>
  );
}
