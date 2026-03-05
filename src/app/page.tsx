"use client";

import { useState, useMemo, useCallback } from "react";
import { defaultParams, Params, validateParams } from "@/lib/math";
import { AssetLabels, defaultLabels } from "@/lib/labels";
import ParamControls from "@/components/ParamControls";
import AssetNameInputs from "@/components/AssetNameInputs";
import CurveChart from "@/components/CurveChart";
import HealthChart from "@/components/HealthChart";
import OrderBookChart from "@/components/OrderBookChart";
import SimChart from "@/components/SimChart";
import ComparisonChart from "@/components/ComparisonChart";

type ChartTab = "orderbook" | "health" | "curve" | "simulate" | "compare";

export default function Home() {
  const [params, setParams] = useState<Params>(defaultParams);
  const [labels, setLabels] = useState<AssetLabels>(defaultLabels);
  const [chartTab, setChartTab] = useState<ChartTab>("orderbook");
  const warnings = useMemo(() => validateParams(params), [params]);

  const applyPreset = useCallback((newLabels: AssetLabels, patch: Partial<Params>) => {
    setLabels(newLabels);
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);

  return (
    <div className="min-h-screen flex">
      {/* Left panel — parameters */}
      <aside className="w-[540px] shrink-0 h-screen sticky top-0 overflow-y-auto border-r border-gray-200 bg-white px-6 pt-8 pb-12 space-y-8">
        <AssetNameInputs labels={labels} onChange={setLabels} onApplyPreset={applyPreset} />
        <ParamControls params={params} onChange={setParams} labels={labels} />

        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}
      </aside>

      {/* Right panel — charts */}
      <main className="flex-1 min-w-0 max-w-4xl px-8 py-8 space-y-6">
        <div className="flex gap-1">
          {([
            ["orderbook", "Order Book"],
            ["health", "Health"],
            ["curve", "Curve"],
            ["simulate", "Simulate"],
            ["compare", "Yield Basis"],
          ] as [ChartTab, string][]).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setChartTab(tab)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                chartTab === tab
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {chartTab === "orderbook" && <OrderBookChart params={params} labelX={labels.x} labelY={labels.y} labelZ={labels.z} labelNum={labels.num} />}
        {chartTab === "health" && <HealthChart params={params} labelX={labels.x} labelY={labels.y} />}
        {chartTab === "curve" && <CurveChart params={params} labelX={labels.x} labelY={labels.y} />}
        {chartTab === "simulate" && <SimChart params={params} labels={labels} />}
        {chartTab === "compare" && <ComparisonChart params={params} labels={labels} />}
      </main>
    </div>
  );
}
