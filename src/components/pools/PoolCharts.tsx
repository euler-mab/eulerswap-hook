"use client";

import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import type { PricePoint } from "@/lib/pools/types";
import type { PoolState } from "@/lib/pools/types";
import { downsample } from "@/lib/pools/format";

const AXIS = { stroke: "#d1d5db", tick: { fill: "#6b7280", fontSize: 12 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#e5e7eb" };
const TIP = {
  contentStyle: { backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13 },
  labelStyle: { color: "#6b7280" },
};

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-xs text-gray-400">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

type ChartTab = "price" | "fees" | "reserves";

interface Props {
  pricePoints: PricePoint[];
  state: PoolState;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(4);
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function PoolCharts({ pricePoints, state }: Props) {
  const [tab, setTab] = useState<ChartTab>("price");

  const data = useMemo(() => downsample(pricePoints, 2000), [pricePoints]);

  if (data.length < 2) {
    return <div className="text-xs text-gray-400">Not enough data points for charts</div>;
  }

  const useTimestamp = data[0].timestamp > 0;
  const xKey = useTimestamp ? "timestamp" : "blockNumber";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xFormatter = useTimestamp ? (v: any) => fmtTime(v) : (v: any) => `#${v}`;

  const tabs: [ChartTab, string][] = [["price", "Price"], ["fees", "Fees"], ["reserves", "Reserves"]];

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer ${
              tab === key ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Price chart */}
      {tab === "price" && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
            Marginal Price ({state.asset1Symbol}/{state.asset0Symbol})
          </h3>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey={xKey} {...AXIS} tickFormatter={xFormatter} minTickGap={40} />
                <YAxis {...AXIS} tickFormatter={fmtNum} domain={["auto", "auto"]} />
                <Tooltip {...TIP} labelFormatter={xFormatter} formatter={(v: unknown) => [fmtNum(v as number), "Price"]} />
                <Line type="monotone" dataKey="price" stroke="#06b6d4" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
            <Legend items={[{ color: "#06b6d4", label: `Marginal price` }]} />
          </div>
        </section>
      )}

      {/* Fees chart */}
      {tab === "fees" && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
            Cumulative Fees
          </h3>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey={xKey} {...AXIS} tickFormatter={xFormatter} minTickGap={40} />
                <YAxis yAxisId="left" {...AXIS} tickFormatter={fmtNum} />
                <YAxis yAxisId="right" orientation="right" {...AXIS} tickFormatter={fmtNum} />
                <Tooltip {...TIP} labelFormatter={xFormatter} />
                <Line yAxisId="left" type="monotone" dataKey="cumulativeFee0" stroke="#34d399" dot={false} strokeWidth={1.5} name={`Fees (${state.asset0Symbol})`} />
                <Line yAxisId="right" type="monotone" dataKey="cumulativeFee1" stroke="#a78bfa" dot={false} strokeWidth={1.5} name={`Fees (${state.asset1Symbol})`} />
              </LineChart>
            </ResponsiveContainer>
            <Legend items={[
              { color: "#34d399", label: `Fees (${state.asset0Symbol})` },
              { color: "#a78bfa", label: `Fees (${state.asset1Symbol})` },
            ]} />
          </div>
        </section>
      )}

      {/* Reserves chart */}
      {tab === "reserves" && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
            Pool Reserves
          </h3>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey={xKey} {...AXIS} tickFormatter={xFormatter} minTickGap={40} />
                <YAxis yAxisId="left" {...AXIS} tickFormatter={fmtNum} />
                <YAxis yAxisId="right" orientation="right" {...AXIS} tickFormatter={fmtNum} />
                <Tooltip {...TIP} labelFormatter={xFormatter} />
                <Line yAxisId="left" type="monotone" dataKey="reserve0" stroke="#3b82f6" dot={false} strokeWidth={1.5} name={state.asset0Symbol} />
                <Line yAxisId="right" type="monotone" dataKey="reserve1" stroke="#a78bfa" dot={false} strokeWidth={1.5} name={state.asset1Symbol} />
              </LineChart>
            </ResponsiveContainer>
            <Legend items={[
              { color: "#3b82f6", label: state.asset0Symbol },
              { color: "#a78bfa", label: state.asset1Symbol },
            ]} />
          </div>
        </section>
      )}
    </div>
  );
}
