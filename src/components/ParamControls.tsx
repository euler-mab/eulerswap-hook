"use client";

import { Params } from "@/lib/math";
import ParamSlider from "./ParamSlider";

interface Props {
  params: Params;
  onChange: (p: Params) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">{title}</h3>
      {children}
    </div>
  );
}

export default function ParamControls({ params, onChange }: Props) {
  const set = (key: keyof Params) => (v: number) => onChange({ ...params, [key]: v });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-5">
      <Section title="LLTV (X coll on Y debt)">
        <ParamSlider label="v_yx" value={params.vyx} min={0} max={1} step={0.01} onChange={set("vyx")} />
        <ParamSlider label="v_xy" value={params.vxy} min={0} max={1} step={0.01} onChange={set("vxy")} />
      </Section>

      <Section title="LLTV (X,Y coll on Z debt)">
        <ParamSlider label="v_xz" value={params.vxz} min={0} max={1} step={0.001} onChange={set("vxz")} />
        <ParamSlider label="v_yz" value={params.vyz} min={0} max={1} step={0.001} onChange={set("vyz")} />
      </Section>

      <Section title="LLTV (Z coll on X,Y)">
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

      <Section title="Real debts">
        <ParamSlider label="x_d" value={params.xd} min={0} max={100} step={1} onChange={set("xd")} />
        <ParamSlider label="y_d" value={params.yd} min={0} max={100} step={1} onChange={set("yd")} />
        <ParamSlider label="z_dbt" value={params.zdebt} min={0} max={1000} step={1} onChange={set("zdebt")} />
      </Section>
    </div>
  );
}
