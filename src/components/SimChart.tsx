"use client";

import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Params, computeZd } from "@/lib/math";
import { AssetLabels } from "@/lib/labels";
import { SimConfig, defaultSimConfig, runSimulation, SimStep } from "@/lib/simulate";
import ParamSlider from "./ParamSlider";
import Tex from "./Tex";

interface Props {
  params: Params;
  labels: AssetLabels;
}

const AXIS = { stroke: "#d1d5db", tick: { fill: "#6b7280", fontSize: 12 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#e5e7eb" };
const TIP = {
  contentStyle: { backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13 },
  labelStyle: { color: "#6b7280" },
};

function Legend({ items }: { items: { color: string; label: React.ReactNode; key?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-xs text-gray-400">
      {items.map((it, i) => (
        <span key={it.key ?? i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(4);
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

/** Downsample array to at most maxPts points, keeping first and last */
function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = (arr.length - 1) / (maxPts - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

function SimControls({ config, onChange }: { config: SimConfig; onChange: (c: SimConfig) => void }) {
  const set = (key: keyof SimConfig) => (v: number) => onChange({ ...config, [key]: v });
  return (
    <div className="space-y-1.5 pb-4 border-b border-gray-100">
      <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">Simulation</h3>
      <div className="grid grid-cols-3 gap-x-4 gap-y-1">
        <ParamSlider label="\sigma" value={config.vol} min={0.05} max={3} step={0.01} onChange={set("vol")} suffix="ann." />
        <ParamSlider label="\mu" value={config.drift} min={-1} max={1} step={0.01} onChange={set("drift")} suffix="ann." />
        <ParamSlider label="T" value={config.durationDays} min={1} max={365} step={1} onChange={set("durationDays")} suffix="days" />
        <ParamSlider label="n" value={config.stepsPerDay} min={1} max={96} step={1} onChange={set("stepsPerDay")} suffix="/day" />
        <ParamSlider label="fee" value={config.feeBps} min={1} max={200} step={1} onChange={set("feeBps")} suffix="bps" />
        <div className="flex items-center gap-2">
          <span className="w-10 text-gray-500 shrink-0 flex items-center text-xs"><Tex>seed</Tex></span>
          <input
            type="number"
            value={config.seed}
            onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) set("seed")(v); }}
            className="w-16 bg-transparent border border-gray-300 rounded px-1.5 py-0.5 text-xs font-mono text-gray-700 text-right focus:outline-none focus:border-gray-400"
          />
          <button
            onClick={() => set("seed")(Math.floor(Math.random() * 2 ** 31))}
            className="px-1.5 py-0.5 rounded text-xs text-gray-400 hover:text-gray-900 border border-gray-100 hover:border-gray-300 transition-colors"
          >
            reseed
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SimChart({ params, labels }: Props) {
  const [config, setConfig] = useState<SimConfig>(defaultSimConfig);
  const symX = labels.x;
  const symY = labels.y;

  const result = useMemo(() => runSimulation(params, config), [params, config]);
  const { steps, summary } = result;
  const hasDebt = params.xd > 0 || params.yd > 0 || computeZd(params) > 0;

  // Downsample for Recharts perf
  const data = useMemo(() => downsample(steps, 2000), [steps]);

  const eqPrice = params.px / params.py;

  return (
    <div className="space-y-6">
      <SimControls config={config} onChange={setConfig} />

      {/* Price */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
          Price ({symY}/{symX})
        </h3>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <ReferenceLine y={eqPrice} stroke="#555" strokeDasharray="6 3" />
              <Line type="monotone" dataKey="extPrice" stroke="#06b6d4" strokeWidth={1.5} dot={false} name="external price" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#06b6d4", label: <>external price</> },
            { color: "#555", label: <>equilibrium</> },
          ]} />
        </div>
      </section>

      {/* NAV */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
          NAV ({symY})
        </h3>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="hodlNav" stroke="#71717a" strokeWidth={1} strokeDasharray="6 3" dot={false} name="HODL" />
              <Line type="monotone" dataKey="lpNav" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="LP (no fees)" />
              <Line
                type="monotone"
                dataKey={(d: SimStep) => d.lpNav + d.feesCum}
                stroke="#34d399"
                strokeWidth={1.5}
                dot={false}
                name="LP + fees"
              />
              {summary.liquidated && summary.liquidationDay !== null && (
                <ReferenceLine x={summary.liquidationDay} stroke="#ef4444" strokeDasharray="4 2" label={{ value: "liquidated", fill: "#ef4444", fontSize: 9 }} />
              )}
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#71717a", label: <>HODL</> },
            { color: "#3b82f6", label: <>LP (no fees)</> },
            { color: "#34d399", label: <>LP + fees</> },
          ]} />
        </div>
      </section>

      {/* Fees & IL */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
          Fees &amp; IL ({symY})
        </h3>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <ReferenceLine y={0} stroke="#555" strokeDasharray="6 3" />
              <Line type="monotone" dataKey="feesCum" stroke="#34d399" strokeWidth={1.5} dot={false} name="cumulative fees" />
              <Line type="monotone" dataKey={(d: SimStep) => d.lpNav - d.hodlNav} stroke="#f87171" strokeWidth={1.5} dot={false} name="IL" />
              <Line type="monotone" dataKey="netPnl" stroke="#06b6d4" strokeWidth={1.5} dot={false} name="net P&L" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#34d399", label: <>cumulative fees</> },
            { color: "#f87171", label: <>impermanent loss</> },
            { color: "#06b6d4", label: <>net P&L (fees + IL)</> },
          ]} />
        </div>
      </section>

      {/* Reserves */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
          Reserves
        </h3>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis yAxisId="left" width={50} {...AXIS} />
              <YAxis yAxisId="right" orientation="right" width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Line yAxisId="left" type="monotone" dataKey="realX" stroke="#3b82f6" strokeWidth={1.5} dot={false} name={`real ${symX}`} />
              <Line yAxisId="right" type="monotone" dataKey="realY" stroke="#a78bfa" strokeWidth={1.5} dot={false} name={`real ${symY}`} />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: <>{symX} (left axis)</> },
            { color: "#a78bfa", label: <>{symY} (right axis)</> },
          ]} />
        </div>
      </section>

      {/* Health (only with debt) */}
      {hasDebt && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">Health score</h3>
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
                <YAxis width={50} {...AXIS} domain={[0, "auto"]} />
                <Tooltip {...TIP} />
                <ReferenceLine y={1} stroke="#ef4444" strokeDasharray="6 3" label={{ value: "H=1", position: "right", fill: "#ef4444", fontSize: 10 }} />
                <Line type="monotone" dataKey="health" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="health" />
              </LineChart>
            </ResponsiveContainer>
            <Legend items={[
              { color: "#a78bfa", label: <>health score</> },
              { color: "#ef4444", label: <>liquidation threshold</> },
            ]} />
          </div>
        </section>
      )}

      {/* Summary stats */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">Summary</h3>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 text-xs text-gray-500">
          <span>Net return</span>
          <span className={summary.netReturn >= 0 ? "text-emerald-400" : "text-red-400"}>{fmtPct(summary.netReturn)}</span>
          <span>Total fees earned</span>
          <span>{fmtNum(summary.totalFees)} {symY}</span>
          <span>Impermanent loss</span>
          <span className="text-red-400">{fmtNum(summary.totalIL)} {symY}</span>
          <span>Max drawdown</span>
          <span>{fmtPct(summary.maxDrawdown)}</span>
          <span>Time in range</span>
          <span>{fmtPct(summary.timeInRange)}</span>
          <span>Liquidated</span>
          <span className={summary.liquidated ? "text-red-400" : "text-emerald-400"}>
            {summary.liquidated ? `Yes (day ${summary.liquidationDay?.toFixed(1)})` : "No"}
          </span>
        </div>
      </section>
    </div>
  );
}
