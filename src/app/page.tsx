"use client";

import { useState, useMemo } from "react";
import { defaultParams, Params, validateParams } from "@/lib/math";
import ParamControls from "@/components/ParamControls";
import CurveChart from "@/components/CurveChart";
import HealthChart from "@/components/HealthChart";
import OrderBookChart from "@/components/OrderBookChart";

type ChartTab = "orderbook" | "health" | "curve";

export default function Home() {
  const [params, setParams] = useState<Params>(defaultParams);
  const [chartTab, setChartTab] = useState<ChartTab>("orderbook");
  const warnings = useMemo(() => validateParams(params), [params]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      {/* Left panel — parameters */}
      <aside className="w-[540px] shrink-0 h-screen sticky top-0 overflow-y-auto border-r border-zinc-800/60 px-6 py-8 space-y-8">
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
      </aside>

      {/* Right panel — charts */}
      <main className="flex-1 min-w-0 px-6 py-8 space-y-6">
        <div className="flex gap-1">
          {([
            ["orderbook", "Order Book"],
            ["health", "Health"],
            ["curve", "Curve"],
          ] as [ChartTab, string][]).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setChartTab(tab)}
              className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
                chartTab === tab
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {chartTab === "orderbook" && <OrderBookChart params={params} />}
        {chartTab === "health" && <HealthChart params={params} />}
        {chartTab === "curve" && <CurveChart params={params} />}
      </main>
    </div>
  );
}
