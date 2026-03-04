"use client";

import { useMemo } from "react";
import {
  Params, computeX0, computeY0, computeSx, computeSy,
  computeBxc, computeByc, priceAtXb, priceAtYb,
} from "@/lib/math";
import { fmtAmount, fmtUsd } from "@/lib/paramBuilder";
import OrderBookChart from "@/components/OrderBookChart";

interface Props {
  params: Params;
  tokenX?: string;
  tokenY?: string;
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5">
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</div>
      <div className="text-sm text-zinc-200 font-mono mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function PositionPreview({ params, tokenX, tokenY }: Props) {
  const metrics = useMemo(() => {
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return null;

    const sx = computeSx(params.rx, params.cx);
    const sy = computeSy(params.ry, params.cy);
    const bXC = computeBxc(sx);
    const bYC = computeByc(sy);
    const bXL = params.xr > 0 ? x0 / (params.xr * bXC) : 0;
    const bYL = params.yr > 0 ? y0 / (params.yr * bYC) : 0;
    const pXb = priceAtXb(x0, params.rx, params.cx, params.px, params.py);
    const pYb = priceAtYb(y0, params.ry, params.cy, params.px, params.py);

    return { x0, y0, bXC, bYC, bXL, bYL, pXb, pYb };
  }, [params]);

  if (!metrics) {
    return (
      <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
        Enter deposits and strategy parameters to see a preview.
      </div>
    );
  }

  const { x0, y0, bXC, bYC, bXL, bYL, pXb, pYb } = metrics;
  const totalBoostX = bXC * bXL;
  const totalBoostY = bYC * bYL;

  return (
    <div className="space-y-4">
      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric
          label="Concentration boost"
          value={`${isFinite(bXC) ? bXC.toFixed(1) : "—"}× / ${isFinite(bYC) ? bYC.toFixed(1) : "—"}×`}
          sub="X / Y side"
        />
        <Metric
          label="Total boost"
          value={`${isFinite(totalBoostX) ? totalBoostX.toFixed(1) : "—"}× / ${isFinite(totalBoostY) ? totalBoostY.toFixed(1) : "—"}×`}
          sub={bXL !== 1 ? `incl. ${bXL.toFixed(1)}× leverage` : "no leverage"}
        />
        <Metric
          label="Virtual reserves"
          value={`${fmtAmount(x0)} / ${fmtAmount(y0)}`}
          sub="X / Y"
        />
        <Metric
          label="Boundary prices"
          value={`${fmtUsd(pYb)} — ${fmtUsd(pXb)}`}
          sub="lower — upper"
        />
      </div>

      {/* Depth chart */}
      <OrderBookChart params={params} labelX={tokenX} labelY={tokenY} defaultNumeraire={tokenY ? "y" : "raw"} />
    </div>
  );
}
