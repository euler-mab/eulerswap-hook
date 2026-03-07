"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import type { PoolConfig } from "@/lib/pools/config";
import type { PoolState } from "@/lib/pools/types";
import type { PnlAttribution, TwrResult } from "@/lib/pools/pnl";
import { fmtAmount, fmtFeeBps, fmtPrice, fmtUsd, shortAddr } from "@/lib/pools/format";

function fmtVol(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-700">{children}</span>
    </>
  );
}

function PriceDiff({ marginal, other, inverted }: { marginal: number; other: number; inverted: boolean }) {
  if (other <= 0 || marginal <= 0) return null;
  // % diff in the displayed direction (inverted: displayed = 1/price)
  const pct = inverted ? (other / marginal - 1) * 100 : (marginal / other - 1) * 100;
  return (
    <span className="text-gray-400 ml-1 text-xs">
      ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
    </span>
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

interface OverviewProps {
  state: PoolState;
  pool: PoolConfig;
  pnl?: PnlAttribution | null;
  pnlError?: string | null;
  twrResult?: TwrResult | null;
}

export default function PoolOverview({ state, pool, pnl, pnlError, twrResult }: OverviewProps) {
  const [inverted, setInverted] = useState(true);
  const r0 = Number(formatUnits(state.reserve0, state.asset0Decimals));
  const r1 = Number(formatUnits(state.reserve1, state.asset1Decimals));

  const agentEth = Number(formatUnits(state.agentEthBalance, 18));
  const agentT0 = Number(formatUnits(state.agentToken0Balance, state.asset0Decimals));
  const agentT1 = Number(formatUnits(state.agentToken1Balance, state.asset1Decimals));

  // TVL uses DeFiLlama prices when available
  const tvl = pnl
    ? r0 * pnl.currentPrices.asset0 + r1 * pnl.currentPrices.asset1
    : undefined;

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-2.5 text-sm">
      {/* NAV + P&L */}
      <Row label="NAV">
        {pnl ? (
          <>
            <span className="text-gray-900 font-medium">{fmtUsd(pnl.navUsd)}</span>
            <span className={`ml-1.5 text-xs font-medium ${pnl.totalPnl >= 0 ? "text-emerald-700" : "text-red-700"}`}>
              {pnl.totalPnl >= 0 ? "+" : ""}{fmtUsd(pnl.totalPnl)}
              {pnl.netInvestedUsd > 0 && ` (${pnl.returnPct >= 0 ? "+" : ""}${(pnl.returnPct * 100).toFixed(2)}%)`}
            </span>
            <span className="text-gray-400 ml-1 text-xs">
              (invested {fmtUsd(pnl.netInvestedUsd)}, {pnl.flowCount} flows)
            </span>
            {twrResult && twrResult.durationDays > 1 && (
              <span className="text-gray-400 ml-1 text-xs">
                ({twrResult.annualizedReturn >= 0 ? "+" : ""}{(twrResult.annualizedReturn * 100).toFixed(1)}% ann., {Math.round(twrResult.durationDays)}d)
              </span>
            )}
          </>
        ) : (
          (() => {
            const dep0 = Number(formatUnits(state.vaultDeposit0, state.asset0Decimals));
            const dep1 = Number(formatUnits(state.vaultDeposit1, state.asset1Decimals));
            const dbt0 = Number(formatUnits(state.vaultDebt0, state.asset0Decimals));
            const dbt1 = Number(formatUnits(state.vaultDebt1, state.asset1Decimals));
            const a1InA0 = state.marginalPrice > 0 ? 1 / state.marginalPrice : 1;
            const nav = (dep0 - dbt0) + (dep1 - dbt1) * a1InA0;
            const isUsd = ["USDC", "USDT", "DAI"].includes(state.asset0Symbol);
            return (
              <span className="text-gray-900 font-medium">
                {isUsd ? fmtUsd(nav) : `${nav.toFixed(4)} ${state.asset0Symbol}`}
              </span>
            );
          })()
        )}
        {pnlError && <span className="text-red-500 ml-1 text-xs" title={pnlError}>price unavailable</span>}
      </Row>

      {/* P&L breakdown */}
      {pnl && (pnl.feesUsd > 0 || pnl.rebalUsd !== 0 || pnl.interestUsd !== 0) && (
        <Row label="P&L breakdown">
          <span className="text-xs space-x-3">
            {pnl.feesUsd > 0 && (
              <span className="text-emerald-700">
                fees +{fmtUsd(pnl.feesUsd)}
              </span>
            )}
            {pnl.rebalUsd !== 0 && (
              <span className={pnl.rebalUsd >= 0 ? "text-emerald-700" : "text-red-700"}>
                rebal {pnl.rebalUsd >= 0 ? "+" : ""}{fmtUsd(pnl.rebalUsd)}
              </span>
            )}
            {pnl.interestUsd !== 0 && (
              <span className={pnl.interestUsd >= 0 ? "text-emerald-700" : "text-red-700"}>
                interest {pnl.interestUsd >= 0 ? "+" : ""}{fmtUsd(pnl.interestUsd)}
              </span>
            )}
          </span>
        </Row>
      )}

      {/* Volume stats */}
      {pnl && pnl.swapCount > 0 && (
        <Row label="Volume">
          <span className="text-xs">
            <span className="text-gray-700">{fmtUsd(pnl.volumeUsd)}</span>
            <span className="text-gray-400 ml-1.5">
              ({pnl.swapCount} swaps, {fmtVol(pnl.volume0)} {state.asset0Symbol} + {fmtVol(pnl.volume1)} {state.asset1Symbol}
              {pnl.navUsd > 0 && `, ${(pnl.volumeUsd / pnl.navUsd).toFixed(1)}x NAV`})
            </span>
          </span>
        </Row>
      )}

      {/* Reserves */}
      <Row label="Reserves">
        {fmtAmount(state.reserve0, state.asset0Decimals)} {state.asset0Symbol} +{" "}
        {fmtAmount(state.reserve1, state.asset1Decimals)} {state.asset1Symbol}
        {tvl !== undefined && <span className="text-gray-500 ml-1">(~{fmtUsd(tvl)})</span>}
      </Row>

      {/* Trade limits */}
      {(state.limit0In > 0n || state.limit1In > 0n) && (
        <Row label="Trade limits">
          {fmtAmount(state.limit0In, state.asset0Decimals)} {state.asset0Symbol} in /{" "}
          {fmtAmount(state.limit1In, state.asset1Decimals)} {state.asset1Symbol} in
        </Row>
      )}

      {/* EulerSwap marginal price — click to flip direction */}
      <Row label="EulerSwap price">
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
            <PriceDiff marginal={state.marginalPrice} other={state.equilibriumPrice} inverted={inverted} />
          </span>
        ) : "—"}
      </Row>

      {/* Uniswap V3 oracle price (what the hook sees) */}
      {state.uniswapPrice !== undefined && state.uniswapPrice > 0 && (
        <Row label="Uniswap V3 price">
          {inverted
            ? `${fmtPrice(1 / state.uniswapPrice)} ${state.asset0Symbol}/${state.asset1Symbol}`
            : `${fmtPrice(state.uniswapPrice)} ${state.asset1Symbol}/${state.asset0Symbol}`}
          <PriceDiff marginal={state.marginalPrice} other={state.uniswapPrice} inverted={inverted} />
        </Row>
      )}

      {/* Uniswap V3 5-minute TWAP */}
      {state.twapPrice5m !== undefined && state.twapPrice5m > 0 && (
        <Row label="Uni V3 TWAP (5m)">
          {inverted
            ? `${fmtPrice(1 / state.twapPrice5m)} ${state.asset0Symbol}/${state.asset1Symbol}`
            : `${fmtPrice(state.twapPrice5m)} ${state.asset1Symbol}/${state.asset0Symbol}`}
          <PriceDiff marginal={state.marginalPrice} other={state.twapPrice5m} inverted={inverted} />
        </Row>
      )}

      {/* DeFiLlama price cross-reference */}
      {pnl && pnl.currentPrices.asset0 > 0 && pnl.currentPrices.asset1 > 0 && (
        <Row label="DeFiLlama price">
          {inverted
            ? `${fmtPrice(pnl.currentPrices.asset1 / pnl.currentPrices.asset0)} ${state.asset0Symbol}/${state.asset1Symbol}`
            : `${fmtPrice(pnl.currentPrices.asset0 / pnl.currentPrices.asset1)} ${state.asset1Symbol}/${state.asset0Symbol}`}
          <PriceDiff marginal={state.marginalPrice} other={pnl.currentPrices.asset0 / pnl.currentPrices.asset1} inverted={inverted} />
        </Row>
      )}

      {/* Arb estimate (computeQuote-based) */}
      {state.arbProbe && (() => {
        const { direction, bestProfitUsd, bestTradeUsd, gasCostUsd, edgeBps } = state.arbProbe;
        const gasGwei = Number(state.gasPrice) / 1e9;
        const profitable = bestProfitUsd > 0;

        return (
          <Row label="Arb estimate">
            <span className="text-xs">
              <span className={`font-medium ${profitable ? "text-emerald-700" : bestTradeUsd > 0 ? "text-red-600" : "text-gray-400"}`}>
                {bestTradeUsd > 0
                  ? `${bestProfitUsd >= 0 ? "+" : ""}${fmtUsd(bestProfitUsd)}`
                  : "no edge"}
              </span>
              <span className="text-gray-400 ml-1.5">
                ({direction}
                {bestTradeUsd > 0 && ` — ${edgeBps.toFixed(1)} bps edge, ${fmtUsd(bestTradeUsd)} optimal`}
                {`, ${fmtUsd(gasCostUsd)} gas @ ${gasGwei.toFixed(3)} gwei`})
              </span>
            </span>
          </Row>
        );
      })()}

      {/* Hook status */}
      <Row label="Hook">
        {state.hookBaseFee !== undefined ? (
          <Badge ok={true} label="active" />
        ) : (
          <span className="text-gray-400">none</span>
        )}
      </Row>

      {/* Live fees from hook.getFee */}
      {state.hookLiveFee0In !== undefined && (
        <Row label="Current fee">
          {fmtFeeBps(state.hookLiveFee0In)} ({state.asset0Symbol} in) / {fmtFeeBps(state.hookLiveFee1In!)} ({state.asset1Symbol} in)
        </Row>
      )}

      {/* Pool base fees + hook config */}
      <Row label="Fee config">
        {fmtFeeBps(state.fee0)} / {fmtFeeBps(state.fee1)}
        {state.hookBaseFee !== undefined && (
          <span className="text-gray-500 ml-1">
            (hook: {fmtFeeBps(state.hookBaseFee)} base, {fmtFeeBps(state.hookMaxFee!)} max
            {state.hookCaptureRate !== undefined && `, ${(Number(state.hookCaptureRate) / 1e16).toFixed(0)}% capture`}
            {state.hookAttractRate !== undefined && Number(state.hookAttractRate) > 0 && `, ${(Number(state.hookAttractRate) / 1e16).toFixed(0)}% attract`})
          </span>
        )}
      </Row>

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
