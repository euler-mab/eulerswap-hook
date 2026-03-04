"use client";

import { useMemo } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot,
} from "recharts";
import {
  Params, computeX0, computeY0, computeXb, computeYb,
  computeSx, computeSy, computeBxc, computeByc,
  generateFXPoints, generateFYPoints,
  generateShiftedFXPoints, generateShiftedGYPoints,
  fX, gY, priceAtXb, priceAtYb,
} from "@/lib/math";
import Tex from "./Tex";

interface Props {
  params: Params;
  labelX?: string;
  labelY?: string;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
  formatter: (val: number | undefined) => val?.toFixed(2) ?? "",
};
const line = (color: string) => ({ stroke: color, strokeWidth: 1.5 });

function Legend({ items }: { items: { color: string; label: React.ReactNode; key?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-[11px] text-zinc-600">
      {items.map((it, i) => (
        <span key={it.key ?? i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export default function CurveChart({ params, labelX, labelY }: Props) {
  const symX = labelX ?? "X";
  const symY = labelY ?? "Y";
  const data = useMemo(() => {
    const { px, py, cx, cy, rx, ry, xr, yr } = params;
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    const xbB = computeXb(x0, rx, cx);
    const ybB = computeYb(y0, ry, cy);
    const xbR = computeXb(xr, rx, cx);
    const ybR = computeYb(yr, ry, cy);

    // Boosted reserve curves
    const fxBoosted = generateFXPoints(x0, y0, px, py, cx);
    const fyBoosted = generateFYPoints(x0, y0, px, py, cy);

    // Real reserve curves
    const fxReal = generateFXPoints(xr, yr, px, py, cx);
    const fyReal = generateFYPoints(xr, yr, px, py, cy);

    // Shifted curves (boosted)
    const sfxBoosted = generateShiftedFXPoints(x0, y0, px, py, cx, cy, rx, ry);
    const sgyBoosted = generateShiftedGYPoints(x0, y0, px, py, cx, cy, rx, ry);

    // Shifted curves (real)
    const sfxReal = generateShiftedFXPoints(xr, yr, px, py, cx, cy, rx, ry);
    const sgyReal = generateShiftedGYPoints(xr, yr, px, py, cx, cy, rx, ry);

    // Key points
    const boostedEq = { x: x0, y: y0 };
    const realEq = { x: xr, y: yr };
    const xbBoostedPt = { x: xbB, y: fX(xbB, cx, x0, y0, px, py) };
    const ybBoostedPt = { x: gY(ybB, cy, y0, x0, px, py), y: ybB };
    const shiftedBoostedEq = { x: x0 - xbB, y: y0 - ybB };
    const shiftedRealEq = { x: xr - xbR, y: yr - ybR };

    // Boundary prices
    const pXb = priceAtXb(x0, rx, cx, px, py);
    const pYb = priceAtYb(y0, ry, cy, px, py);

    // Boost breakdown
    const sx = computeSx(rx, cx);
    const sy = computeSy(ry, cy);
    const bXC = computeBxc(sx);
    const bYC = computeByc(sy);
    const bXL = xr > 0 ? x0 / (xr * bXC) : 0;
    const bYL = yr > 0 ? y0 / (yr * bYC) : 0;

    return {
      x0, y0, xbB, ybB, xbR, ybR,
      fxBoosted, fyBoosted, fxReal, fyReal,
      sfxBoosted, sgyBoosted, sfxReal, sgyReal,
      boostedEq, realEq, xbBoostedPt, ybBoostedPt,
      shiftedBoostedEq, shiftedRealEq,
      pXb, pYb, bXC, bYC, bXL, bYL,
    };
  }, [params]);

  const fmt = (n: number) => {
    if (Math.abs(n) >= 1000) return n.toFixed(1);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
  };

  return (
    <div className="space-y-8">
      {/* Boosted reserve curves */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">AMM curves — boosted reserves</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name={symX} {...AXIS} />
              <YAxis type="number" dataKey="y" name={symY} width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.fxBoosted} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.fyBoosted} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              {data.boostedEq.x > 0 && (
                <ReferenceDot x={data.boostedEq.x} y={data.boostedEq.y} r={4} fill="#34d399" stroke="none" />
              )}
              {!isNaN(data.xbBoostedPt.y) && (
                <ReferenceDot x={data.xbBoostedPt.x} y={data.xbBoostedPt.y} r={3} fill="#fbbf24" stroke="none" />
              )}
              {!isNaN(data.ybBoostedPt.x) && (
                <ReferenceDot x={data.ybBoostedPt.x} y={data.ybBoostedPt.y} r={3} fill="#fb923c" stroke="none" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#6366f1", label: <><Tex>{"f_X"}</Tex>{" (x \u2264 x\u2080)"}</> },
            { color: "#a78bfa", label: <><Tex>{"g_Y"}</Tex>{" (x \u2265 x\u2080)"}</> },
            { color: "#34d399", label: <>(x\u2080, y\u2080)</> },
            { color: "#fbbf24", label: <><Tex>{"x_b"}</Tex></> },
            { color: "#fb923c", label: <><Tex>{"y_b"}</Tex></> },
          ]} />
        </div>
      </section>

      {/* Real reserve curves */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">AMM curves — real reserves</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name={symX} {...AXIS} />
              <YAxis type="number" dataKey="y" name={symY} width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.fxReal} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.fyReal} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              <ReferenceDot x={data.realEq.x} y={data.realEq.y} r={4} fill="#34d399" stroke="none" />
            </ScatterChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#6366f1", label: <><Tex>{"f_X"}</Tex>{" (x \u2264 x\u1d63)"}</> },
            { color: "#a78bfa", label: <><Tex>{"g_Y"}</Tex>{" (x \u2265 x\u1d63)"}</> },
            { color: "#34d399", label: <>(x\u1d63, y\u1d63)</> },
          ]} />
        </div>
      </section>

      {/* Shifted curves */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Shifted curves — boosted</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name={symX} {...AXIS} />
              <YAxis type="number" dataKey="y" name={symY} width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.sfxBoosted} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.sgyBoosted} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              {data.shiftedBoostedEq.x > 0 && data.shiftedBoostedEq.y > 0 && (
                <ReferenceDot x={data.shiftedBoostedEq.x} y={data.shiftedBoostedEq.y} r={4} fill="#34d399" stroke="none" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#6366f1", label: <><Tex>{"f_X"}</Tex> shifted</> },
            { color: "#a78bfa", label: <><Tex>{"g_Y"}</Tex> shifted</> },
            { color: "#34d399", label: <>boosted range</> },
          ]} />
        </div>
      </section>

      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Shifted curves — real</h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis type="number" dataKey="x" name={symX} {...AXIS} />
              <YAxis type="number" dataKey="y" name={symY} width={50} {...AXIS} />
              <Tooltip {...TIP} />
              <Scatter data={data.sfxReal} fill="#6366f1" line={line("#6366f1")} shape={() => null} />
              <Scatter data={data.sgyReal} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} />
              {data.shiftedRealEq.x > 0 && data.shiftedRealEq.y > 0 && (
                <ReferenceDot x={data.shiftedRealEq.x} y={data.shiftedRealEq.y} r={4} fill="#34d399" stroke="none" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#6366f1", label: <><Tex>{"f_X"}</Tex> shifted</> },
            { color: "#a78bfa", label: <><Tex>{"g_Y"}</Tex> shifted</> },
            { color: "#34d399", label: <>real range</> },
          ]} />
        </div>
      </section>

      {/* Computed values */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">Computed values</h2>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 text-xs text-zinc-400">
          <span className="text-zinc-600">Boost</span>
          <span />
          <span><Tex>{"b_{XC}"}</Tex> = {fmt(data.bXC)}</span>
          <span><Tex>{"b_{YC}"}</Tex> = {fmt(data.bYC)}</span>
          <span><Tex>{"b_{XL}"}</Tex> = {fmt(data.bXL)}</span>
          <span><Tex>{"b_{YL}"}</Tex> = {fmt(data.bYL)}</span>
          <span className="text-zinc-600 mt-1">Boosted reserves</span>
          <span />
          <span><Tex>x_0</Tex> = {fmt(data.x0)}</span>
          <span><Tex>y_0</Tex> = {fmt(data.y0)}</span>
          <span><Tex>{"x_b(x_0)"}</Tex> = {fmt(data.xbB)}</span>
          <span><Tex>{"y_b(y_0)"}</Tex> = {fmt(data.ybB)}</span>
          <span>range = ({fmt(data.x0 - data.xbB)}, {fmt(data.y0 - data.ybB)})</span>
          <span />
          <span className="text-zinc-600 mt-1">Real reserves</span>
          <span />
          <span><Tex>x_r</Tex> = {fmt(params.xr)}</span>
          <span><Tex>y_r</Tex> = {fmt(params.yr)}</span>
          <span><Tex>{"x_b(x_r)"}</Tex> = {fmt(data.xbR)}</span>
          <span><Tex>{"y_b(y_r)"}</Tex> = {fmt(data.ybR)}</span>
          <span>range = ({fmt(params.xr - data.xbR)}, {fmt(params.yr - data.ybR)})</span>
          <span />
          <span className="text-zinc-600 mt-1">Boundary prices</span>
          <span />
          <span><Tex>{"p_{Xb}"}</Tex> = {fmt(data.pXb)}</span>
          <span><Tex>{"p_{Yb}"}</Tex> = {fmt(data.pYb)}</span>
        </div>
      </section>
    </div>
  );
}
