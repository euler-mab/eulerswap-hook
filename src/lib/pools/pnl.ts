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

/** Immutable deploy-time data (fetched once, never changes) */
export interface DeploySnapshot {
  timestamp: number;
  price0: number;
  price1: number;
  initDep0: number;
  initDep1: number;
  initialNavUsd: number;
}

/**
 * Fetch deploy-time prices and compute initial NAV. Called once per pool.
 */
export async function fetchDeploySnapshot(
  pool: PoolConfig,
  state: PoolState,
  deployTimestamp: number,
): Promise<DeploySnapshot> {
  const tokens = [state.asset0, state.asset1] as Address[];
  const priceMap = await fetchPricesAt(tokens, deployTimestamp);

  const a0 = state.asset0.toLowerCase();
  const a1 = state.asset1.toLowerCase();
  const price0 = priceMap.get(a0)?.price;
  const price1 = priceMap.get(a1)?.price;

  if (price0 === undefined || price1 === undefined) {
    throw new Error(`DeFiLlama missing deploy-time price for ${price0 === undefined ? state.asset0Symbol : state.asset1Symbol}`);
  }

  const initDep0 = pool.initialDeposit0 !== undefined
    ? Number(formatUnits(pool.initialDeposit0, state.asset0Decimals))
    : 0;
  const initDep1 = pool.initialDeposit1 !== undefined
    ? Number(formatUnits(pool.initialDeposit1, state.asset1Decimals))
    : 0;

  return {
    timestamp: deployTimestamp,
    price0,
    price1,
    initDep0,
    initDep1,
    initialNavUsd: initDep0 * price0 + initDep1 * price1,
  };
}

/**
 * Compute P&L attribution using cached deploy snapshot and fresh current prices.
 */
export async function computePnl(
  state: PoolState,
  swaps: SwapEvent[],
  deploy: DeploySnapshot,
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

  // Total P&L
  const totalPnl = navUsd - deploy.initialNavUsd;

  // Accumulated fees (valued at current prices)
  let totalFee0 = 0;
  let totalFee1 = 0;
  for (const s of swaps) {
    totalFee0 += Number(formatUnits(s.fee0, state.asset0Decimals));
    totalFee1 += Number(formatUnits(s.fee1, state.asset1Decimals));
  }
  const feesUsd = totalFee0 * currentPrice0 + totalFee1 * currentPrice1;

  // Hodl value: what initial deposits would be worth at current prices
  const hodlValueUsd = deploy.initDep0 * currentPrice0 + deploy.initDep1 * currentPrice1;
  const hodlDelta = hodlValueUsd - deploy.initialNavUsd;

  // LP cost = residual (IL + net interest)
  const lpCost = totalPnl - feesUsd - hodlDelta;

  const returnPct = deploy.initialNavUsd > 0 ? totalPnl / deploy.initialNavUsd : 0;

  return {
    navUsd,
    initialNavUsd: deploy.initialNavUsd,
    totalPnl,
    feesUsd,
    hodlValueUsd,
    hodlDelta,
    lpCost,
    returnPct,
    priceSource: "defillama",
    deployPrices: { asset0: deploy.price0, asset1: deploy.price1 },
    currentPrices: { asset0: currentPrice0, asset1: currentPrice1 },
  };
}
