"use client";

import { useState } from "react";
import { Params } from "@/lib/math";
import { AssetLabels } from "@/lib/labels";
import ParamSlider from "./ParamSlider";

interface Props {
  params: Params;
  onChange: (p: Params) => void;
  labels?: AssetLabels;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 pb-4 border-b border-gray-100">
      <h3 className="text-xs font-medium uppercase tracking-widest text-gray-400">{title}</h3>
      {children}
    </div>
  );
}

type DebtMode = "xy" | "z";

function initDebtMode(p: Params): DebtMode {
  if (p.xd > 0 || p.yd > 0) return "xy";
  return "z";
}

function NumHint({ value, unit }: { value: number; unit: string }) {
  if (value === 0) return null;
  const s = value >= 1e6 ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k`
    : value >= 1 ? value.toFixed(1)
    : value.toFixed(2);
  return <span className="text-[11px] text-gray-400 tabular-nums">≈ {s} {unit}</span>;
}

export default function ParamControls({ params, onChange, labels }: Props) {
  const set = (key: keyof Params) => (v: number) => onChange({ ...params, [key]: v });
  const pz = params.pxz > 0 ? params.px / params.pxz : 0;
  const symX = labels?.x ?? "X";
  const symY = labels?.y ?? "Y";
  const symZ = labels?.z ?? "Z";
  const symNum = labels?.num ?? "USD";

  const [mode, setMode] = useState<DebtMode>(() => initDebtMode(params));
  const setDebtMode = (m: DebtMode) => {
    setMode(m);
    // X,Y debt and Z debt are mutually exclusive
    onChange({
      ...params,
      xd: m === "xy" ? params.xd : 0,
      yd: m === "xy" ? params.yd : 0,
      zdebt: m === "z" ? (params.zdebt || 10) : 0,
    });
  };

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6">
      <Section title="LLTV (X, Y)">
        <ParamSlider label="v_yx" value={params.vyx} min={0} max={1} step={0.01} onChange={set("vyx")} />
        <ParamSlider label="v_xy" value={params.vxy} min={0} max={1} step={0.01} onChange={set("vxy")} />
      </Section>

      <Section title="LLTV (X,Y → Z)">
        <ParamSlider label="v_xz" value={params.vxz} min={0} max={1} step={0.001} onChange={set("vxz")} />
        <ParamSlider label="v_yz" value={params.vyz} min={0} max={1} step={0.001} onChange={set("vyz")} />
      </Section>

      <Section title="LLTV (Z → X,Y)">
        <ParamSlider label="v_zx" value={params.vzx} min={0} max={1} step={0.01} onChange={set("vzx")} />
        <ParamSlider label="v_zy" value={params.vzy} min={0} max={1} step={0.01} onChange={set("vzy")} />
      </Section>

      <Section title={labels ? `Prices (${labels.num})` : "Prices"}>
        <ParamSlider label="p_x" value={params.px} min={0.01} max={100000} step={0.01} onChange={set("px")} log suffix={labels ? `${labels.num}/${labels.x}` : undefined} />
        <ParamSlider label="p_y" value={params.py} min={0.01} max={100000} step={0.01} onChange={set("py")} log suffix={labels ? `${labels.num}/${labels.y}` : undefined} />
        <ParamSlider label="p_xz" value={params.pxz} min={0.01} max={100000} step={0.01} onChange={set("pxz")} log suffix={labels ? `${labels.z}/${labels.x}` : undefined} />
      </Section>

      <Section title="Price range">
        <ParamSlider label="r_x" value={params.rx} min={0} max={2} step={0.01} onChange={set("rx")} />
        <ParamSlider label="r_y" value={params.ry} min={0} max={2} step={0.01} onChange={set("ry")} />
      </Section>

      <Section title="Concentration">
        <ParamSlider label="c_x" value={params.cx} min={0} max={0.99} step={0.001} onChange={set("cx")} />
        <ParamSlider label="c_y" value={params.cy} min={0} max={0.99} step={0.001} onChange={set("cy")} />
      </Section>

      <Section title="Real deposits">
        <ParamSlider label="x_r" value={params.xr} min={0} max={100} step={1} onChange={set("xr")} suffix={symX} />
        <ParamSlider label="y_r" value={params.yr} min={0} max={100} step={1} onChange={set("yr")} suffix={symY} />
        <ParamSlider label="z_r" value={params.zr} min={0} max={1000} step={1} onChange={set("zr")} suffix={symZ} />
        {labels && <div className="pt-0.5"><NumHint value={params.xr * params.px + params.yr * params.py + params.zr * pz} unit={symNum} /></div>}
      </Section>

      <Section title="Debt mode">
        <div className="flex gap-2 mb-1">
          {(["xy", "z"] as DebtMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setDebtMode(m)}
              className={`px-2.5 py-0.5 rounded text-xs transition-colors ${
                mode === m
                  ? "bg-gray-900 text-white"
                  : "bg-white text-gray-500 hover:text-gray-900"
              }`}
            >
              {m === "xy" ? "X,Y debt" : "Z debt"}
            </button>
          ))}
        </div>
        {mode === "xy" && (
          <>
            <ParamSlider label="x_d" value={params.xd} min={0} max={100} step={1} onChange={(v) => onChange({ ...params, xd: v, yd: v > 0 ? 0 : params.yd })} suffix={symX} />
            <ParamSlider label="y_d" value={params.yd} min={0} max={100} step={1} onChange={(v) => onChange({ ...params, yd: v, xd: v > 0 ? 0 : params.xd })} suffix={symY} />
            {labels && <div className="pt-0.5"><NumHint value={params.xd * params.px + params.yd * params.py} unit={symNum} /></div>}
          </>
        )}
        {mode === "z" && (
          <>
            <ParamSlider label="z_d" value={params.zdebt} min={0} max={1000} step={1} onChange={set("zdebt")} suffix={symZ} />
            {labels && <div className="pt-0.5"><NumHint value={params.zdebt * pz} unit={symNum} /></div>}
          </>
        )}
      </Section>

      <Section title={`Ext. collateral (${symX})`}>
        <ParamSlider label="R_{XX}" value={params.rXX} min={0} max={1000} step={1} onChange={set("rXX")} suffix={symX} />
        <ParamSlider label="R_{XY}" value={params.rXY} min={0} max={1000} step={1} onChange={set("rXY")} suffix={symY} />
        <ParamSlider label="R_{XZ}" value={params.rXZ} min={0} max={1000} step={1} onChange={set("rXZ")} suffix={symZ} />
        {labels && <div className="pt-0.5"><NumHint value={params.rXX * params.px + params.rXY * params.py + params.rXZ * pz} unit={symNum} /></div>}
      </Section>

      <Section title={`Ext. collateral (${symY})`}>
        <ParamSlider label="R_{YX}" value={params.rYX} min={0} max={1000} step={1} onChange={set("rYX")} suffix={symX} />
        <ParamSlider label="R_{YY}" value={params.rYY} min={0} max={1000} step={1} onChange={set("rYY")} suffix={symY} />
        <ParamSlider label="R_{YZ}" value={params.rYZ} min={0} max={1000} step={1} onChange={set("rYZ")} suffix={symZ} />
        {labels && <div className="pt-0.5"><NumHint value={params.rYX * params.px + params.rYY * params.py + params.rYZ * pz} unit={symNum} /></div>}
      </Section>

      <Section title="Exogenous NAV">
        <ParamSlider label="E_{XC}" value={params.eXC} min={0} max={1000} step={1} onChange={set("eXC")} suffix={symNum} />
        <ParamSlider label="E_{XD}" value={params.eXD} min={0} max={1000} step={1} onChange={set("eXD")} suffix={symNum} />
        <ParamSlider label="E_{YC}" value={params.eYC} min={0} max={1000} step={1} onChange={set("eYC")} suffix={symNum} />
        <ParamSlider label="E_{YD}" value={params.eYD} min={0} max={1000} step={1} onChange={set("eYD")} suffix={symNum} />
      </Section>
    </div>
  );
}
