import { formatUnits } from "viem";
import type { Address } from "viem";
import type { PoolConfig } from "./config";
import type { PoolState, SwapEvent } from "./types";
import { fetchPricesAt, fetchCurrentPrices } from "./prices";

/** P&L attribution breakdown, all denominated in USD */
export interface PnlAttribution {
  /** Current NAV in USD */
  navUsd: number;
  /** Initial NAV in USD (at deploy-time prices) */
  initialNavUsd: number;
  /** Total P&L = navUsd - initialNavUsd */
  totalPnl: number;
  /** Accumulated swap fees in USD (valued at current prices) */
  feesUsd: number;
  /** Hodl value: what initial deposits would be worth at current prices */
  hodlValueUsd: number;
  /** Hodl delta: hodlValue - initialNav (pure price change on initial capital) */
  hodlDelta: number;
  /** LP cost: totalPnl - fees - hodlDelta (captures IL + net interest) */
  lpCost: number;
  /** Return percentage: totalPnl / initialNavUsd */
  returnPct: number;
  /** Price source used */
  priceSource: "defillama" | "oracle" | "marginal";
  /** Deploy-time token prices in USD */
  deployPrices: { asset0: number; asset1: number };
  /** Current token prices in USD */
  currentPrices: { asset0: number; asset1: number };
}

/**
 * Compute P&L attribution for a pool using DeFiLlama historical prices.
 *
 * Approach:
 * 1. Fetch deploy-time USD prices from DeFiLlama (replaces hardcoded initialPrice)
 * 2. Fetch current USD prices from DeFiLlama
 * 3. Compute initial NAV = deposits valued at deploy-time prices
 * 4. Compute current NAV = vault equity valued at current prices
 * 5. Attribute P&L: fees + hodl delta + LP cost (residual)
 */
export async function computePnl(
  pool: PoolConfig,
  state: PoolState,
  swaps: SwapEvent[],
  deployTimestamp: number,
): Promise<PnlAttribution> {
  const tokens = [state.asset0, state.asset1] as Address[];

  // Fetch deploy-time and current prices in parallel
  const [deployPriceMap, currentPriceMap] = await Promise.all([
    fetchPricesAt(tokens, deployTimestamp),
    fetchCurrentPrices(tokens),
  ]);

  const a0 = state.asset0.toLowerCase();
  const a1 = state.asset1.toLowerCase();

  const deployPrice0 = deployPriceMap.get(a0)?.price ?? 1;
  const deployPrice1 = deployPriceMap.get(a1)?.price ?? 1;
  const currentPrice0 = currentPriceMap.get(a0)?.price ?? 1;
  const currentPrice1 = currentPriceMap.get(a1)?.price ?? 1;

  // Initial deposits (from config, will eventually come from on-chain events)
  const initDep0 = pool.initialDeposit0 !== undefined
    ? Number(formatUnits(pool.initialDeposit0, state.asset0Decimals))
    : 0;
  const initDep1 = pool.initialDeposit1 !== undefined
    ? Number(formatUnits(pool.initialDeposit1, state.asset1Decimals))
    : 0;

  // Initial NAV at deploy-time prices (USD)
  const initialNavUsd = initDep0 * deployPrice0 + initDep1 * deployPrice1;

  // Current NAV from vault positions (USD)
  const dep0 = Number(formatUnits(state.vaultDeposit0, state.asset0Decimals));
  const dep1 = Number(formatUnits(state.vaultDeposit1, state.asset1Decimals));
  const dbt0 = Number(formatUnits(state.vaultDebt0, state.asset0Decimals));
  const dbt1 = Number(formatUnits(state.vaultDebt1, state.asset1Decimals));
  const navUsd = (dep0 - dbt0) * currentPrice0 + (dep1 - dbt1) * currentPrice1;

  // Total P&L
  const totalPnl = navUsd - initialNavUsd;

  // Accumulated fees (valued at current prices)
  let totalFee0 = 0;
  let totalFee1 = 0;
  for (const s of swaps) {
    totalFee0 += Number(formatUnits(s.fee0, state.asset0Decimals));
    totalFee1 += Number(formatUnits(s.fee1, state.asset1Decimals));
  }
  const feesUsd = totalFee0 * currentPrice0 + totalFee1 * currentPrice1;

  // Hodl value: what initial deposits would be worth at current prices
  const hodlValueUsd = initDep0 * currentPrice0 + initDep1 * currentPrice1;
  const hodlDelta = hodlValueUsd - initialNavUsd;

  // LP cost = residual (IL + net interest)
  const lpCost = totalPnl - feesUsd - hodlDelta;

  const returnPct = initialNavUsd > 0 ? totalPnl / initialNavUsd : 0;

  return {
    navUsd,
    initialNavUsd,
    totalPnl,
    feesUsd,
    hodlValueUsd,
    hodlDelta,
    lpCost,
    returnPct,
    priceSource: "defillama",
    deployPrices: { asset0: deployPrice0, asset1: deployPrice1 },
    currentPrices: { asset0: currentPrice0, asset1: currentPrice1 },
  };
}
