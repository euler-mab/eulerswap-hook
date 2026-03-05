"use client";

import { useMemo } from "react";
import {
  Params, computeX0, computeY0,
  computeHX, computeHY,
} from "@/lib/math";
import { buildParams, CreateFormState, fmtUsd } from "@/lib/paramBuilder";

interface Props {
  form: CreateFormState;
  params: Params;
  tokenX: string;
  tokenY: string;
  tokenZ: string;
  onVaultDepositX: (v: number) => void;
  onVaultDepositY: (v: number) => void;
  onVaultDepositZ: (v: number) => void;
  onVaultDebtX: (v: number) => void;
  onVaultDebtY: (v: number) => void;
  onVaultDebtZ: (v: number) => void;
}

function VaultInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-500 w-16 shrink-0 font-mono">{label}</span>
      <input
        type="number"
        value={value || ""}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        placeholder="0"
        className="flex-1 bg-white border border-gray-300 rounded px-2.5 py-1.5 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

export default function ExistingPositions(props: Props) {
  const { form, params } = props;

  const hasVaultActivity =
    form.vaultDepositX > 0 || form.vaultDepositY > 0 || form.vaultDepositZ > 0 ||
    form.vaultDebtX > 0 || form.vaultDebtY > 0 || form.vaultDebtZ > 0;

  // Compare health with and without vault positions
  const impact = useMemo(() => {
    if (!hasVaultActivity) return null;

    const x0 = computeX0(params);
    const y0 = computeY0(params);
    if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return null;

    // Health WITH vault positions (current params)
    const hXWith = computeHX(x0, params, x0, y0);
    const hYWith = computeHY(y0, params, x0, y0);

    // Health WITHOUT vault positions
    const formWithout: CreateFormState = {
      ...form,
      vaultDepositX: 0, vaultDepositY: 0, vaultDepositZ: 0,
      vaultDebtX: 0, vaultDebtY: 0, vaultDebtZ: 0,
    };
    const paramsWithout = buildParams(formWithout);
    const x0w = computeX0(paramsWithout);
    const y0w = computeY0(paramsWithout);
    const hXWithout = isFinite(x0w) && x0w > 0 ? computeHX(x0w, paramsWithout, x0w, y0w) : Infinity;
    const hYWithout = isFinite(y0w) && y0w > 0 ? computeHY(y0w, paramsWithout, y0w, y0w) : Infinity;

    // NAV impact (in Y units for display as USD-like)
    const pxy = params.px / params.py;
    const depositValue =
      form.vaultDepositX * params.px +
      form.vaultDepositY * params.py +
      form.vaultDepositZ * (params.px / (params.pxz || 1));
    const debtValue =
      form.vaultDebtX * params.px +
      form.vaultDebtY * params.py +
      form.vaultDebtZ * (params.px / (params.pxz || 1));

    return { hXWith, hYWith, hXWithout, hYWithout, depositValue, debtValue };
  }, [form, params, hasVaultActivity]);

  const fmtH = (v: number) => !isFinite(v) ? "∞" : v.toFixed(2);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        If you have existing deposits or debts in Euler lending vaults, enter them here.
        They affect your position&apos;s health factor and net asset value.
      </p>

      <div className="grid grid-cols-2 gap-6">
        {/* Deposits */}
        <div className="space-y-2">
          <label className="text-xs text-gray-400 uppercase tracking-wider">
            Vault deposits
          </label>
          <VaultInput label={props.tokenX} value={form.vaultDepositX} onChange={props.onVaultDepositX} />
          <VaultInput label={props.tokenY} value={form.vaultDepositY} onChange={props.onVaultDepositY} />
          <VaultInput label={props.tokenZ} value={form.vaultDepositZ} onChange={props.onVaultDepositZ} />
        </div>

        {/* Debts */}
        <div className="space-y-2">
          <label className="text-xs text-gray-400 uppercase tracking-wider">
            Vault debts
          </label>
          <VaultInput label={props.tokenX} value={form.vaultDebtX} onChange={props.onVaultDebtX} />
          <VaultInput label={props.tokenY} value={form.vaultDebtY} onChange={props.onVaultDebtY} />
          <VaultInput label={props.tokenZ} value={form.vaultDebtZ} onChange={props.onVaultDebtZ} />
        </div>
      </div>

      {/* Impact panel */}
      {impact && (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-4 space-y-3">
          <h4 className="text-xs text-gray-400 uppercase tracking-wider">
            Impact on position
          </h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Health X (with vault): </span>
              <span className="font-mono text-gray-700">{fmtH(impact.hXWith)}</span>
              <span className="text-gray-400"> (without: {fmtH(impact.hXWithout)})</span>
            </div>
            <div>
              <span className="text-gray-400">Health Y (with vault): </span>
              <span className="font-mono text-gray-700">{fmtH(impact.hYWith)}</span>
              <span className="text-gray-400"> (without: {fmtH(impact.hYWithout)})</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Deposit value: </span>
              <span className="font-mono text-emerald-600">+{fmtUsd(impact.depositValue)}</span>
            </div>
            <div>
              <span className="text-gray-400">Debt value: </span>
              <span className="font-mono text-red-600">−{fmtUsd(impact.debtValue)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
