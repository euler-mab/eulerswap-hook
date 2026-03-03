"use client";

import { useState } from "react";
import { defaultParams, Params } from "@/lib/math";
import ParamControls from "@/components/ParamControls";
import CurveChart from "@/components/CurveChart";

export default function Home() {
  const [params, setParams] = useState<Params>(defaultParams);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">EulerSwap</h1>
          <p className="text-sm text-zinc-500 mt-0.5">AMM curve explorer</p>
        </header>

        <ParamControls params={params} onChange={setParams} />

        <CurveChart params={params} />
      </div>
    </div>
  );
}
