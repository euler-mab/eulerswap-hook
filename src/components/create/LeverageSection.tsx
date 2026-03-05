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
    ? "text-emerald-600"
    : value >= 1.1
      ? "text-amber-400"
      : "text-red-600";
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
          className="w-4 h-4 rounded border-gray-400 bg-white text-blue-500 focus:ring-0 focus:ring-offset-0"
        />
        <span className="text-sm text-gray-700">Enable leverage (borrow against position)</span>
      </label>

      {enabled && (
        <>
          {/* Debt asset picker */}
          <div className="space-y-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider">
              Debt asset
            </label>
            <div className="flex gap-2">
              {(["x", "y", "z"] as DebtAsset[]).map((a) => (
                <button
                  key={a}
                  onClick={() => props.onDebtAsset(a)}
                  className={`px-3 py-1 rounded text-sm font-mono transition-colors ${
                    debtAsset === a
                      ? "bg-gray-900 text-white"
                      : "bg-white text-gray-500 hover:text-gray-900 border border-gray-300"
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
              <label className="text-xs text-gray-400 uppercase tracking-wider">
                Token Z (exogenous asset)
              </label>
              <select
                value={tokenZ}
                onChange={(e) => props.onTokenZ(e.target.value)}
                className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500 max-w-xs"
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
            <label className="text-xs text-gray-400 uppercase tracking-wider">
              Borrow amount ({assetLabel(debtAsset)})
            </label>
            <input
              type="number"
              value={debtAmount || ""}
              onChange={(e) => props.onDebtAmount(Math.max(0, Number(e.target.value)))}
              placeholder="0"
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500 max-w-xs"
            />
          </div>

          {/* Z deposit (non-traded collateral) */}
          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">
              {tokenZ} deposit (non-traded collateral)
            </label>
            <input
              type="number"
              value={depositZ || ""}
              onChange={(e) => props.onDepositZ(Math.max(0, Number(e.target.value)))}
              placeholder="0"
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500 max-w-xs"
            />
            <p className="text-xs text-gray-400">
              Extra collateral backing your position (not traded on the AMM curve)
            </p>
          </div>

          {/* Health & liquidation */}
          {health && (
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-4 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Health (X side at eq.)</div>
                  <HealthBadge value={health.hX} />
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Health (Y side at eq.)</div>
                  <HealthBadge value={health.hY} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm text-gray-500">
                <div>
                  <span className="text-gray-400">Upper boundary: </span>
                  <span className="font-mono text-gray-700">{fmtUsd(health.pXb)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Lower boundary: </span>
                  <span className="font-mono text-gray-700">{fmtUsd(health.pYb)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
