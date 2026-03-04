"use client";

import { useState } from "react";
import { Params } from "@/lib/math";
import ParamSlider from "./ParamSlider";

interface Props {
  params: Params;
  onChange: (p: Params) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 pb-4 border-b border-zinc-800/40">
      <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">{title}</h3>
      {children}
    </div>
  );
}

type DebtMode = "xy" | "z";

function initDebtMode(p: Params): DebtMode {
  if (p.xd > 0 || p.yd > 0) return "xy";
  return "z";
}

export default function ParamControls({ params, onChange }: Props) {
  const set = (key: keyof Params) => (v: number) => onChange({ ...params, [key]: v });

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

      <Section title="Prices">
        <ParamSlider label="p_x" value={params.px} min={1} max={1000} step={1} onChange={set("px")} />
        <ParamSlider label="p_y" value={params.py} min={1} max={1000} step={1} onChange={set("py")} />
        <ParamSlider label="p_xz" value={params.pxz} min={1} max={1000} step={1} onChange={set("pxz")} />
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
        <ParamSlider label="x_r" value={params.xr} min={0} max={100} step={1} onChange={set("xr")} />
        <ParamSlider label="y_r" value={params.yr} min={0} max={100} step={1} onChange={set("yr")} />
        <ParamSlider label="z_r" value={params.zr} min={0} max={1000} step={1} onChange={set("zr")} />
      </Section>

      <Section title="Debt mode">
        <div className="flex gap-2 mb-1">
          {(["xy", "z"] as DebtMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setDebtMode(m)}
              className={`px-2.5 py-0.5 rounded text-[11px] transition-colors ${
                mode === m
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {m === "xy" ? "X,Y debt" : "Z debt"}
            </button>
          ))}
        </div>
        {mode === "xy" && (
          <>
            <ParamSlider label="x_d" value={params.xd} min={0} max={100} step={1} onChange={(v) => onChange({ ...params, xd: v, yd: v > 0 ? 0 : params.yd })} />
            <ParamSlider label="y_d" value={params.yd} min={0} max={100} step={1} onChange={(v) => onChange({ ...params, yd: v, xd: v > 0 ? 0 : params.xd })} />
          </>
        )}
        {mode === "z" && <ParamSlider label="z_d" value={params.zdebt} min={0} max={1000} step={1} onChange={set("zdebt")} />}
      </Section>

      <Section title="Ext. collateral (X)">
        <ParamSlider label="R_XX" value={params.rXX} min={0} max={1000} step={1} onChange={set("rXX")} />
        <ParamSlider label="R_XY" value={params.rXY} min={0} max={1000} step={1} onChange={set("rXY")} />
        <ParamSlider label="R_XZ" value={params.rXZ} min={0} max={1000} step={1} onChange={set("rXZ")} />
      </Section>

      <Section title="Ext. collateral (Y)">
        <ParamSlider label="R_YX" value={params.rYX} min={0} max={1000} step={1} onChange={set("rYX")} />
        <ParamSlider label="R_YY" value={params.rYY} min={0} max={1000} step={1} onChange={set("rYY")} />
        <ParamSlider label="R_YZ" value={params.rYZ} min={0} max={1000} step={1} onChange={set("rYZ")} />
      </Section>

      <Section title="Exogenous NAV">
        <ParamSlider label="E_XC" value={params.eXC} min={0} max={1000} step={1} onChange={set("eXC")} />
        <ParamSlider label="E_XD" value={params.eXD} min={0} max={1000} step={1} onChange={set("eXD")} />
        <ParamSlider label="E_YC" value={params.eYC} min={0} max={1000} step={1} onChange={set("eYC")} />
        <ParamSlider label="E_YD" value={params.eYD} min={0} max={1000} step={1} onChange={set("eYD")} />
      </Section>
    </div>
  );
}
