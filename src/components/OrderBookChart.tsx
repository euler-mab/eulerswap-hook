"use client";

import { useMemo, useState } from "react";
import {
  Area, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Params, computeX0, computeY0, computeXb, computeYb,
  generateOrderBookPointsX, generateOrderBookPointsY,
  generateCollateralDebtPoints, generateCollateralDebtPointsY,
  computeZd,
  pXyx as pXyxFn, pYxy as pYxyFn,
  priceAtXb, priceAtYb,
  FX, FY,
} from "@/lib/math";
import Tex from "./Tex";

export type Numeraire = "raw" | "x" | "y";

interface Props {
  params: Params;
  /** Token symbol labels (e.g., "ETH", "USDC"). Default: "X", "Y" */
  labelX?: string;
  labelY?: string;
  /** Default numeraire mode. "y" normalises everything to Y units, etc. */
  defaultNumeraire?: Numeraire;
}

const AXIS = { stroke: "#444", tick: { fill: "#666", fontSize: 11 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#222" };
const TIP = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #333", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#999" },
  formatter: (val: number | undefined) => val?.toFixed(4) ?? "",
};

function Legend({ items }: { items: { color: string; label: React.ReactNode; key?: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-[11px] text-zinc-600">
      {items.map((it, i) => (
        <span key={it.key ?? i} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor: it.dashed ? "transparent" : it.color,
              border: it.dashed ? `1.5px dashed ${it.color}` : undefined,
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

type CurveTab = "depth" | "density" | "fingerprint";

export default function OrderBookChart({ params, labelX, labelY, defaultNumeraire = "raw" }: Props) {
  const [numeraire, setNumeraire] = useState<Numeraire>(defaultNumeraire);
  const [curveTab, setCurveTab] = useState<CurveTab>("depth");
  const symX = labelX ?? "X";
  const symY = labelY ?? "Y";

  const data = useMemo(() => {
    const { px, py, cx, cy, rx, ry } = params;
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    if (x0 <= 0 || y0 <= 0) return null;

    // Extend range beyond boundaries so charts show data past the orange lines
    const ext = 1.3;
    const xPts = generateOrderBookPointsX(x0, y0, cx, rx * ext, px, py);
    const yPts = generateOrderBookPointsY(x0, y0, cy, ry * ext, px, py);
    const pRatio = px / py; // equilibrium Y per X
    const hasDebt = params.xd > 0 || params.yd > 0 || computeZd(params) > 0;

    // --- Collateral / Debt / Health vs actual price ---
    const xb = computeXb(x0, rx, cx);
    const yb = computeYb(y0, ry, cy);
    const xCDPts = generateCollateralDebtPoints(params, 300, ext);
    const yCDPts = generateCollateralDebtPointsY(params, 300, ext);

    // Z asset prices: pzx = Z price in X units, pzy = Z price in Y units
    const pzx = params.pxz > 0 ? 1 / params.pxz : 0;
    const pzy = pzx * (px / py);

    // X side: price rises from pRatio toward upper boundary
    // navx is in X units; convert to numeraire
    const cdXData = xCDPts.map(pt => {
      const xVirtual = pt.x + xb;
      const pXyxVal = pXyxFn(xVirtual, cx, x0, px, py); // X per Y
      if (!isFinite(pXyxVal) || pXyxVal <= 0) return null;
      const priceYperX = 1 / pXyxVal; // Y per X (user-facing price)
      // Total values in Y units (including Z collateral and Z debt)
      const colY = (pt.cxx || 0) * priceYperX + (pt.cxy || 0) + params.zr * pzy;
      const debtY = (pt.dxx || 0) * priceYperX + (pt.dxy || 0) + (pt.dxz || 0) * pzy;
      // NAV: navx is in X units
      const navY = pt.navx != null ? pt.navx * priceYperX : undefined;
      return {
        price: priceYperX,
        logPrice: Math.log(priceYperX),
        collateral: numeraire === "x" ? colY / priceYperX : colY,
        debt: numeraire === "x" ? debtY / priceYperX : debtY,
        health: pt.hx,
        nav: numeraire === "x" ? pt.navx : navY,
      };
    }).filter(Boolean);

    // Y side: price drops from pRatio toward lower boundary
    // navy is in Y units; convert to numeraire
    const cdYData = yCDPts.map(pt => {
      const yVirtual = pt.x + yb;
      const pYxyVal = pYxyFn(yVirtual, cy, y0, px, py); // Y per X
      if (!isFinite(pYxyVal) || pYxyVal <= 0) return null;
      const priceYperX = pYxyVal;
      // Total values in Y units (including Z collateral and Z debt)
      const colY = (pt.cyx || 0) * priceYperX + (pt.cyy || 0) + params.zr * pzy;
      const debtY = (pt.dyx || 0) * priceYperX + (pt.dyy || 0) + (pt.dyz || 0) * pzy;
      // NAV: navy is in Y units
      const navX = pt.navy != null ? pt.navy / priceYperX : undefined;
      return {
        price: priceYperX,
        logPrice: Math.log(priceYperX),
        collateral: numeraire === "x" ? colY / priceYperX : colY,
        debt: numeraire === "x" ? debtY / priceYperX : debtY,
        health: pt.hy,
        nav: numeraire === "x" ? navX : pt.navy,
      };
    }).filter(Boolean);

    const logEq = Math.log(pRatio);

    // Boundary prices (Y per X) and their log values
    const pXb = priceAtXb(x0, rx, cx, px, py);  // upper boundary
    const pYb = priceAtYb(y0, ry, cy, px, py);  // lower boundary
    const logPXb = isFinite(pXb) && pXb > 0 ? Math.log(pXb) : null;
    const logPYb = isFinite(pYb) && pYb > 0 ? Math.log(pYb) : null;

    // Merge by logPrice, sorted ascending
    const cdData = [
      ...cdYData,
      ...cdXData,
    ].sort((a, b) => a!.logPrice - b!.logPrice);

    // Helper: price delta → log price (Y per X)
    // X side: price drops as x increases → priceYperX = pRatio / (1 + x)
    // Y side: price rises as y increases → priceYperX = pRatio * (1 + y)
    const xLogP = (d: number) => logEq - Math.log(1 + d);
    const yLogP = (d: number) => logEq + Math.log(1 + d);

    // --- Depth chart (reserve view) ---
    const bidMul = numeraire === "y" ? pRatio : 1;
    const askMul = numeraire === "x" ? 1 / pRatio : 1;
    const depthData = [
      ...xPts.map(p => ({
        logPrice: xLogP(p.priceDelta),
        bidDepth: Math.max(0, (x0 - p.cumSame)) * bidMul,
      })).reverse(),
      { logPrice: logEq, bidDepth: 0, askDepth: 0 },
      ...yPts.filter(p => p.priceDelta > 0).map(p => ({
        logPrice: yLogP(p.priceDelta),
        askDepth: Math.max(0, (y0 - p.cumSame)) * askMul,
      })),
    ];

    // --- Fingerprint ---
    const nFp = 200;
    const fpX = Array.from({ length: nFp }, (_, i) => {
      const d = rx * ext * ((i + 1) / nFp);
      const fx = FX(d, cx);
      return isFinite(fx) ? { logPrice: xLogP(d), fx } : null;
    }).filter(Boolean).reverse();
    const fpY = Array.from({ length: nFp }, (_, i) => {
      const d = ry * ext * ((i + 1) / nFp);
      const fy = FY(d, cy);
      return isFinite(fy) ? { logPrice: yLogP(d), fy } : null;
    }).filter(Boolean);
    const fpData = [
      ...fpX,
      { logPrice: logEq, fx: FX(0, cx), fy: FY(0, cy) },
      ...fpY,
    ];

    // --- Combined density ---
    const xToNum = numeraire === "y" ? pRatio : 1;
    const yToNum = numeraire === "x" ? 1 / pRatio : 1;
    const densData = [
      ...xPts.map(p => ({
        logPrice: xLogP(p.priceDelta),
        sameL: p.densSame * xToNum,
        crossL: p.densCross * yToNum,
      })).reverse(),
      ...yPts.map(p => ({
        logPrice: yLogP(p.priceDelta),
        sameR: p.densSame * yToNum,
        crossR: p.densCross * xToNum,
      })),
    ];

    // Shared domain across all charts: union of all data ranges
    const allLogPrices = [
      ...cdData.map(d => d!.logPrice),
      ...depthData.map(d => d.logPrice),
      ...densData.map(d => d.logPrice),
      ...fpData.map(d => d!.logPrice),
    ].filter(v => isFinite(v));
    const logDomain: [number, number] = [
      Math.min(...allLogPrices),
      Math.max(...allLogPrices),
    ];

    return { x0, y0, pRatio, logEq, logPXb, logPYb, pXb, pYb, logDomain, hasDebt, cdData, depthData, fpData, densData };
  }, [params, numeraire]);

  if (!data) return null;

  const depthUnit =
    numeraire === "y" ? symY
    : numeraire === "x" ? symX
    : "native";

  const numLabel = numeraire === "y" ? symY : numeraire === "x" ? symX : "";

  // Format log-price tick labels back to readable prices
  const fmtLogTick = (logP: number) => {
    const p = Math.exp(logP);
    if (p >= 1000) return `${(p / 1000).toFixed(1)}k`;
    if (p >= 1) return p.toFixed(0);
    if (p >= 0.01) return parseFloat(p.toFixed(4)).toString();
    return p.toExponential(1);
  };

  return (
    <div className="space-y-8">
      {/* Numeraire toggle — shared across all charts */}
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">
          Position analytics {numLabel && <span className="normal-case">({numLabel})</span>}
        </h2>
        <div className="flex gap-1">
          {(["raw", "x", "y"] as Numeraire[]).map((n) => (
            <button
              key={n}
              onClick={() => setNumeraire(n)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                numeraire === n
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-600 hover:text-zinc-400"
              }`}
            >
              {n === "raw" ? "Raw" : n === "x" ? symX : symY}
            </button>
          ))}
        </div>
      </div>

      {/* Collateral & Debt vs Price */}
      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Collateral &amp; debt vs price
        </h3>
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={data.cdData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
              <CartesianGrid {...GRID} />
              <XAxis
                dataKey="logPrice"
                type="number"
                domain={data.logDomain}
                {...AXIS}
                tickFormatter={fmtLogTick}
                label={{ value: `price (${symY} per ${symX})`, position: "bottom", fill: "#555", fontSize: 10 }}
              />
              <YAxis yAxisId="left" {...AXIS} />
              {data.hasDebt ? (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  width={40}
                  {...AXIS}
                  domain={[0, (dataMax: number) => Math.min(dataMax, 10)]}
                  tick={{ fill: "#a78bfa", fontSize: 11 }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                />
              ) : (
                <YAxis yAxisId="right" orientation="right" width={60} tick={false} axisLine={false} tickLine={false} />
              )}
              <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
              <ReferenceLine
                yAxisId="left"
                x={data.logEq}
                stroke="#555"
                strokeDasharray="6 3"
                label={{ value: "eq", position: "top", fill: "#666", fontSize: 10 }}
              />
              {data.logPXb != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPXb}
                  stroke="#f59e0b"
                  strokeDasharray="4 3"
                  label={{ value: `upper ${fmtLogTick(data.logPXb)}`, position: "insideTopLeft", fill: "#f59e0b", fontSize: 10 }}
                />
              )}
              {data.logPYb != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPYb}
                  stroke="#f59e0b"
                  strokeDasharray="4 3"
                  label={{ value: `lower ${fmtLogTick(data.logPYb)}`, position: "insideTopRight", fill: "#f59e0b", fontSize: 10 }}
                />
              )}
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="collateral"
                stroke="#34d399"
                fill="#34d399"
                fillOpacity={0.2}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                name="Collateral"
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="debt"
                stroke="#f87171"
                fill="#f87171"
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                name="Debt"
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="nav"
                stroke="#06b6d4"
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                name="NAV"
              />
              <ReferenceLine yAxisId="left" y={0} stroke="#444" strokeDasharray="3 3" />
              {data.hasDebt && (
                <>
                  <ReferenceLine
                    yAxisId="right"
                    y={1}
                    stroke="#ef4444"
                    strokeDasharray="6 3"
                    label={{ value: "H=1", position: "right", fill: "#ef4444", fontSize: 10 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="health"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    name="Health"
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <Legend items={[
            { color: "#34d399", label: <>Collateral{numLabel ? ` (${numLabel})` : ""}</>, key: "col" },
            { color: "#f87171", label: <>Debt{numLabel ? ` (${numLabel})` : ""}</>, key: "debt" },
            { color: "#06b6d4", label: <>NAV{numLabel ? ` (${numLabel})` : ""}</>, key: "nav" },
            ...(data.hasDebt ? [
              { color: "#a78bfa", label: <>Health (right axis)</>, key: "health" },
              { color: "#ef4444", label: <>H = 1 (liquidation)</>, key: "hliq", dashed: true },
            ] : []),
            { color: "#f59e0b", label: <>Price boundaries</>, key: "bounds", dashed: true },
          ]} />
          {!data.hasDebt && (
            <p className="text-[10px] text-zinc-600 mt-1 px-1">
              No debt — enable leverage to see health curve.
            </p>
          )}
        </div>
      </section>

      {/* AMM curve views — tabbed */}
      <section>
        <div className="flex items-baseline gap-4 mb-3">
          <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">AMM curve</h3>
          <div className="flex gap-1">
            {([
              ["depth", "Depth"],
              ["density", "Density"],
              ["fingerprint", "Fingerprint"],
            ] as [CurveTab, string][]).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setCurveTab(tab)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  curveTab === tab
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          {curveTab === "depth" && (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.depthData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis
                    dataKey="logPrice"
                    type="number"
                    domain={data.logDomain}
                    {...AXIS}
                    tickFormatter={fmtLogTick}
                    label={{ value: `price (${symY} per ${symX})`, position: "bottom", fill: "#555", fontSize: 10 }}
                  />
                  <YAxis yAxisId="left" {...AXIS} />
                  <YAxis yAxisId="right" orientation="right" width={60} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine
                    yAxisId="left"
                    x={data.logEq}
                    stroke="#555"
                    strokeDasharray="6 3"
                    label={{ value: "eq", position: "top", fill: "#666", fontSize: 10 }}
                  />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  <Area yAxisId="left" type="monotone" dataKey="bidDepth" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} strokeWidth={1.5} dot={false} connectNulls={false} />
                  <Area yAxisId="left" type="monotone" dataKey="askDepth" stroke="#fb923c" fill="#fb923c" fillOpacity={0.25} strokeWidth={1.5} dot={false} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <>{symX} depth (bid){numeraire === "y" ? ` in ${symY}` : ""}</>, key: "bid" },
                { color: "#fb923c", label: <>{symY} depth (ask){numeraire === "x" ? ` in ${symX}` : ""}</>, key: "ask" },
                { color: "#f59e0b", label: <>Price boundaries</>, key: "bounds", dashed: true },
              ]} />
            </>
          )}

          {curveTab === "density" && (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.densData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="logPrice" type="number" domain={data.logDomain} {...AXIS} tickFormatter={fmtLogTick} label={{ value: `price (${symY} per ${symX})`, position: "bottom", fill: "#555", fontSize: 10 }} />
                  <YAxis yAxisId="left" {...AXIS} />
                  <YAxis yAxisId="right" orientation="right" width={60} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine yAxisId="left" x={data.logEq} stroke="#555" strokeDasharray="6 3" label={{ value: "eq", position: "top", fill: "#666", fontSize: 10 }} />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  <Line yAxisId="left" type="monotone" dataKey="sameL" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="l_XX" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="sameR" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="l_YY" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="crossL" stroke="#6366f1" strokeWidth={1.5} dot={false} name="l_XY" strokeDasharray="4 2" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="crossR" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="l_YX" strokeDasharray="4 2" connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <><Tex>{"\\ell_{XX}"}</Tex> — {symX} in (price ↓)</>, key: "lxx" },
                { color: "#a78bfa", label: <><Tex>{"\\ell_{YY}"}</Tex> — {symY} in (price ↑)</>, key: "lyy" },
                { color: "#6366f1", label: <><Tex>{"\\ell_{XY}"}</Tex> — {symY} out (price ↓)</>, key: "lxy", dashed: true },
                { color: "#8b5cf6", label: <><Tex>{"\\ell_{YX}"}</Tex> — {symX} out (price ↑)</>, key: "lyx", dashed: true },
              ]} />
            </>
          )}

          {curveTab === "fingerprint" && (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.fpData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis
                    type="number"
                    dataKey="logPrice"
                    domain={data.logDomain}
                    {...AXIS}
                    tickFormatter={fmtLogTick}
                    label={{ value: `price (${symY} per ${symX})`, position: "bottom", fill: "#555", fontSize: 10 }}
                  />
                  <YAxis yAxisId="left" type="number" {...AXIS} domain={[0, "auto"]} />
                  <YAxis yAxisId="right" orientation="right" width={60} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine yAxisId="left" x={data.logEq} stroke="#555" strokeDasharray="6 3" label={{ value: "eq", position: "top", fill: "#666", fontSize: 10 }} />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  <ReferenceLine yAxisId="left" y={1} stroke="#555" strokeDasharray="6 3" label={{ value: "xy=k", position: "right", fill: "#666", fontSize: 10 }} />
                  <Line yAxisId="left" type="monotone" dataKey="fx" stroke="#3b82f6" strokeWidth={1.5} dot={false} name={`F_${symX}`} connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="fy" stroke="#a78bfa" strokeWidth={1.5} dot={false} name={`F_${symY}`} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <><Tex>{`F_{${symX}}`}</Tex> — {symX} fingerprint (price ↓)</>, key: "fx" },
                { color: "#a78bfa", label: <><Tex>{`F_{${symY}}`}</Tex> — {symY} fingerprint (price ↑)</>, key: "fy" },
                { color: "#555", label: <>xy = k baseline</>, key: "xyk" },
              ]} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
