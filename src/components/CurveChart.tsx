"use client";

import { useMemo } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot,
} from "recharts";
import {
  Params, computeX0, computeY0, computeXb, computeYb,
  generateF1Points, generateF2Points,
  generateShiftedF1Points, generateShiftedG1Points,
  f1, g1,
} from "@/lib/math";

interface Props {
  params: Params;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
  formatter: (val: number) => val.toFixed(2),
};
const line = (color: string) => ({ stroke: color, strokeWidth: 1.5 });

export default function CurveChart({ params }: Props) {
  const { px, py, cx, cy, rx, ry } = params;

  const data = useMemo(() => {
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    const xb = computeXb(x0, rx, cx);
    const yb = computeYb(y0, ry, cy);

    const f1Pts = generateF1Points(x0, y0, px, py, cx);
    const f2Pts = generateF2Points(x0, y0, px, py, cy);
    const sf1Pts = generateShiftedF1Points(x0, y0, px, py, cx, cy, rx, ry);
    const sg1Pts = generateShiftedG1Points(x0, y0, px, py, cx, cy, rx, ry);

    const equilibrium = { x: x0, y: y0 };
    const xbPoint = { x: xb, y: f1(xb, x0, y0, px, py, cx) };
    const ybVal = computeYb(y0, ry, cy);
    const ybPoint = { x: g1(ybVal, x0, y0, px, py, cy), y: ybVal };
    const shiftedEq = { x: x0 - xb, y: y0 - yb };

    return { x0, y0, xb, yb, f1Pts, f2Pts, sf1Pts, sg1Pts, equilibrium, xbPoint, ybPoint, shiftedEq };
  }, [params, px, py, cx, cy, rx, ry]);

  const fmt = (n: number) => {
    if (Math.abs(n) >= 1000) return n.toFixed(1);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
  };

  return (
    <div className="space-y-8">
      {/* Virtual reserve space */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">AMM curves — virtual reserves</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name="x" {...AXIS} />
              <YAxis type="number" dataKey="y" name="y" {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.f1Pts} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.f2Pts} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              {data.equilibrium.x > 0 && (
                <ReferenceDot x={data.equilibrium.x} y={data.equilibrium.y} r={4} fill="#34d399" stroke="none" />
              )}
              {!isNaN(data.xbPoint.y) && (
                <ReferenceDot x={data.xbPoint.x} y={data.xbPoint.y} r={3} fill="#fbbf24" stroke="none" />
              )}
              {!isNaN(data.ybPoint.x) && (
                <ReferenceDot x={data.ybPoint.x} y={data.ybPoint.y} r={3} fill="#fb923c" stroke="none" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex gap-5 px-2 pt-1 text-[11px] text-zinc-600">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#6366f1]" />f1 (x &le; x0)</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#a78bfa]" />f2 (x &ge; x0)</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#34d399]" />(x0, y0)</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#fbbf24]" />xb</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#fb923c]" />yb</span>
          </div>
        </div>
      </section>

      {/* Shifted / real reserve space */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Shifted curves — real reserves</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name="x" {...AXIS} />
              <YAxis type="number" dataKey="y" name="y" {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.sf1Pts} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.sg1Pts} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              {data.shiftedEq.x > 0 && data.shiftedEq.y > 0 && (
                <ReferenceDot x={data.shiftedEq.x} y={data.shiftedEq.y} r={4} fill="#34d399" stroke="none" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex gap-5 px-2 pt-1 text-[11px] text-zinc-600">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#6366f1]" />fs1</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#a78bfa]" />gs1</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#34d399]" />equilibrium</span>
          </div>
        </div>
      </section>

      {/* Computed values */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Computed values</h2>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 font-mono text-xs text-zinc-400">
          <span>x0 = {fmt(data.x0)}</span>
          <span>y0 = {fmt(data.y0)}</span>
          <span>xb = {fmt(data.xb)}</span>
          <span>yb = {fmt(data.yb)}</span>
          <span>x0 - xb = {fmt(data.x0 - data.xb)}</span>
          <span>y0 - yb = {fmt(data.y0 - data.yb)}</span>
        </div>
      </section>
    </div>
  );
}
