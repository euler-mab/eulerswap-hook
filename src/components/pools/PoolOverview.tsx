"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState } from "@/lib/pools/types";
import { fmtAmount, fmtFeeBps, fmtPrice, shortAddr, timeAgo } from "@/lib/pools/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-700">{children}</span>
    </>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${
      ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
    }`}>
      {label}
    </span>
  );
}

export default function PoolOverview({ state, pool }: { state: PoolState; pool: PoolConfig }) {
  const [inverted, setInverted] = useState(true); // default: show asset0/asset1 (e.g. USDC/WETH)
  const ethPrice = state.hookOraclePrice
    ? Number(formatUnits(state.hookOraclePrice, 6))
    : undefined;

  const r0 = Number(formatUnits(state.reserve0, state.asset0Decimals));
  const r1 = Number(formatUnits(state.reserve1, state.asset1Decimals));
  const tvl = ethPrice && state.asset0Symbol === "USDC"
    ? r0 + r1 * ethPrice
    : ethPrice && state.asset1Symbol === "USDC"
      ? r0 * ethPrice + r1
      : undefined;

  const agentEth = Number(formatUnits(state.agentEthBalance, 18));
  const agentT0 = Number(formatUnits(state.agentToken0Balance, state.asset0Decimals));
  const agentT1 = Number(formatUnits(state.agentToken1Balance, state.asset1Decimals));

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-2.5 text-sm">
      {/* Reserves */}
      <Row label="Reserves">
        {fmtAmount(state.reserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
        {fmtAmount(state.reserve1, state.asset1Decimals)} {state.asset1Symbol}
        {tvl !== undefined && <span className="text-gray-500 ml-1">(~${tvl.toFixed(2)})</span>}
      </Row>

      {/* Marginal price — click to flip direction */}
      <Row label="Marginal price">
        {state.marginalPrice > 0 ? (
          <button
            onClick={() => setInverted((v) => !v)}
            className="cursor-pointer hover:text-gray-900 transition-colors text-left"
            title="Click to flip price direction"
          >
            {inverted
              ? `${fmtPrice(1 / state.marginalPrice)} ${state.asset0Symbol}/${state.asset1Symbol}`
              : `${fmtPrice(state.marginalPrice)} ${state.asset1Symbol}/${state.asset0Symbol}`}
            <span className="text-gray-400 ml-1 text-xs">&#x21C5;</span>
          </button>
        ) : "—"}
      </Row>

      {/* Equilibrium price */}
      <Row label="Equilibrium price">
        {state.equilibriumPrice > 0 ? (
          <span>
            {inverted
              ? `${fmtPrice(1 / state.equilibriumPrice)} ${state.asset0Symbol}/${state.asset1Symbol}`
              : `${fmtPrice(state.equilibriumPrice)} ${state.asset1Symbol}/${state.asset0Symbol}`}
          </span>
        ) : "—"}
      </Row>

      {/* Oracle price */}
      {ethPrice !== undefined && (
        <Row label="Oracle price">
          {ethPrice.toFixed(2)} {state.asset0Symbol === "USDC" ? "USDC/WETH" : "USD"}
        </Row>
      )}

      {/* Hook status */}
      <Row label="Hook">
        {state.hookPaused !== undefined ? (
          <Badge ok={!state.hookPaused} label={state.hookPaused ? "paused" : "active"} />
        ) : (
          <span className="text-gray-400">none</span>
        )}
      </Row>

      {/* Live fees from hook.getFee */}
      {state.hookLiveFee0In !== undefined && (
        <Row label="Current fee">
          {fmtFeeBps(state.hookLiveFee0In)} ({state.asset0Symbol} in) / {fmtFeeBps(state.hookLiveFee1In!)} ({state.asset1Symbol} in)
          {state.hookDecaySurcharge !== undefined && state.hookLastTradeTimestamp !== undefined && state.hookLastTradeTimestamp > 0 && (
            <span className="text-gray-400 ml-1">
              (last trade {timeAgo(state.hookLastTradeTimestamp)})
            </span>
          )}
        </Row>
      )}

      {/* Pool base fees + hook config */}
      <Row label="Fee config">
        {fmtFeeBps(state.fee0)} / {fmtFeeBps(state.fee1)}
        {state.hookBaseFee !== undefined && (
          <span className="text-gray-500 ml-1">
            (hook: {fmtFeeBps(state.hookBaseFee)} base, {fmtFeeBps(state.hookMinFee!)} min, {fmtFeeBps(state.hookMaxFee!)} max)
          </span>
        )}
      </Row>

      {/* Trade stats */}
      {state.hookTradeCount !== undefined && (
        <Row label="Trades">
          {state.hookTradeCount.toString()} swaps
          {state.hookVolume0 !== undefined && (
            <span className="text-gray-500 ml-1">
              (vol: {fmtAmount(state.hookVolume0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
              {fmtAmount(state.hookVolume1!, state.asset1Decimals)} {state.asset1Symbol})
            </span>
          )}
        </Row>
      )}

      {/* Vault deposits */}
      {(state.vaultDeposit0 > 0n || state.vaultDeposit1 > 0n) && (
        <Row label="Vault deposits">
          {state.vaultDeposit0 > 0n && `${fmtAmount(state.vaultDeposit0, state.asset0Decimals)} ${state.asset0Symbol}`}
          {state.vaultDeposit0 > 0n && state.vaultDeposit1 > 0n && " + "}
          {state.vaultDeposit1 > 0n && `${fmtAmount(state.vaultDeposit1, state.asset1Decimals)} ${state.asset1Symbol}`}
        </Row>
      )}

      {/* Vault debts */}
      {(state.vaultDebt0 > 0n || state.vaultDebt1 > 0n) && (
        <Row label="Vault debts">
          {state.vaultDebt0 > 0n && `${fmtAmount(state.vaultDebt0, state.asset0Decimals)} ${state.asset0Symbol}`}
          {state.vaultDebt0 > 0n && state.vaultDebt1 > 0n && " + "}
          {state.vaultDebt1 > 0n && `${fmtAmount(state.vaultDebt1, state.asset1Decimals)} ${state.asset1Symbol}`}
        </Row>
      )}

      {/* Agent wallet */}
      <Row label="Agent wallet">
        {agentEth.toFixed(4)} ETH
        {agentT0 > 0 && ` + ${fmtAmount(state.agentToken0Balance, state.asset0Decimals)} ${state.asset0Symbol}`}
        {agentT1 > 0 && ` + ${fmtAmount(state.agentToken1Balance, state.asset1Decimals)} ${state.asset1Symbol}`}
      </Row>

      {/* Pool address */}
      <Row label="Pool">
        <a
          href={`https://etherscan.io/address/${pool.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-gray-500 hover:text-gray-900 transition-colors"
        >
          {shortAddr(pool.address)} &nearr;
        </a>
      </Row>

      {/* Expiration */}
      {state.expiration > 0 && (
        <Row label="Expiration">
          {new Date(state.expiration * 1000).toLocaleDateString()}
          {state.expiration * 1000 < Date.now() && <Badge ok={false} label="expired" />}
        </Row>
      )}
    </div>
  );
}
