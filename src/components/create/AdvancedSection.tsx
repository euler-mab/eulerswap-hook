"use client";

import { Params, computeX0, computeY0, computeSx, computeSy, computeBxc, computeByc } from "@/lib/math";
import CurveChart from "@/components/CurveChart";
import HealthChart from "@/components/HealthChart";

interface Props {
  params: Params;
}

export default function AdvancedSection({ params }: Props) {
  const x0 = computeX0(params);
  const y0 = computeY0(params);
  const sx = computeSx(params.rx, params.cx);
  const sy = computeSy(params.ry, params.cy);
  const bXC = computeBxc(sx);
  const bYC = computeByc(sy);
  const bXL = params.xr > 0 && isFinite(bXC) ? x0 / (params.xr * bXC) : 0;
  const bYL = params.yr > 0 && isFinite(bYC) ? y0 / (params.yr * bYC) : 0;

  const fmt = (n: number) => {
    if (!isFinite(n)) return "—";
    if (Math.abs(n) >= 1000) return n.toFixed(1);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
  };

  return (
    <div className="space-y-6">
      {/* Computed params grid */}
      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-3">
          Computed parameters
        </h3>
        <div className="grid grid-cols-2 gap-x-10 gap-y-1 font-mono text-xs text-zinc-400">
          <span>px = {fmt(params.px)}</span>
          <span>py = {fmt(params.py)}</span>
          <span>rx = {fmt(params.rx)}</span>
          <span>ry = {fmt(params.ry)}</span>
          <span>cx = {fmt(params.cx)}</span>
          <span>cy = {fmt(params.cy)}</span>
          <span>xr = {fmt(params.xr)}</span>
          <span>yr = {fmt(params.yr)}</span>
          <span className="text-zinc-600 mt-1">Boost</span>
          <span />
          <span>b_XC = {fmt(bXC)}</span>
          <span>b_YC = {fmt(bYC)}</span>
          <span>b_XL = {fmt(bXL)}</span>
          <span>b_YL = {fmt(bYL)}</span>
          <span className="text-zinc-600 mt-1">Virtual reserves</span>
          <span />
          <span>x0 = {fmt(x0)}</span>
          <span>y0 = {fmt(y0)}</span>
          <span className="text-zinc-600 mt-1">Debt</span>
          <span />
          <span>xd = {fmt(params.xd)}</span>
          <span>yd = {fmt(params.yd)}</span>
          <span>zdebt = {fmt(params.zdebt)}</span>
          <span />
          <span className="text-zinc-600 mt-1">External collateral</span>
          <span />
          <span>rXX = {fmt(params.rXX)}</span>
          <span>rYY = {fmt(params.rYY)}</span>
          <span>rXY = {fmt(params.rXY)}</span>
          <span>rYX = {fmt(params.rYX)}</span>
          <span className="text-zinc-600 mt-1">Exogenous (NAV)</span>
          <span />
          <span>eXC = {fmt(params.eXC)}</span>
          <span>eXD = {fmt(params.eXD)}</span>
          <span>eYC = {fmt(params.eYC)}</span>
          <span>eYD = {fmt(params.eYD)}</span>
        </div>
      </div>

      {/* Full curve charts */}
      <CurveChart params={params} />

      <hr className="border-zinc-800" />

      <HealthChart params={params} />
    </div>
  );
}
