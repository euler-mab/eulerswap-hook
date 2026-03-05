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
  concentrationY: number;
  onPreset: (p: PresetKey) => void;
  onEquilibriumPrice: (v: number) => void;
  onPriceMin: (v: number) => void;
  onPriceMax: (v: number) => void;
  onConcentration: (v: number) => void;
  onConcentrationY: (v: number) => void;
}

export default function StrategySection(props: Props) {
  const { preset, equilibriumPrice, oraclePrice, priceMin, priceMax, concentration, concentrationY } = props;
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
  };

  // Any manual edit switches to custom
  const editPriceMin = (v: number) => { props.onPreset("custom"); props.onPriceMin(v); };
  const editPriceMax = (v: number) => { props.onPreset("custom"); props.onPriceMax(v); };
  const editConcentration = (v: number) => {
    props.onPreset("custom");
    props.onConcentration(v);
  };
  const editConcentrationY = (v: number) => { props.onPreset("custom"); props.onConcentrationY(v); };

  // Compute rx/ry for efficiency labels
  const rx = currentPrice > 0 && priceMin > 0 ? currentPrice / priceMin - 1 : 0.5;
  const ry = currentPrice > 0 && priceMax > 0 ? priceMax / currentPrice - 1 : 0.5;
  const effX = efficiencyLabel(concentration, Math.max(0.01, rx));
  const effY = efficiencyLabel(concentrationY, Math.max(0.01, ry));

  return (
    <div className="space-y-5">
      {/* Preset buttons */}
      <div className="flex gap-2">
        {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
          <button
            key={key}
            onClick={() => selectPreset(key)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              preset === key
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-500 hover:text-gray-900 border border-gray-300"
            }`}
          >
            {PRESETS[key].label}
          </button>
        ))}
        <button
          onClick={() => selectPreset("custom")}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            preset === "custom"
              ? "bg-gray-900 text-white"
              : "bg-white text-gray-500 hover:text-gray-900 border border-gray-300"
          }`}
        >
          Custom
        </button>
      </div>

      {preset !== "custom" && (
        <p className="text-sm text-gray-500">{PRESETS[preset].description}</p>
      )}

      {/* Equilibrium price */}
      <div className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">
          Equilibrium price (Y per X)
        </h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={equilibriumPrice || ""}
            onChange={(e) => props.onEquilibriumPrice(Math.max(0.0001, Number(e.target.value)))}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500 max-w-[180px]"
          />
          {Math.abs(equilibriumPrice - oraclePrice) > 0.001 && (
            <button
              onClick={() => props.onEquilibriumPrice(oraclePrice)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              reset to oracle ({fmtUsd(oraclePrice)})
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400">
          The price at which the position is centered. Oracle: {fmtUsd(oraclePrice)}
        </p>
      </div>

      {/* Price range */}
      <div className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">
          Price range (Y per X)
        </h3>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Lower bound</label>
            <input
              type="number"
              value={priceMin || ""}
              onChange={(e) => editPriceMin(Math.max(0.01, Number(e.target.value)))}
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="text-center pt-4">
            <div className="text-xs text-gray-400">current</div>
            <div className="text-sm text-gray-700 font-mono">{fmtUsd(currentPrice)}</div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Upper bound</label>
            <input
              type="number"
              value={priceMax || ""}
              onChange={(e) => editPriceMax(Math.max(0.01, Number(e.target.value)))}
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Visual price bar */}
        <PriceBar min={priceMin} max={priceMax} current={currentPrice} />
      </div>

      {/* Concentration */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">
          Concentration
        </h3>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <span className="text-xs text-gray-400">X side (cx)</span>
            <span className="text-sm text-gray-500 font-mono block">
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
            <span className="text-xs text-gray-400">Y side (cy)</span>
            <span className="text-sm text-gray-500 font-mono block">
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
    <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
      <div
        className="absolute inset-y-0 bg-blue-500/30 rounded-full"
        style={{ left: "0%", right: "0%" }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-gray-500"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}
