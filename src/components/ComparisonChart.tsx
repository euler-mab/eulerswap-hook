"use client";

import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Params } from "@/lib/math";
import { AssetLabels } from "@/lib/labels";
import {
  ComparisonConfig, defaultComparisonConfig, runComparison, ComparisonStep,
} from "@/lib/yieldBasisSim";
import ParamSlider from "./ParamSlider";
import Tex from "./Tex";

interface Props {
  params: Params;
  labels: AssetLabels;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
};

function Legend({ items }: { items: { color: string; label: React.ReactNode; dash?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-[11px] text-zinc-600">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {it.dash ? (
            <span className="w-3 border-t-2 border-dashed" style={{ borderColor: it.color }} />
          ) : (
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
          )}
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

function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = (arr.length - 1) / (maxPts - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

function Controls({ config, onChange }: { config: ComparisonConfig; onChange: (c: ComparisonConfig) => void }) {
  const set = (key: keyof ComparisonConfig) => (v: number) => onChange({ ...config, [key]: v });
  return (
    <div className="space-y-1.5 pb-4 border-b border-zinc-800/40">
      <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">Yield Basis Comparison</h3>
      <div className="grid grid-cols-3 gap-x-4 gap-y-1">
        <ParamSlider label="\sigma" value={config.vol} min={0.05} max={3} step={0.01} onChange={set("vol")} suffix="ann." />
        <ParamSlider label="\mu" value={config.drift} min={-1} max={1} step={0.01} onChange={set("drift")} suffix="ann." />
        <ParamSlider label="T" value={config.durationDays} min={1} max={365} step={1} onChange={set("durationDays")} suffix="days" />
        <ParamSlider label="n" value={config.stepsPerDay} min={1} max={96} step={1} onChange={set("stepsPerDay")} suffix="/day" />
        <ParamSlider label="fee" value={config.feeBps} min={1} max={200} step={1} onChange={set("feeBps")} suffix="bps" />
        <ParamSlider label="r_{borrow}" value={config.borrowRateAnnual} min={0} max={0.5} step={0.005} onChange={set("borrowRateAnnual")} suffix="ann." />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
          <input
            type="checkbox"
            checked={config.dynamicFee}
            onChange={(e) => onChange({ ...config, dynamicFee: e.target.checked })}
            className="accent-emerald-500"
          />
          <span>Dynamic fee</span>
        </label>
        {config.dynamicFee && (
          <>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-zinc-600">max</span>
              <input
                type="number"
                value={config.feeMaxBps}
                onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) set("feeMaxBps")(v); }}
                className="w-14 bg-transparent border border-zinc-800 rounded px-1 py-0.5 text-xs font-mono text-zinc-300 text-right focus:outline-none focus:border-zinc-600"
              />
              <span className="text-[10px] text-zinc-600">bps</span>
            </div>
            <div className="flex items-center gap-1">
              <Tex>{`\\tau`}</Tex>
              <input
                type="number"
                value={config.feeDecaySeconds}
                onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) set("feeDecaySeconds")(v); }}
                className="w-14 bg-transparent border border-zinc-800 rounded px-1 py-0.5 text-xs font-mono text-zinc-300 text-right focus:outline-none focus:border-zinc-600"
              />
              <span className="text-[10px] text-zinc-600">sec</span>
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="w-10 text-zinc-500 shrink-0 flex items-center text-xs"><Tex>seed</Tex></span>
        <input
          type="number"
          value={config.seed}
          onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) set("seed")(v); }}
          className="w-16 bg-transparent border border-zinc-800 rounded px-1.5 py-0.5 text-xs font-mono text-zinc-300 text-right focus:outline-none focus:border-zinc-600"
        />
        <button
          onClick={() => set("seed")(Math.floor(Math.random() * 2 ** 31))}
          className="px-1.5 py-0.5 rounded text-[9px] text-zinc-600 hover:text-zinc-300 border border-zinc-800/40 hover:border-zinc-700 transition-colors"
        >
          reseed
        </button>
      </div>
    </div>
  );
}

// Colors
const C_HODL = "#71717a";       // zinc-500
const C_HODLX = "#a1a1aa";     // zinc-400 dashed
const C_STATIC = "#3b82f6";    // blue
const C_DISC = "#f59e0b";      // amber
const C_IDEAL = "#10b981";     // emerald
const C_PRICE = "#06b6d4";     // cyan

export default function ComparisonChart({ params, labels }: Props) {
  const [config, setConfig] = useState<ComparisonConfig>(defaultComparisonConfig);
  const symY = labels.y;

  const result = useMemo(() => runComparison(params, config), [params, config]);
  const { steps, summary } = result;
  const data = useMemo(() => downsample(steps, 2000), [steps]);

  return (
    <div className="space-y-6">
      <Controls config={config} onChange={setConfig} />

      {/* Explanation */}
      <div className="text-[11px] text-zinc-500 leading-relaxed border-l-2 border-zinc-800 pl-3">
        Compares three LP strategies on the same GBM price path.{" "}
        <strong className="text-zinc-400">Static</strong>: fixed EulerSwap curve (uses your params).{" "}
        <strong className="text-amber-400/70">Discrete</strong>: afterSwap hook re-centers with L=2 simple leverage.{" "}
        <strong className="text-emerald-400/70">Ideal (YB)</strong>: Yield Basis compounding leverage (IL=0).{" "}
        Releverage strategies use <Tex>c_x=0</Tex> and your <Tex>r_x</Tex> for concentration.
      </div>

      {/* Price */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Price ({symY}/{labels.x})
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="extPrice" stroke={C_PRICE} strokeWidth={1.5} dot={false} name="price" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Total Return (nav + fees - debt) */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Total Return ({symY})
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={60} {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="hodl" stroke={C_HODL} strokeWidth={1} strokeDasharray="6 3" dot={false} name="HODL (50/50)" />
              <Line type="monotone" dataKey="hodlX" stroke={C_HODLX} strokeWidth={1} strokeDasharray="3 3" dot={false} name="HODL (100% X)" />
              <Line type="monotone" dataKey="staticTotal" stroke={C_STATIC} strokeWidth={1.5} dot={false} name="Static LP" />
              <Line type="monotone" dataKey="discTotal" stroke={C_DISC} strokeWidth={1.5} dot={false} name="Discrete relev." />
              <Line type="monotone" dataKey="idealTotal" stroke={C_IDEAL} strokeWidth={1.5} dot={false} name="Ideal (YB)" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: C_HODL, label: "HODL (50/50)", dash: true },
            { color: C_HODLX, label: "HODL (100% X)", dash: true },
            { color: C_STATIC, label: "Static LP + fees" },
            { color: C_DISC, label: "Discrete relev." },
            { color: C_IDEAL, label: "Ideal (YB)" },
          ]} />
        </div>
      </section>

      {/* Equity (without fees) */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Equity (no fees) ({symY})
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={60} {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="hodlX" stroke={C_HODLX} strokeWidth={1} strokeDasharray="3 3" dot={false} name="HODL-X" />
              <Line type="monotone" dataKey="staticNav" stroke={C_STATIC} strokeWidth={1.5} dot={false} name="Static NAV" />
              <Line type="monotone" dataKey="discEquity" stroke={C_DISC} strokeWidth={1.5} dot={false} name="Discrete equity" />
              <Line type="monotone" dataKey="idealEquity" stroke={C_IDEAL} strokeWidth={1.5} dot={false} name="Ideal equity" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: C_HODLX, label: "HODL (100% X)", dash: true },
            { color: C_STATIC, label: "Static NAV" },
            { color: C_DISC, label: "Discrete equity" },
            { color: C_IDEAL, label: "Ideal equity = HODL-X" },
          ]} />
        </div>
      </section>

      {/* Fees & IL */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Fees &amp; IL ({symY})
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={60} {...AXIS} />
              <Tooltip {...TIP} />
              <ReferenceLine y={0} stroke="#555" strokeDasharray="6 3" />
              <Line type="monotone" dataKey="staticFees" stroke={C_STATIC} strokeWidth={1.5} dot={false} name="Static fees" />
              <Line type="monotone" dataKey="discFees" stroke={C_DISC} strokeWidth={1.5} dot={false} name="Discrete fees" />
              <Line type="monotone" dataKey="idealFees" stroke={C_IDEAL} strokeWidth={1.5} dot={false} name="Ideal fees" />
              <Line type="monotone" dataKey={(d: ComparisonStep) => d.staticNav - d.hodl} stroke="#f87171" strokeWidth={1} dot={false} name="Static IL" />
              <Line type="monotone" dataKey={(d: ComparisonStep) => d.discEquity - d.hodlX} stroke="#fbbf24" strokeWidth={1} strokeDasharray="4 2" dot={false} name="Disc. residual IL" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: C_STATIC, label: "Static fees" },
            { color: C_DISC, label: "Discrete fees" },
            { color: C_IDEAL, label: "Ideal fees" },
            { color: "#f87171", label: "Static IL" },
            { color: "#fbbf24", label: "Disc. residual IL", dash: true },
          ]} />
        </div>
      </section>

      {/* Debt cost (releverage only) */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Borrow Cost ({symY})
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="t" type="number" {...AXIS} label={{ value: "days", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis width={60} {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="discDebt" stroke={C_DISC} strokeWidth={1.5} dot={false} name="Discrete debt cost" />
              <Line type="monotone" dataKey="idealDebt" stroke={C_IDEAL} strokeWidth={1.5} dot={false} name="Ideal debt cost" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: C_DISC, label: "Discrete debt cost" },
            { color: C_IDEAL, label: "Ideal debt cost" },
          ]} />
        </div>
      </section>

      {/* Summary */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Summary</h3>
        <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-xs text-zinc-400">
          {/* Header */}
          <span />
          <span className="font-medium text-blue-400">Static</span>
          <span className="font-medium text-amber-400">Discrete</span>
          <span className="font-medium text-emerald-400">Ideal (YB)</span>

          <span>Net return</span>
          <span className={summary.staticReturn >= 0 ? "text-emerald-400" : "text-red-400"}>{fmtPct(summary.staticReturn)}</span>
          <span className={summary.discReturn >= 0 ? "text-emerald-400" : "text-red-400"}>{fmtPct(summary.discReturn)}</span>
          <span className={summary.idealReturn >= 0 ? "text-emerald-400" : "text-red-400"}>{fmtPct(summary.idealReturn)}</span>

          <span>Fees earned</span>
          <span>{fmtNum(summary.staticFees)} {symY}</span>
          <span>{fmtNum(summary.discFees)} {symY}</span>
          <span>{fmtNum(summary.idealFees)} {symY}</span>

          <span>IL</span>
          <span className="text-red-400">{fmtNum(summary.staticIL)} {symY}</span>
          <span className={Math.abs(summary.discIL) < 0.01 ? "text-zinc-500" : "text-red-400"}>{fmtNum(summary.discIL)} {symY}</span>
          <span className="text-zinc-500">{fmtNum(summary.idealIL)} {symY}</span>

          <span>Debt cost</span>
          <span className="text-zinc-600">n/a</span>
          <span>{fmtNum(summary.discDebtCost)} {symY}</span>
          <span>{fmtNum(summary.idealDebtCost)} {symY}</span>
        </div>

        <div className="mt-4 text-[10px] text-zinc-600 leading-relaxed">
          <strong>Static</strong>: IL = lpNav − HODL(50/50). <strong>Discrete/Ideal</strong>: IL = equity − HODL(100% X).
          Releverage converts 50/50 exposure to 100% X delta.
          Residual discrete IL ≈ σ²T/4 from simple leverage gap (2√r−1 vs r per step).
          {config.dynamicFee && (() => {
            const elapsed = 86400 / config.stepsPerDay;
            const tFrac = Math.min(elapsed / config.feeDecaySeconds, 1);
            const decay = Math.sqrt(Math.max(0, 1 - tFrac));
            const effFee = config.feeBps + (config.feeMaxBps - config.feeBps) * decay;
            return <> Dynamic fee: effective {effFee.toFixed(0)} bps (base {config.feeBps}, max {config.feeMaxBps}, {elapsed.toFixed(0)}s elapsed, τ={config.feeDecaySeconds}s).</>;
          })()}
        </div>
      </section>
    </div>
  );
}
