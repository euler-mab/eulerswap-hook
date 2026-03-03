"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { validateParams } from "@/lib/math";
import { getToken } from "@/lib/tokens";
import { PRESETS, rxToPrice, ryToPrice } from "@/lib/presets";
import { CreateFormState, defaultFormState, buildParams } from "@/lib/paramBuilder";
import SectionCard from "@/components/create/SectionCard";
import TokenPairDeposit from "@/components/create/TokenPairDeposit";
import StrategySection from "@/components/create/StrategySection";
import PositionPreview from "@/components/create/PositionPreview";
import LeverageSection from "@/components/create/LeverageSection";
import ExistingPositions from "@/components/create/ExistingPositions";
import AdvancedSection from "@/components/create/AdvancedSection";

type PresetKey = "conservative" | "moderate" | "aggressive" | "custom";

export default function CreatePage() {
  const [form, setForm] = useState<CreateFormState>(defaultFormState);

  const set = useCallback(
    <K extends keyof CreateFormState>(key: K) =>
      (value: CreateFormState[K]) =>
        setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  // When token changes, recalculate equilibrium price and price bounds for current preset
  const setTokenX = useCallback((symbol: string) => {
    setForm((prev) => {
      const eqPrice = getToken(symbol).price / getToken(prev.tokenY).price;
      const preset = prev.preset !== "custom" ? PRESETS[prev.preset] : null;
      return {
        ...prev,
        tokenX: symbol,
        equilibriumPrice: eqPrice,
        ...(preset && {
          priceMin: Number(rxToPrice(preset.rx, eqPrice).toFixed(2)),
          priceMax: Number(ryToPrice(preset.ry, eqPrice).toFixed(2)),
        }),
      };
    });
  }, []);

  const setTokenY = useCallback((symbol: string) => {
    setForm((prev) => {
      const eqPrice = getToken(prev.tokenX).price / getToken(symbol).price;
      const preset = prev.preset !== "custom" ? PRESETS[prev.preset] : null;
      return {
        ...prev,
        tokenY: symbol,
        equilibriumPrice: eqPrice,
        ...(preset && {
          priceMin: Number(rxToPrice(preset.rx, eqPrice).toFixed(2)),
          priceMax: Number(ryToPrice(preset.ry, eqPrice).toFixed(2)),
        }),
      };
    });
  }, []);

  const params = useMemo(() => buildParams(form), [form]);
  const warnings = useMemo(() => validateParams(params), [params]);
  const oraclePrice = getToken(form.tokenX).price / getToken(form.tokenY).price;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Create Position</h1>
            <p className="text-sm text-zinc-500 mt-0.5">Configure your EulerSwap LP</p>
          </div>
          <Link href="/" className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            ← Explorer
          </Link>
        </header>

        {/* 1. Pair & Deposit */}
        <section>
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-zinc-600 mb-4">
            Pair &amp; deposit
          </h2>
          <TokenPairDeposit
            tokenX={form.tokenX}
            tokenY={form.tokenY}
            depositX={form.depositX}
            depositY={form.depositY}
            onTokenX={setTokenX}
            onTokenY={setTokenY}
            onDepositX={set("depositX")}
            onDepositY={set("depositY")}
          />
        </section>

        {/* 2. Strategy */}
        <SectionCard title="Strategy" defaultOpen>
          <StrategySection
            preset={form.preset}
            equilibriumPrice={form.equilibriumPrice}
            oraclePrice={oraclePrice}
            priceMin={form.priceMin}
            priceMax={form.priceMax}
            concentration={form.concentration}
            asymmetric={form.asymmetric}
            concentrationY={form.concentrationY}
            onPreset={set("preset")}
            onEquilibriumPrice={set("equilibriumPrice")}
            onPriceMin={set("priceMin")}
            onPriceMax={set("priceMax")}
            onConcentration={set("concentration")}
            onAsymmetric={set("asymmetric")}
            onConcentrationY={set("concentrationY")}
          />
        </SectionCard>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-300 space-y-1">
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}

        {/* 3. Position Preview (always visible) */}
        <SectionCard title="Position preview" defaultOpen>
          <PositionPreview params={params} />
        </SectionCard>

        {/* 4. Leverage */}
        <SectionCard title="Leverage" defaultOpen={false} badge="Optional">
          <LeverageSection
            enabled={form.leverageEnabled}
            debtAsset={form.debtAsset}
            debtAmount={form.debtAmount}
            tokenX={form.tokenX}
            tokenY={form.tokenY}
            tokenZ={form.tokenZ}
            depositZ={form.depositZ}
            params={params}
            onToggle={set("leverageEnabled")}
            onDebtAsset={set("debtAsset")}
            onDebtAmount={set("debtAmount")}
            onTokenZ={set("tokenZ")}
            onDepositZ={set("depositZ")}
          />
        </SectionCard>

        {/* 5. Existing Vault Positions */}
        <SectionCard title="Existing vault positions" defaultOpen={false} badge="Optional">
          <ExistingPositions
            form={form}
            params={params}
            tokenX={form.tokenX}
            tokenY={form.tokenY}
            tokenZ={form.tokenZ}
            onVaultDepositX={set("vaultDepositX")}
            onVaultDepositY={set("vaultDepositY")}
            onVaultDepositZ={set("vaultDepositZ")}
            onVaultDebtX={set("vaultDebtX")}
            onVaultDebtY={set("vaultDebtY")}
            onVaultDebtZ={set("vaultDebtZ")}
          />
        </SectionCard>

        {/* 6. Advanced */}
        <SectionCard title="Advanced" defaultOpen={false} badge="Developer">
          <AdvancedSection params={params} />
        </SectionCard>

        {/* Deploy button (mock) */}
        <div className="pt-4 pb-10">
          <button
            disabled
            className="w-full py-3 rounded-lg bg-blue-600/50 text-sm font-medium text-blue-200 cursor-not-allowed"
          >
            Deploy Position (coming soon)
          </button>
          <p className="text-[10px] text-zinc-600 text-center mt-2">
            Wallet connection and on-chain deployment not yet implemented.
          </p>
        </div>
      </div>
    </div>
  );
}
