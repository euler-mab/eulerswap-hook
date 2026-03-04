"use client";

interface ParamSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

export default function ParamSlider({ label, value, min, max, step, onChange }: ParamSliderProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-10 text-xs text-zinc-500 font-mono shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 accent-zinc-400 cursor-pointer"
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
        className="w-16 bg-transparent border border-zinc-800 rounded px-1.5 py-0.5 text-xs font-mono text-zinc-300 text-right focus:outline-none focus:border-zinc-600"
      />
    </div>
  );
}
