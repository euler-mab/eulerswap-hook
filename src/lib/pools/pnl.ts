import { formatUnits } from "viem";
import type { Address } from "viem";
import type { PoolState, SwapEvent, VaultFlow } from "./types";
import { fetchCurrentPrices } from "./prices";

/** P&L attribution breakdown, all denominated in USD */
export interface PnlAttribution {
  /** Current NAV in USD */
  navUsd: number;
  /** Total external capital deployed (deposits - withdrawals) in USD at current prices */
  netInvestedUsd: number;
  /** Total P&L = navUsd - netInvestedUsd */
  totalPnl: number;
  /** Accumulated swap fees in USD (valued at current prices) */
  feesUsd: number;
  /** LP cost: totalPnl - fees (captures IL + net interest - price change on equity) */
  lpCost: number;
  /** Return percentage: totalPnl / netInvestedUsd */
  returnPct: number;
  /** Current token prices in USD */
  currentPrices: { asset0: number; asset1: number };
  /** Number of external capital flow events detected */
  flowCount: number;
}

/** Cached capital flow data (fetched once, immutable) */
export interface CapitalSnapshot {
  /** Net external deposits per asset (deposits - withdrawals) in raw human units */
  netDeposit0: number;
  netDeposit1: number;
  /** Number of flow events */
  flowCount: number;
}

/**
 * Build capital snapshot from on-chain vault flow events.
 * Nets deposits and withdrawals per asset.
 */
export function buildCapitalSnapshot(
  flows: VaultFlow[],
  asset0Decimals: number,
  asset1Decimals: number,
): CapitalSnapshot {
  let netDeposit0 = 0;
  let netDeposit1 = 0;

  for (const f of flows) {
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const signed = f.direction === "deposit" ? amount : -amount;

    if (f.vaultIndex === 0) netDeposit0 += signed;
    else netDeposit1 += signed;
  }

  return { netDeposit0, netDeposit1, flowCount: flows.length };
}

/**
 * Compute P&L attribution using on-chain capital flows and current prices.
 *
 * P&L = NAV - netInvested
 *     = (vaultEquity × currentPrices) - (netDeposits × currentPrices)
 *
 * Attribution:
 *   fees    = swap fees earned (from event logs)
 *   lpCost  = totalPnl - fees (residual: IL + net interest + price impact)
 */
export async function computePnl(
  state: PoolState,
  swaps: SwapEvent[],
  capital: CapitalSnapshot,
): Promise<PnlAttribution> {
  const tokens = [state.asset0, state.asset1] as Address[];
  const currentPriceMap = await fetchCurrentPrices(tokens);

  const a0 = state.asset0.toLowerCase();
  const a1 = state.asset1.toLowerCase();
  const currentPrice0 = currentPriceMap.get(a0)?.price;
  const currentPrice1 = currentPriceMap.get(a1)?.price;

  if (currentPrice0 === undefined || currentPrice1 === undefined) {
    throw new Error(`DeFiLlama missing current price for ${currentPrice0 === undefined ? state.asset0Symbol : state.asset1Symbol}`);
  }

  // Current NAV from vault positions (USD)
  const dep0 = Number(formatUnits(state.vaultDeposit0, state.asset0Decimals));
  const dep1 = Number(formatUnits(state.vaultDeposit1, state.asset1Decimals));
  const dbt0 = Number(formatUnits(state.vaultDebt0, state.asset0Decimals));
  const dbt1 = Number(formatUnits(state.vaultDebt1, state.asset1Decimals));
  const navUsd = (dep0 - dbt0) * currentPrice0 + (dep1 - dbt1) * currentPrice1;

  // Net invested = external capital in - external capital out (at current prices)
  const netInvestedUsd = capital.netDeposit0 * currentPrice0 + capital.netDeposit1 * currentPrice1;

  // Total P&L
  const totalPnl = navUsd - netInvestedUsd;

  // Accumulated fees (valued at current prices)
  let totalFee0 = 0;
  let totalFee1 = 0;
  for (const s of swaps) {
    totalFee0 += Number(formatUnits(s.fee0, state.asset0Decimals));
    totalFee1 += Number(formatUnits(s.fee1, state.asset1Decimals));
  }
  const feesUsd = totalFee0 * currentPrice0 + totalFee1 * currentPrice1;

  // LP cost = residual (IL + net interest + any untracked flows)
  const lpCost = totalPnl - feesUsd;

  const returnPct = netInvestedUsd > 0 ? totalPnl / netInvestedUsd : 0;

  return {
    navUsd,
    netInvestedUsd,
    totalPnl,
    feesUsd,
    lpCost,
    returnPct,
    currentPrices: { asset0: currentPrice0, asset1: currentPrice1 },
    flowCount: capital.flowCount,
  };
}
