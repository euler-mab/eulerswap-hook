"use client";

import type { PoolState } from "@/lib/pools/types";
import { fmtAmount, fmtFeeBps, shortAddr } from "@/lib/pools/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-700">{children}</span>
    </>
  );
}

export default function StrategyPanel({ state }: { state: PoolState }) {
  const cxPct = (Number(state.concentrationX) / 1e18 * 100).toFixed(2);
  const cyPct = (Number(state.concentrationY) / 1e18 * 100).toFixed(2);

  return (
    <div className="space-y-6">
      {/* Current params */}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-gray-400 mb-2">
          Dynamic Params
        </h4>
        <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-2.5 text-sm">
          <Row label="Equilibrium reserves">
            {fmtAmount(state.equilibriumReserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
            {fmtAmount(state.equilibriumReserve1, state.asset1Decimals)} {state.asset1Symbol}
          </Row>
          <Row label="Min reserves">
            {fmtAmount(state.minReserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
            {fmtAmount(state.minReserve1, state.asset1Decimals)} {state.asset1Symbol}
          </Row>
          <Row label="Price X / Y">
            {state.priceX.toString()} / {state.priceY.toString()}
          </Row>
          <Row label="Concentration">
            {cxPct}% / {cyPct}%
          </Row>
          <Row label="Fees (pool)">
            {fmtFeeBps(state.fee0)} / {fmtFeeBps(state.fee1)}
          </Row>
          <Row label="Expiration">
            {state.expiration > 0
              ? new Date(state.expiration * 1000).toLocaleString()
              : "none"}
          </Row>
          <Row label="Hook">
            {state.swapHook === "0x0000000000000000000000000000000000000000"
              ? "none"
              : (
                <a
                  href={`https://etherscan.io/address/${state.swapHook}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-gray-500 hover:text-gray-900 transition-colors"
                >
                  {shortAddr(state.swapHook)} &nearr;
                </a>
              )}
          </Row>
        </div>
      </div>

      {/* Hook params */}
      {state.hookBaseFee !== undefined && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wider text-gray-400 mb-2">
            Hook Fee Params
          </h4>
          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-2.5 text-sm">
            <Row label="Base fee">{fmtFeeBps(state.hookBaseFee)}</Row>
            <Row label="Max fee">{fmtFeeBps(state.hookMaxFee!)}</Row>
            <Row label="Gas coeff">{state.hookGasCoeff!.toString()}</Row>
            <Row label="External fee">{fmtFeeBps(state.hookExternalFee!)}</Row>
            <Row label="Capture rate">{(Number(state.hookCaptureRate!) / 1e16).toFixed(1)}%</Row>
            <Row label="Attract rate">{(Number(state.hookAttractRate!) / 1e16).toFixed(1)}%</Row>
          </div>
        </div>
      )}

      {/* Static params */}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-gray-400 mb-2">
          Static Params
        </h4>
        <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-2.5 text-sm">
          <Row label="Euler account">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.eulerAccount)}</span>
          </Row>
          <Row label="Supply vault 0">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.supplyVault0)}</span>
          </Row>
          <Row label="Supply vault 1">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.supplyVault1)}</span>
          </Row>
          <Row label="Borrow vault 0">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.borrowVault0)}</span>
          </Row>
          <Row label="Borrow vault 1">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.borrowVault1)}</span>
          </Row>
          <Row label="Fee recipient">
            <span className="font-mono text-xs text-gray-500">{shortAddr(state.feeRecipient)}</span>
          </Row>
          <Row label="Installed">
            <span className={state.isInstalled ? "text-emerald-700" : "text-red-600"}>
              {state.isInstalled ? "yes" : "no"}
            </span>
          </Row>
        </div>
      </div>
    </div>
  );
}
