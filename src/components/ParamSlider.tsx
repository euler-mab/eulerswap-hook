"use client";

import Tex from "./Tex";

interface ParamSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  log?: boolean;
  suffix?: string;
}

export default function ParamSlider({ label, value, min, max, step, onChange, log, suffix }: ParamSliderProps) {
  const logMin = log ? Math.log10(Math.max(min, 1e-6)) : 0;
  const logMax = log ? Math.log10(max) : 0;
  const logRange = logMax - logMin;

  const sliderValue = log
    ? (Math.log10(Math.max(value, min)) - logMin) / logRange
    : value;

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (log) {
      const t = parseFloat(e.target.value);
      const logVal = logMin + t * logRange;
      onChange(parseFloat(Math.pow(10, logVal).toPrecision(6)));
    } else {
      onChange(parseFloat(e.target.value));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-gray-500 shrink-0 flex items-center"><Tex>{label}</Tex></span>
      <input
        type="range"
        min={log ? 0 : min}
        max={log ? 1 : max}
        step={log ? 0.001 : step}
        value={sliderValue}
        onChange={handleSlider}
        className="flex-1 h-1 accent-blue-500 cursor-pointer"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        className="w-16 bg-transparent border border-gray-300 rounded px-1.5 py-0.5 text-sm font-mono text-gray-700 text-right focus:outline-none focus:border-blue-500"
      />
      {suffix && <span className="text-[11px] text-gray-400 text-right shrink-0 whitespace-nowrap">{suffix}</span>}
    </div>
  );
}
