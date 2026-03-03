"use client";

import { useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Params, computeX0, computeY0,
  generateOrderBookPointsX, generateOrderBookPointsY,
  FX, FY,
} from "@/lib/math";

interface Props {
  params: Params;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
  formatter: (val: number | undefined) => val?.toFixed(4) ?? "",
};
const line = (color: string) => ({ stroke: color, strokeWidth: 1.5 });

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

export default function OrderBookChart({ params }: Props) {
  const { px, py, cx, cy, rx, ry } = params;

  const data = useMemo(() => {
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    if (x0 <= 0 || y0 <= 0) return null;

    const xPts = generateOrderBookPointsX(x0, y0, cx, rx, px, py);
    const yPts = generateOrderBookPointsY(x0, y0, cy, ry, px, py);

    // Depth chart: mirrored around equilibrium
    // Left (negative price delta) = X side: cumulative X consumed
    // Right (positive price delta) = Y side: cumulative Y consumed
    const depthData = [
      ...xPts.map(p => ({
        price: -p.priceDelta,
        bidDepth: x0 - p.cumSame,
      })).reverse(),
      { price: 0, bidDepth: 0, askDepth: 0 },
      ...yPts.filter(p => p.priceDelta > 0).map(p => ({
        price: p.priceDelta,
        askDepth: y0 - p.cumSame,
      })),
    ];

    // Fingerprint: generate unified grid over max(rx, ry) with both FX and FY
    const maxRange = Math.max(rx, ry);
    const nFp = 200;
    const fpData = Array.from({ length: nFp + 1 }, (_, i) => {
      const d = maxRange * (i / nFp);
      const fx = d <= rx ? FX(d, cx) : undefined;
      const fy = d <= ry ? FY(d, cy) : undefined;
      if (fx === undefined && fy === undefined) return null;
      return { priceDelta: d, fx: fx && isFinite(fx) ? fx : undefined, fy: fy && isFinite(fy) ? fy : undefined };
    }).filter(Boolean);

    return { x0, y0, xPts, yPts, depthData, fpData };
  }, [params]);

  if (!data) return null;

  return (
    <div className="space-y-8">
      {/* Depth chart (hero) */}
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Order book — depth
        </h2>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <AreaChart data={data.depthData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis
                dataKey="price"
                type="number"
                {...AXIS}
                label={{ value: "price delta from equilibrium", position: "bottom", fill: "#555", fontSize: 10 }}
              />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} />
              <ReferenceLine
                x={0}
                stroke="#555"
                strokeDasharray="6 3"
                label={{ value: "eq", position: "top", fill: "#666", fontSize: 10 }}
              />
              <Area
                type="monotone"
                dataKey="bidDepth"
                stroke="#3b82f6"
                fill="#3b82f6"
                fillOpacity={0.25}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
              />
              <Area
                type="monotone"
                dataKey="askDepth"
                stroke="#fb923c"
                fill="#fb923c"
                fillOpacity={0.25}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: "X depth (bid side)" },
            { color: "#fb923c", label: "Y depth (ask side)" },
          ]} />
        </div>
      </section>

      {/* Density — X side */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Liquidity density — X side
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.xPts} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="priceDelta" type="number" {...AXIS} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="densSame" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="l_XX" />
              <Line type="monotone" dataKey="densCross" stroke="#6366f1" strokeWidth={1.5} dot={false} name="l_XY" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: "l_XX — X per unit price" },
            { color: "#6366f1", label: "l_XY — Y per unit price" },
          ]} />
        </div>
      </section>

      {/* Density — Y side */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Liquidity density — Y side
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.yPts} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="priceDelta" type="number" {...AXIS} />
              <YAxis {...AXIS} />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="densSame" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="l_YY" />
              <Line type="monotone" dataKey="densCross" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="l_YX" />
            </LineChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#a78bfa", label: "l_YY — Y per unit price" },
            { color: "#8b5cf6", label: "l_YX — X per unit price" },
          ]} />
        </div>
      </section>

      {/* Fingerprint */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Liquidity fingerprint (vs xy=k)
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={260}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis
                type="number"
                dataKey="priceDelta"
                name="price delta"
                {...AXIS}
              />
              <YAxis type="number" {...AXIS} domain={[0, "auto"]} />
              <Tooltip {...TIP} />
              <ReferenceLine
                y={1}
                stroke="#555"
                strokeDasharray="6 3"
                label={{ value: "xy=k", position: "right", fill: "#666", fontSize: 10 }}
              />
              <Scatter data={data.fpData} fill="#3b82f6" line={line("#3b82f6")} shape={() => null} dataKey="fx" name="F_X" />
              <Scatter data={data.fpData} fill="#a78bfa" line={line("#a78bfa")} shape={() => null} dataKey="fy" name="F_Y" />
            </ScatterChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#3b82f6", label: "F_X — X fingerprint" },
            { color: "#a78bfa", label: "F_Y — Y fingerprint" },
            { color: "#555", label: "xy=k baseline" },
          ]} />
        </div>
      </section>
    </div>
  );
}
