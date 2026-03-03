"use client";

import { PRESETS, rxToPrice, ryToPrice } from "@/lib/presets";
import { efficiencyLabel, fmtUsd } from "@/lib/paramBuilder";
import ParamSlider from "@/components/ParamSlider";

type PresetKey = "conservative" | "moderate" | "aggressive" | "custom";

interface Props {
  preset: PresetKey;
  equilibriumPrice: number;  // Y per X — user-adjustable
  oraclePrice: number;       // Y per X — from token list (read-only)
  priceMin: number;
  priceMax: number;
  concentration: number;
  asymmetric: boolean;
  concentrationY: number;
  onPreset: (p: PresetKey) => void;
  onEquilibriumPrice: (v: number) => void;
  onPriceMin: (v: number) => void;
  onPriceMax: (v: number) => void;
  onConcentration: (v: number) => void;
  onAsymmetric: (v: boolean) => void;
  onConcentrationY: (v: number) => void;
}

export default function StrategySection(props: Props) {
  const { preset, equilibriumPrice, oraclePrice, priceMin, priceMax, concentration, asymmetric, concentrationY } = props;
  const currentPrice = equilibriumPrice;

  // When a preset is selected, compute price bounds and concentration
  const selectPreset = (key: PresetKey) => {
    if (key === "custom") {
      props.onPreset("custom");
      return;
    }
    const p = PRESETS[key];
    props.onPreset(key);
    props.onPriceMin(Number(rxToPrice(p.rx, currentPrice).toFixed(2)));
    props.onPriceMax(Number(ryToPrice(p.ry, currentPrice).toFixed(2)));
    props.onConcentration(p.concentration);
    props.onConcentrationY(p.concentration);
    props.onAsymmetric(false);
  };

  // Any manual edit switches to custom
  const editPriceMin = (v: number) => { props.onPreset("custom"); props.onPriceMin(v); };
  const editPriceMax = (v: number) => { props.onPreset("custom"); props.onPriceMax(v); };
  const editConcentration = (v: number) => {
    props.onPreset("custom");
    props.onConcentration(v);
    if (!asymmetric) props.onConcentrationY(v);
  };
  const editConcentrationY = (v: number) => { props.onPreset("custom"); props.onConcentrationY(v); };

  // Compute rx/ry for efficiency labels
  const rx = currentPrice > 0 && priceMin > 0 ? currentPrice / priceMin - 1 : 0.5;
  const ry = currentPrice > 0 && priceMax > 0 ? priceMax / currentPrice - 1 : 0.5;
  const effX = efficiencyLabel(concentration, Math.max(0.01, rx));
  const effY = asymmetric
    ? efficiencyLabel(concentrationY, Math.max(0.01, ry))
    : effX;

  return (
    <div className="space-y-5">
      {/* Preset buttons */}
      <div className="flex gap-2">
        {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
          <button
            key={key}
            onClick={() => selectPreset(key)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              preset === key
                ? "bg-zinc-700 text-zinc-100"
                : "bg-zinc-900 text-zinc-500 hover:text-zinc-300 border border-zinc-800"
            }`}
          >
            {PRESETS[key].label}
          </button>
        ))}
        <button
          onClick={() => selectPreset("custom")}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            preset === "custom"
              ? "bg-zinc-700 text-zinc-100"
              : "bg-zinc-900 text-zinc-500 hover:text-zinc-300 border border-zinc-800"
          }`}
        >
          Custom
        </button>
      </div>

      {preset !== "custom" && (
        <p className="text-xs text-zinc-500">{PRESETS[preset].description}</p>
      )}

      {/* Equilibrium price */}
      <div className="space-y-1">
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">
          Equilibrium price (Y per X)
        </h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={equilibriumPrice || ""}
            onChange={(e) => props.onEquilibriumPrice(Math.max(0.0001, Number(e.target.value)))}
            className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600 max-w-[180px]"
          />
          {Math.abs(equilibriumPrice - oraclePrice) > 0.001 && (
            <button
              onClick={() => props.onEquilibriumPrice(oraclePrice)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              reset to oracle ({fmtUsd(oraclePrice)})
            </button>
          )}
        </div>
        <p className="text-[10px] text-zinc-600">
          The price at which the position is centered. Oracle: {fmtUsd(oraclePrice)}
        </p>
      </div>

      {/* Price range */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">
          Price range (Y per X)
        </h3>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <label className="text-[10px] text-zinc-600 mb-1 block">Lower bound</label>
            <input
              type="number"
              value={priceMin || ""}
              onChange={(e) => editPriceMin(Math.max(0.01, Number(e.target.value)))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div className="text-center pt-4">
            <div className="text-[10px] text-zinc-600">current</div>
            <div className="text-xs text-zinc-400 font-mono">{fmtUsd(currentPrice)}</div>
          </div>
          <div>
            <label className="text-[10px] text-zinc-600 mb-1 block">Upper bound</label>
            <input
              type="number"
              value={priceMax || ""}
              onChange={(e) => editPriceMax(Math.max(0.01, Number(e.target.value)))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 font-mono focus:outline-none focus:border-zinc-600"
            />
          </div>
        </div>

        {/* Visual price bar */}
        <PriceBar min={priceMin} max={priceMax} current={currentPrice} />
      </div>

      {/* Concentration */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">
            Concentration
          </h3>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={asymmetric}
              onChange={(e) => {
                props.onAsymmetric(e.target.checked);
                if (!e.target.checked) props.onConcentrationY(concentration);
                props.onPreset("custom");
              }}
              className="w-3 h-3 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-0 focus:ring-offset-0"
            />
            <span className="text-[10px] text-zinc-600">Asymmetric (cx ≠ cy)</span>
          </label>
        </div>

        {!asymmetric ? (
          <div className="space-y-1">
            <span className="text-xs text-zinc-500 font-mono">
              {(concentration * 100).toFixed(0)}% — {effX} capital efficiency
            </span>
            <ParamSlider
              label=""
              value={concentration}
              min={0}
              max={0.99}
              step={0.01}
              onChange={editConcentration}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-600">X side (cx)</span>
              <span className="text-xs text-zinc-500 font-mono block">
                {(concentration * 100).toFixed(0)}% — {effX}
              </span>
              <ParamSlider
                label=""
                value={concentration}
                min={0}
                max={0.99}
                step={0.01}
                onChange={editConcentration}
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-600">Y side (cy)</span>
              <span className="text-xs text-zinc-500 font-mono block">
                {(concentrationY * 100).toFixed(0)}% — {effY}
              </span>
              <ParamSlider
                label=""
                value={concentrationY}
                min={0}
                max={0.99}
                step={0.01}
                onChange={editConcentrationY}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Visual bar showing position range relative to current price. */
function PriceBar({ min, max, current }: { min: number; max: number; current: number }) {
  if (min <= 0 || max <= 0 || max <= min) return null;
  // Position current price as % within the range
  const pct = Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
  return (
    <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
      <div
        className="absolute inset-y-0 bg-blue-500/30 rounded-full"
        style={{ left: "0%", right: "0%" }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-zinc-400"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}
