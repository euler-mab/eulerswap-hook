"use client";

import { AssetLabels } from "@/lib/labels";
import { TOKENS } from "@/lib/tokens";
import { Params } from "@/lib/math";

interface Props {
  labels: AssetLabels;
  onChange: (labels: AssetLabels) => void;
  onApplyPreset?: (labels: AssetLabels, patch: Partial<Params>) => void;
}

const PRESETS: { x: string; y: string; z: string }[] = [
  { x: "ETH", y: "USDC", z: "DAI" },
  { x: "WBTC", y: "ETH", z: "USDC" },
  { x: "WBTC", y: "USDC", z: "DAI" },
  { x: "ETH", y: "USDT", z: "USDC" },
];

function tokenPrice(symbol: string): number {
  return TOKENS.find((t) => t.symbol === symbol)?.price ?? 1;
}

export default function AssetNameInputs({ labels, onChange, onApplyPreset }: Props) {
  const set = (key: keyof AssetLabels) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...labels, [key]: e.target.value });

  const inputCls =
    "w-14 bg-transparent border border-gray-300 rounded px-1.5 py-0.5 " +
    "text-sm font-mono text-gray-700 text-center " +
    "focus:outline-none focus:border-blue-500 placeholder:text-gray-400";

  const applyPreset = (p: { x: string; y: string; z: string }) => {
    const pxUsd = tokenPrice(p.x);
    const pyUsd = tokenPrice(p.y);
    const pzUsd = tokenPrice(p.z);
    const newLabels: AssetLabels = { x: p.x, y: p.y, z: p.z, num: "USD" };
    if (onApplyPreset) {
      onApplyPreset(newLabels, {
        px: pxUsd,
        py: pyUsd,
        pxz: pxUsd > 0 ? pzUsd / pxUsd : 1,
      });
    } else {
      onChange(newLabels);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <label className="flex items-center gap-1">
          X <input className={inputCls} value={labels.x} onChange={set("x")} placeholder="X" />
        </label>
        <label className="flex items-center gap-1">
          Y <input className={inputCls} value={labels.y} onChange={set("y")} placeholder="Y" />
        </label>
        <label className="flex items-center gap-1">
          Z <input className={inputCls} value={labels.z} onChange={set("z")} placeholder="Z" />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">$</span>
          <input className={inputCls} value={labels.num} onChange={set("num")} placeholder="USD" />
        </label>
      </div>
      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={`${p.x}/${p.y}`}
            onClick={() => applyPreset(p)}
            className="px-1.5 py-0.5 rounded text-[11px] text-gray-400 hover:text-gray-900 border border-gray-100 hover:border-gray-400 transition-colors"
          >
            {p.x}/{p.y}
          </button>
        ))}
      </div>
    </div>
  );
}
