"use client";

import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Params, generateCollateralDebtPoints, generateCollateralDebtPointsY } from "@/lib/math";

interface Props {
  params: Params;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
};

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-[11px] text-zinc-600">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function NoDebtHint() {
  return <p className="text-xs text-zinc-600 mt-2 px-2">Set x_d or y_d &gt; 0 to see debt and health curves.</p>;
}

export default function HealthChart({ params }: Props) {
  const xPoints = useMemo(() => generateCollateralDebtPoints(params), [params]);
  const yPoints = useMemo(() => generateCollateralDebtPointsY(params), [params]);

  const hasDebt = params.xd > 0 || params.yd > 0;

  return (
    <div className="space-y-8">
      {/* --- X SIDE --- */}
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">X side — price moves down</h2>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Collateral (X side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={xPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <Line type="monotone" dataKey="cxx" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="CXX" />
              <Line type="monotone" dataKey="cyx" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="CYX" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: "CXX — X collateral" },
            { color: "#8b5cf6", label: "CYX — Y collateral" },
          ]} />
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Debt (X side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={xPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <Line type="monotone" dataKey="dxx" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="DXX" connectNulls={false} />
              <Line type="monotone" dataKey="dyx" stroke="#ef4444" strokeWidth={1.5} dot={false} name="DYX" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#f59e0b", label: "DXX — X debt" },
            { color: "#ef4444", label: "DYX — Y debt" },
          ]} />
          {!hasDebt && <NoDebtHint />}
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Health score (X side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={xPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} />
              <YAxis {...AXIS} domain={[0, "auto"]} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <ReferenceLine y={1} stroke="#555" strokeDasharray="6 3" label={{ value: "H=1", position: "right", fill: "#666", fontSize: 10 }} />
              <Line type="monotone" dataKey="hx" stroke="#34d399" strokeWidth={1.5} dot={false} name="HX" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#34d399", label: "HX — health score" },
            { color: "#555", label: "H = 1 (liquidation)" },
          ]} />
          {!hasDebt && <NoDebtHint />}
        </div>
      </section>

      {/* --- Y SIDE --- */}
      <hr className="border-zinc-800" />
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Y side — price moves up</h2>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Collateral (Y side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={yPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} label={{ value: "y (shifted)", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <Line type="monotone" dataKey="cyy" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="CYY" />
              <Line type="monotone" dataKey="cxy" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="CXY" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: "CYY — Y collateral" },
            { color: "#8b5cf6", label: "CXY — X collateral" },
          ]} />
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Debt (Y side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={yPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} label={{ value: "y (shifted)", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <Line type="monotone" dataKey="dyy" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="DYY" connectNulls={false} />
              <Line type="monotone" dataKey="dxy" stroke="#ef4444" strokeWidth={1.5} dot={false} name="DXY" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#f59e0b", label: "DYY — Y debt" },
            { color: "#ef4444", label: "DXY — X debt" },
          ]} />
          {!hasDebt && <NoDebtHint />}
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Health score (Y side)</h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={yPoints} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="x" type="number" {...AXIS} label={{ value: "y (shifted)", position: "bottom", fill: "#555", fontSize: 10 }} />
              <YAxis {...AXIS} domain={[0, "auto"]} />
              <Tooltip {...TIP} formatter={(val: number) => val.toFixed(4)} />
              <ReferenceLine y={1} stroke="#555" strokeDasharray="6 3" label={{ value: "H=1", position: "right", fill: "#666", fontSize: 10 }} />
              <Line type="monotone" dataKey="hy" stroke="#34d399" strokeWidth={1.5} dot={false} name="HY" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#34d399", label: "HY — health score" },
            { color: "#555", label: "H = 1 (liquidation)" },
          ]} />
          {!hasDebt && <NoDebtHint />}
        </div>
      </section>
    </div>
  );
}
