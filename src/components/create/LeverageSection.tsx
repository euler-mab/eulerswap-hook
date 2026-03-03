"use client";

import { useMemo } from "react";
import {
  Params, computeX0, computeY0, computeHX, computeHY,
  priceAtXb, priceAtYb,
} from "@/lib/math";
import { TOKENS } from "@/lib/tokens";
import { fmtUsd } from "@/lib/paramBuilder";

type DebtAsset = "x" | "y" | "z";

interface Props {
  enabled: boolean;
  debtAsset: DebtAsset;
  debtAmount: number;
  tokenX: string;
  tokenY: string;
  tokenZ: string;
  depositZ: number;
  params: Params;
  onToggle: (v: boolean) => void;
  onDebtAsset: (a: DebtAsset) => void;
  onDebtAmount: (v: number) => void;
  onTokenZ: (s: string) => void;
  onDepositZ: (v: number) => void;
}

function HealthBadge({ value }: { value: number }) {
  const color = !isFinite(value) || value >= 2
    ? "text-emerald-400"
    : value >= 1.1
      ? "text-amber-400"
      : "text-red-400";
  const label = !isFinite(value) ? "∞ (no debt)" : value.toFixed(2);
  return <span className={`font-mono text-sm ${color}`}>{label}</span>;
}

export default function LeverageSection(props: Props) {
  const { enabled, debtAsset, debtAmount, tokenX, tokenY, tokenZ, depositZ, params } = props;
  const assetLabel = (a: DebtAsset) =>
    a === "x" ? tokenX : a === "y" ? tokenY : tokenZ;

  const health = useMemo(() => {
    if (!enabled || debtAmount <= 0) return null;
    const x0 = computeX0(params);
    const y0 = computeY0(params);
    if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return null;

    const hX = computeHX(x0, params, x0, y0);
    const hY = computeHY(y0, params, x0, y0);
    const pXb = priceAtXb(x0, params.rx, params.cx, params.px, params.py);
    const pYb = priceAtYb(y0, params.ry, params.cy, params.px, params.py);
    return { hX, hY, pXb, pYb };
  }, [enabled, debtAmount, params]);

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => props.onToggle(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-0 focus:ring-offset-0"
        />
        <span className="text-sm text-zinc-300">Enable leverage (borrow against position)</span>
      </label>

      {enabled && (
        <>
          {/* Debt asset picker */}
          <div className="space-y-2">
            <label className="text-[10px] text-zinc-600 uppercase tracking-wider">
              Debt asset
            </label>
            <div className="flex gap-2">
              {(["x", "y", "z"] as DebtAsset[]).map((a) => (
                <button
                  key={a}
                  onClick={() => props.onDebtAsset(a)}
                  className={`px-3 py-1 rounded text-xs font-mono transition-colors ${
                    debtAsset === a
                      ? "bg-zinc-700 text-zinc-100"
                      : "bg-zinc-900 text-zinc-500 hover:text-zinc-300 border border-zinc-800"
                  }`}
                >
                  {assetLabel(a)}
                </button>
              ))}
            </div>
          </div>

          {/* Z token selector (when Z debt or Z deposit is relevant) */}
          {debtAsset === "z" && (
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-600 uppercase tracking-wider">
                Token Z (exogenous asset)
              </label>
              <select
                value={tokenZ}
                onChange={(e) => props.onTokenZ(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600 max-w-xs"
              >
                {TOKENS.filter((t) => t.symbol !== tokenX && t.symbol !== tokenY).map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol} — {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Debt amount */}
          <div className="space-y-1">
            <label className="text-[10px] text-zinc-600 uppercase tracking-wider">
              Borrow amount ({assetLabel(debtAsset)})
            </label>
            <input
              type="number"
              value={debtAmount || ""}
              onChange={(e) => props.onDebtAmount(Math.max(0, Number(e.target.value)))}
              placeholder="0"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600 max-w-xs"
            />
          </div>

          {/* Z deposit (non-traded collateral) */}
          <div className="space-y-1">
            <label className="text-[10px] text-zinc-600 uppercase tracking-wider">
              {tokenZ} deposit (non-traded collateral)
            </label>
            <input
              type="number"
              value={depositZ || ""}
              onChange={(e) => props.onDepositZ(Math.max(0, Number(e.target.value)))}
              placeholder="0"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600 max-w-xs"
            />
            <p className="text-[10px] text-zinc-600">
              Extra collateral backing your position (not traded on the AMM curve)
            </p>
          </div>

          {/* Health & liquidation */}
          {health && (
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Health (X side at eq.)</div>
                  <HealthBadge value={health.hX} />
                </div>
                <div>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Health (Y side at eq.)</div>
                  <HealthBadge value={health.hY} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-xs text-zinc-500">
                <div>
                  <span className="text-zinc-600">Upper boundary: </span>
                  <span className="font-mono text-zinc-400">{fmtUsd(health.pXb)}</span>
                </div>
                <div>
                  <span className="text-zinc-600">Lower boundary: </span>
                  <span className="font-mono text-zinc-400">{fmtUsd(health.pYb)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
