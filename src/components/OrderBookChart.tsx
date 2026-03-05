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

/**
 * Numeraire modes for order book charts.
 * - "raw": native units (X for ask side, Y for bid side) — no conversion
 * - "x": everything converted to X units using AMM marginal price
 * - "y": everything converted to Y units using AMM marginal price
 * - "ext": everything converted to external numeraire (e.g. USD) using oracle prices px, py, pz
 *
 * Conversion uses `toNum(xAmt, yAmt, zAmt)` which applies the appropriate
 * price depending on mode. For "raw"/"y" modes, X↔Y conversion uses the
 * *AMM marginal price at that point* (not oracle), giving an accurate
 * picture of what the position is worth at each price level.
 * For "ext" mode, oracle prices (px, py, pz) are used directly.
 */
export type Numeraire = "raw" | "x" | "y" | "ext";

interface Props {
  params: Params;
  /** Token symbol labels (e.g., "ETH", "USDC"). Default: "X", "Y" */
  labelX?: string;
  labelY?: string;
  labelZ?: string;
  /** Name of external numeraire (e.g., "USD"). Default: "USD" */
  labelNum?: string;
  /** Default numeraire mode. "y" normalises everything to Y units, etc. */
  defaultNumeraire?: Numeraire;
}

const AXIS = { stroke: "#d1d5db", tick: { fill: "#6b7280", fontSize: 12 }, tickLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#e5e7eb" };
const TIP = {
  contentStyle: { backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13 },
  labelStyle: { color: "#6b7280" },
  formatter: (val: number | undefined) => val?.toFixed(4) ?? "",
};

function Legend({ items }: { items: { color: string; label: React.ReactNode; key?: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-4 px-2 pt-1 text-xs text-gray-400">
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

interface CDTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Record<string, number> }>;
  symX: string;
  symY: string;
  symZ: string;
}

function CDTooltip({ active, payload, symX, symY, symZ }: CDTooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const fmt = (v: number | undefined) => v != null ? v.toFixed(4) : "—";
  const hasZ = (d.colZ ?? 0) > 0 || (d.debtZ ?? 0) > 0;
  return (
    <div style={{ backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, padding: "8px 12px" }}>
      <div style={{ color: "#6b7280", marginBottom: 4 }}>price: {d.price?.toFixed(2)}</div>
      <div style={{ color: "#34d399" }}>Collateral: {fmt(d.collateral)}</div>
      <div style={{ color: "#9ca3af", fontSize: 12, paddingLeft: 8 }}>
        {symX}: {fmt(d.colX)} · {symY}: {fmt(d.colY)}{hasZ && <> · {symZ}: {fmt(d.colZ)}</>}
      </div>
      <div style={{ color: "#f87171" }}>Debt: {fmt(d.debt)}</div>
      {((d.debtX ?? 0) > 0 || (d.debtY ?? 0) > 0 || (d.debtZ ?? 0) > 0) && (
        <div style={{ color: "#9ca3af", fontSize: 12, paddingLeft: 8 }}>
          {symX}: {fmt(d.debtX)} · {symY}: {fmt(d.debtY)}{hasZ && <> · {symZ}: {fmt(d.debtZ)}</>}
        </div>
      )}
      {d.health != null && <div style={{ color: "#a78bfa" }}>Health: {fmt(d.health)}</div>}
      {d.nav != null && <div style={{ color: "#06b6d4" }}>NAV: {fmt(d.nav)}</div>}
    </div>
  );
}

export default function OrderBookChart({ params, labelX, labelY, labelZ, labelNum, defaultNumeraire = "raw" }: Props) {
  const [numeraire, setNumeraire] = useState<Numeraire>(defaultNumeraire);
  const [curveTab, setCurveTab] = useState<CurveTab>("depth");
  const symX = labelX ?? "X";
  const symY = labelY ?? "Y";
  const symZ = labelZ ?? "Z";
  const symNum = labelNum ?? "USD";

  // Compute all chart datasets: collateral/debt, depth, density, fingerprint.
  // X-axis uses log(marginal price) for uniform spacing across price range.
  // Each dataset converts values to the selected numeraire via toNum().
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
    const zd = computeZd(params);
    const xCDPts = generateCollateralDebtPoints(params, 300, ext);
    const yCDPts = generateCollateralDebtPointsY(params, 300, ext);

    // Z asset prices: pzx = Z price in X units, pzy = Z price in Y units
    const pzx = params.pxz > 0 ? 1 / params.pxz : 0;
    const pzy = pzx * (px / py);
    // Z price in external numeraire: pxz = Z/X, so pz_num = px / pxz
    const pzNum = params.pxz > 0 ? px / params.pxz : 0;

    // X side: price rises from pRatio toward upper boundary
    // navx is in X units; convert to numeraire
    const cdXData = xCDPts.map(pt => {
      const xVirtual = pt.x + xb;
      const pXyxVal = pXyxFn(xVirtual, cx, x0, px, py); // X per Y
      if (!isFinite(pXyxVal) || pXyxVal <= 0) return null;
      const priceYperX = 1 / pXyxVal; // Y per X (user-facing price)
      // X/Y collateral & debt vary with AMM price; Z uses constant oracle prices
      const cxRaw = pt.cxx || 0, cyRaw = pt.cxy || 0, czRaw = params.zr;
      const dxRaw = pt.dxx || 0, dyRaw = pt.dxy || 0, dzRaw = pt.dxz || 0;
      const toNum = (xAmt: number, yAmt: number, zAmt: number) => {
        if (numeraire === "x") return xAmt + yAmt / priceYperX + zAmt * pzx;
        if (numeraire === "ext") return xAmt * px + yAmt * py + zAmt * pzNum;
        return xAmt * priceYperX + yAmt + zAmt * pzy; // "raw" and "y"
      };
      const col = toNum(cxRaw, cyRaw, czRaw);
      const debt = toNum(dxRaw, dyRaw, dzRaw);
      const navY = pt.navx != null ? pt.navx * priceYperX : undefined;
      const navExt = pt.navx != null ? pt.navx * px : undefined;
      return {
        price: priceYperX,
        logPrice: Math.log(priceYperX),
        collateral: col, debt,
        colX: cxRaw, colY: cyRaw, colZ: czRaw,
        debtX: dxRaw, debtY: dyRaw, debtZ: dzRaw,
        health: pt.hx,
        nav: numeraire === "x" ? pt.navx : numeraire === "ext" ? navExt : navY,
      };
    }).filter(Boolean);

    // Y side: price drops from pRatio toward lower boundary
    // navy is in Y units; convert to numeraire
    const cdYData = yCDPts.map(pt => {
      const yVirtual = pt.x + yb;
      const pYxyVal = pYxyFn(yVirtual, cy, y0, px, py); // Y per X
      if (!isFinite(pYxyVal) || pYxyVal <= 0) return null;
      const priceYperX = pYxyVal;
      // X/Y collateral & debt vary with AMM price; Z uses constant oracle prices
      const cxRaw = pt.cyx || 0, cyRaw = pt.cyy || 0, czRaw = params.zr;
      const dxRaw = pt.dyx || 0, dyRaw = pt.dyy || 0, dzRaw = pt.dyz || 0;
      const toNum = (xAmt: number, yAmt: number, zAmt: number) => {
        if (numeraire === "x") return xAmt + yAmt / priceYperX + zAmt * pzx;
        if (numeraire === "ext") return xAmt * px + yAmt * py + zAmt * pzNum;
        return xAmt * priceYperX + yAmt + zAmt * pzy; // "raw" and "y"
      };
      const col = toNum(cxRaw, cyRaw, czRaw);
      const debt = toNum(dxRaw, dyRaw, dzRaw);
      const navX = pt.navy != null ? pt.navy / priceYperX : undefined;
      const navExt = pt.navy != null ? pt.navy * py : undefined;
      return {
        price: priceYperX,
        logPrice: Math.log(priceYperX),
        collateral: col, debt,
        colX: cxRaw, colY: cyRaw, colZ: czRaw,
        debtX: dxRaw, debtY: dyRaw, debtZ: dzRaw,
        health: pt.hy,
        nav: numeraire === "x" ? navX : numeraire === "ext" ? navExt : pt.navy,
      };
    }).filter(Boolean);

    const logEq = Math.log(pRatio);

    // Boundary prices (Y per X) and their log values
    const pXb = priceAtXb(x0, rx, cx, px, py);  // upper boundary
    const pYb = priceAtYb(y0, ry, cy, px, py);  // lower boundary
    const logPXb = isFinite(pXb) && pXb > 0 ? Math.log(pXb) : null;
    const logPYb = isFinite(pYb) && pYb > 0 ? Math.log(pYb) : null;

    // Reserve depletion prices (where real reserves run out)
    const { xr, yr } = params;
    const xDeplV = x0 - xr; // virtual reserve where X depletes
    const yDeplV = y0 - yr; // virtual reserve where Y depletes

    // Both charts now use actual marginal price on x-axis
    const logPXDepl = (xDeplV > xb && xDeplV < x0) ? (() => {
      const p = pXyxFn(xDeplV, cx, x0, px, py);
      return (isFinite(p) && p > 0) ? Math.log(1 / p) : null;
    })() : null;
    const logPYDepl = (yDeplV > yb && yDeplV < y0) ? (() => {
      const p = pYxyFn(yDeplV, cy, y0, px, py);
      return (isFinite(p) && p > 0) ? Math.log(p) : null;
    })() : null;

    // Merge by logPrice, sorted ascending
    const cdData = [
      ...cdYData,
      ...cdXData,
    ].sort((a, b) => a!.logPrice - b!.logPrice);

    // For Z debt, freeze C/D values beyond reserve depletion (AMM can't trade further)
    if (zd > 0) {
      if (logPYDepl != null) {
        // Y depletes — find first valid point (at or above), freeze all below
        let deplPt: typeof cdData[0] = null;
        for (let i = 0; i < cdData.length; i++) {
          if (cdData[i]!.logPrice >= logPYDepl) { deplPt = cdData[i]; break; }
        }
        if (deplPt) {
          for (let i = 0; i < cdData.length; i++) {
            if (cdData[i]!.logPrice >= logPYDepl) break;
            const lp = cdData[i]!.logPrice;
            const price = cdData[i]!.price;
            cdData[i] = { ...deplPt!, logPrice: lp, price };
          }
        }
      }
      if (logPXDepl != null) {
        // X depletes — find last valid point (at or below), freeze all above
        let deplPt: typeof cdData[0] = null;
        for (let i = cdData.length - 1; i >= 0; i--) {
          if (cdData[i]!.logPrice <= logPXDepl) { deplPt = cdData[i]; break; }
        }
        if (deplPt) {
          for (let i = cdData.length - 1; i >= 0; i--) {
            if (cdData[i]!.logPrice <= logPXDepl) break;
            const lp = cdData[i]!.logPrice;
            const price = cdData[i]!.price;
            cdData[i] = { ...deplPt!, logPrice: lp, price };
          }
        }
      }
    }

    // Helper: price delta → log marginal price (Y per X)
    // X side: as priceDelta increases, marginal price rises → pXxy = pRatio * (1 + d)
    // Y side: as priceDelta increases, marginal price drops → pYxy = pRatio / (1 + d)
    const xLogP = (d: number) => logEq + Math.log(1 + d);
    const yLogP = (d: number) => logEq - Math.log(1 + d);

    // --- Depth chart (reserve view) ---
    // cumSame = remaining virtual reserve (starts at x0/y0, decreases toward boundary)
    // depth = x0 - cumSame = cumulative sold from equilibrium
    // Y side = bid (LEFT, price ↓): AMM buys X / sells Y as price drops
    // X side = ask (RIGHT, price ↑): AMM sells X / buys Y as price rises
    // For Z debt, cap cumulative sold at real reserves (AMM can't borrow X/Y)
    const bidMul = numeraire === "x" ? 1 / pRatio : numeraire === "ext" ? py : 1;
    const askMul = numeraire === "y" ? pRatio : numeraire === "ext" ? px : 1;
    const depthData = [
      ...yPts.filter(p => p.priceDelta > 0).map(p => {
        const sold = y0 - p.cumSame;
        return {
          logPrice: yLogP(p.priceDelta),
          bidDepth: Math.max(0, zd > 0 ? Math.min(sold, params.yr) : sold) * bidMul,
        };
      }).reverse(),
      { logPrice: logEq, bidDepth: 0, askDepth: 0 },
      ...xPts.map(p => {
        const sold = x0 - p.cumSame;
        return {
          logPrice: xLogP(p.priceDelta),
          askDepth: Math.max(0, zd > 0 ? Math.min(sold, params.xr) : sold) * askMul,
        };
      }),
    ];

    // --- Fingerprint ---
    const nFp = 200;
    const fpY = Array.from({ length: nFp }, (_, i) => {
      const d = ry * ext * ((i + 1) / nFp);
      const fy = FY(d, cy);
      return isFinite(fy) ? { logPrice: yLogP(d), fy } : null;
    }).filter(Boolean).reverse();
    const fpX = Array.from({ length: nFp }, (_, i) => {
      const d = rx * ext * ((i + 1) / nFp);
      const fx = FX(d, cx);
      return isFinite(fx) ? { logPrice: xLogP(d), fx } : null;
    }).filter(Boolean);
    const fpData = [
      ...fpY,
      { logPrice: logEq, fx: FX(0, cx), fy: FY(0, cy) },
      ...fpX,
    ];

    // --- Combined density ---
    // Y side LEFT (price ↓), X side RIGHT (price ↑)
    const xToNum = numeraire === "y" ? pRatio : numeraire === "ext" ? px : 1;
    const yToNum = numeraire === "x" ? 1 / pRatio : numeraire === "ext" ? py : 1;
    const densData = [
      ...yPts.map(p => ({
        logPrice: yLogP(p.priceDelta),
        sameL: p.densSame * yToNum,
        crossL: p.densCross * xToNum,
      })).reverse(),
      ...xPts.map(p => ({
        logPrice: xLogP(p.priceDelta),
        sameR: p.densSame * xToNum,
        crossR: p.densCross * yToNum,
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

    return { x0, y0, pRatio, logEq, logPXb, logPYb, pXb, pYb, logPXDepl, logPYDepl, logDomain, hasDebt, hasZDebt: zd > 0, cdData, depthData, fpData, densData };
  }, [params, numeraire]);

  if (!data) return null;

  const numLabel =
    numeraire === "y" ? symY
    : numeraire === "x" ? symX
    : numeraire === "ext" ? symNum
    : "";

  // Format log-price tick labels back to readable prices
  const fmtLogTick = (logP: number) => {
    const p = Math.exp(logP);
    if (p >= 1000) return `${(p / 1000).toFixed(1)}k`;
    if (p >= 0.01) return parseFloat(p.toPrecision(3)).toString();
    return p.toExponential(1);
  };

  return (
    <div className="space-y-8">
      {/* Numeraire toggle — shared across all charts */}
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-gray-400">
          Position analytics {numLabel && <span className="normal-case">({numLabel})</span>}
        </h2>
        <div className="flex gap-1">
          {(["raw", "x", "y", "ext"] as Numeraire[]).map((n) => (
            <button
              key={n}
              onClick={() => setNumeraire(n)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                numeraire === n
                  ? "bg-gray-900 text-white"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {n === "raw" ? "raw" : n === "x" ? symX : n === "y" ? symY : symNum}
            </button>
          ))}
        </div>
      </div>

      {/* Collateral & Debt vs Price */}
      <section>
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-3">
          Collateral &amp; debt vs price
        </h3>
        <div className="rounded-lg border border-gray-200 bg-white p-3">
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
              <YAxis yAxisId="left" width={50} {...AXIS} />
              {data.hasDebt ? (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  width={50}
                  {...AXIS}
                  domain={[0, (dataMax: number) => Math.min(dataMax, 10)]}
                  tick={{ fill: "#a78bfa", fontSize: 11 }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                />
              ) : (
                <YAxis yAxisId="right" orientation="right" width={50} tick={false} axisLine={false} tickLine={false} />
              )}
              <Tooltip content={<CDTooltip symX={symX} symY={symY} symZ={symZ} />} />
              <ReferenceLine
                yAxisId="left"
                x={data.logEq}
                stroke="#555"
                strokeDasharray="6 3"
                label={{ value: "p₀", position: "top", fill: "#666", fontSize: 10 }}
              />
              {data.logPXb != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPXb}
                  stroke="#f59e0b"
                  strokeDasharray="4 3"
                  label={{ value: `↑ ${fmtLogTick(data.logPXb)}`, position: "insideTopLeft", fill: "#f59e0b", fontSize: 10 }}
                />
              )}
              {data.logPYb != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPYb}
                  stroke="#f59e0b"
                  strokeDasharray="4 3"
                  label={{ value: `↓ ${fmtLogTick(data.logPYb)}`, position: "insideTopRight", fill: "#f59e0b", fontSize: 10 }}
                />
              )}
              {data.logPXDepl != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPXDepl}
                  stroke="#e879f9"
                  strokeDasharray="2 3"
                  label={{ value: `${symX}=0`, position: "insideTopLeft", fill: "#e879f9", fontSize: 10 }}
                />
              )}
              {data.logPYDepl != null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.logPYDepl}
                  stroke="#e879f9"
                  strokeDasharray="2 3"
                  label={{ value: `${symY}=0`, position: "insideTopRight", fill: "#e879f9", fontSize: 10 }}
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
            { color: "#34d399", label: <><Tex>C</Tex> — collateral{numLabel ? ` (${numLabel})` : ""}</>, key: "col" },
            { color: "#f87171", label: <><Tex>D</Tex> — debt{numLabel ? ` (${numLabel})` : ""}</>, key: "debt" },
            { color: "#06b6d4", label: <><Tex>{"\\text{NAV}"}</Tex>{numLabel ? ` (${numLabel})` : ""}</>, key: "nav" },
            ...(data.hasDebt ? [
              { color: "#a78bfa", label: <><Tex>H</Tex> — health (right axis)</>, key: "health" },
              { color: "#ef4444", label: <><Tex>{"H = 1"}</Tex> — liquidation</>, key: "hliq", dashed: true },
            ] : []),
            { color: "#f59e0b", label: <>price boundaries</>, key: "bounds", dashed: true },
            ...((data.logPXDepl != null || data.logPYDepl != null) ? [
              { color: "#e879f9", label: <>reserves depleted</>, key: "depl", dashed: true },
            ] : []),
          ]} />
          {!data.hasDebt && (
            <p className="text-xs text-gray-400 mt-1 px-1">
              No debt — enable leverage to see health curve.
            </p>
          )}
        </div>
      </section>

      {/* AMM curve views — tabbed */}
      <section>
        <div className="flex items-baseline gap-4 mb-3">
          <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">AMM curve</h3>
          <div className="flex gap-1">
            {([
              ["depth", "Depth"],
              ["density", "Density"],
              ["fingerprint", "Fingerprint"],
            ] as [CurveTab, string][]).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setCurveTab(tab)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  curveTab === tab
                    ? "bg-gray-900 text-white"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-3">
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
                  <YAxis yAxisId="left" width={50} {...AXIS} />
                  <YAxis yAxisId="right" orientation="right" width={50} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine
                    yAxisId="left"
                    x={data.logEq}
                    stroke="#555"
                    strokeDasharray="6 3"
                    label={{ value: "p₀", position: "top", fill: "#666", fontSize: 10 }}
                  />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPXDepl != null && <ReferenceLine yAxisId="left" x={data.logPXDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  {data.logPYDepl != null && <ReferenceLine yAxisId="left" x={data.logPYDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  <Area yAxisId="left" type="monotone" dataKey="bidDepth" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} strokeWidth={1.5} dot={false} connectNulls={false} name={`${symY} bid`} />
                  <Area yAxisId="left" type="monotone" dataKey="askDepth" stroke="#fb923c" fill="#fb923c" fillOpacity={0.25} strokeWidth={1.5} dot={false} connectNulls={false} name={`${symX} ask`} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <><Tex>{symY}</Tex> — bid depth{numeraire === "x" ? ` (${symX})` : ""}</>, key: "bid" },
                { color: "#fb923c", label: <><Tex>{symX}</Tex> — ask depth{numeraire === "y" ? ` (${symY})` : ""}</>, key: "ask" },
                { color: "#f59e0b", label: <>price boundaries</>, key: "bounds", dashed: true },
                ...((data.logPXDepl != null || data.logPYDepl != null) ? [
                  { color: "#e879f9", label: <>reserves depleted</>, key: "depl", dashed: true },
                ] : []),
              ]} />
            </>
          )}

          {curveTab === "density" && (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.densData} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="logPrice" type="number" domain={data.logDomain} {...AXIS} tickFormatter={fmtLogTick} label={{ value: `price (${symY} per ${symX})`, position: "bottom", fill: "#555", fontSize: 10 }} />
                  <YAxis yAxisId="left" width={50} {...AXIS} />
                  <YAxis yAxisId="right" orientation="right" width={50} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine yAxisId="left" x={data.logEq} stroke="#555" strokeDasharray="6 3" label={{ value: "p₀", position: "top", fill: "#666", fontSize: 10 }} />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPXDepl != null && <ReferenceLine yAxisId="left" x={data.logPXDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  {data.logPYDepl != null && <ReferenceLine yAxisId="left" x={data.logPYDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  <Line yAxisId="left" type="monotone" dataKey="sameL" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="ℓ_YY" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="sameR" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="ℓ_XX" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="crossL" stroke="#6366f1" strokeWidth={1.5} dot={false} name="ℓ_YX" strokeDasharray="4 2" connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="crossR" stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="ℓ_XY" strokeDasharray="4 2" connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <><Tex>{"\\ell_{YY}"}</Tex> — {symY} in (price ↓)</>, key: "lyy" },
                { color: "#a78bfa", label: <><Tex>{"\\ell_{XX}"}</Tex> — {symX} in (price ↑)</>, key: "lxx" },
                { color: "#6366f1", label: <><Tex>{"\\ell_{YX}"}</Tex> — {symX} out (price ↓)</>, key: "lyx", dashed: true },
                { color: "#8b5cf6", label: <><Tex>{"\\ell_{XY}"}</Tex> — {symY} out (price ↑)</>, key: "lxy", dashed: true },
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
                  <YAxis yAxisId="left" type="number" width={50} {...AXIS} domain={[0, "auto"]} />
                  <YAxis yAxisId="right" orientation="right" width={50} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} labelFormatter={(v) => `price: ${Math.exp(Number(v)).toFixed(2)}`} />
                  <ReferenceLine yAxisId="left" x={data.logEq} stroke="#555" strokeDasharray="6 3" label={{ value: "p₀", position: "top", fill: "#666", fontSize: 10 }} />
                  {data.logPXb != null && <ReferenceLine yAxisId="left" x={data.logPXb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPYb != null && <ReferenceLine yAxisId="left" x={data.logPYb} stroke="#f59e0b" strokeDasharray="4 3" />}
                  {data.logPXDepl != null && <ReferenceLine yAxisId="left" x={data.logPXDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  {data.logPYDepl != null && <ReferenceLine yAxisId="left" x={data.logPYDepl} stroke="#e879f9" strokeDasharray="2 3" />}
                  <ReferenceLine yAxisId="left" y={1} stroke="#555" strokeDasharray="6 3" label={{ value: "xy=k", position: "right", fill: "#666", fontSize: 10 }} />
                  <Line yAxisId="left" type="monotone" dataKey="fy" stroke="#3b82f6" strokeWidth={1.5} dot={false} name={`F_${symY}`} connectNulls={false} />
                  <Line yAxisId="left" type="monotone" dataKey="fx" stroke="#a78bfa" strokeWidth={1.5} dot={false} name={`F_${symX}`} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <Legend items={[
                { color: "#3b82f6", label: <><Tex>{`F_{${symY}}`}</Tex> — {symY} fingerprint (price ↓)</>, key: "fy" },
                { color: "#a78bfa", label: <><Tex>{`F_{${symX}}`}</Tex> — {symX} fingerprint (price ↑)</>, key: "fx" },
                { color: "#555", label: <><Tex>{"xy = k"}</Tex> — baseline</>, key: "xyk" },
              ]} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
