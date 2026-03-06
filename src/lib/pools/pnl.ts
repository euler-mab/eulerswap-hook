import { formatUnits } from "viem";
import type { Address } from "viem";
import type { PoolState, SwapEvent, VaultFlow } from "./types";
import { fetchCurrentPrices, interpolatePrice, type PriceChartPoint } from "./prices";

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
  /** Rebalancing P&L from swap position shifts (positive = favorable, negative = adverse selection) */
  rebalUsd: number;
  /** Net vault interest (supply earned - borrow paid), computed as residual */
  interestUsd: number;
  /** Return percentage: totalPnl / netInvestedUsd */
  returnPct: number;
  /** Current token prices in USD */
  currentPrices: { asset0: number; asset1: number };
  /** Number of external capital flow events detected */
  flowCount: number;
  /** Number of swaps */
  swapCount: number;
  /** Total volume per asset (raw human units) */
  volume0: number;
  volume1: number;
  /** Total volume in USD (input side, at current prices) */
  volumeUsd: number;
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
 * Three-way attribution:
 *   fees     = swap fees earned (from event logs)
 *   rebal    = net position change from swaps (Σ(amountIn - amountOut) × price)
 *             amountIn excludes fee in EulerSwap events
 *             positive = favorable rebalancing, negative = adverse selection
 *   interest = residual: totalPnl - fees - rebal (net vault interest)
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

  // Accumulated fees and rebalancing from swap events (valued at current prices)
  let totalFee0 = 0;
  let totalFee1 = 0;
  let totalRebal0 = 0;
  let totalRebal1 = 0;
  let totalVol0 = 0;
  let totalVol1 = 0;
  let volIn0 = 0;
  let volIn1 = 0;
  for (const s of swaps) {
    const f0 = Number(formatUnits(s.fee0, state.asset0Decimals));
    const f1 = Number(formatUnits(s.fee1, state.asset1Decimals));
    const in0 = Number(formatUnits(s.amount0In, state.asset0Decimals));
    const out0 = Number(formatUnits(s.amount0Out, state.asset0Decimals));
    const in1 = Number(formatUnits(s.amount1In, state.asset1Decimals));
    const out1 = Number(formatUnits(s.amount1Out, state.asset1Decimals));
    totalFee0 += f0;
    totalFee1 += f1;
    // Rebalancing = net position change from swap (amountIn excludes fee in EulerSwap)
    totalRebal0 += (in0 - out0);
    totalRebal1 += (in1 - out1);
    // Volume: track total per asset (in + out) for raw display, input-only for USD
    totalVol0 += in0 + out0;
    totalVol1 += in1 + out1;
    volIn0 += in0;
    volIn1 += in1;
  }
  const feesUsd = totalFee0 * currentPrice0 + totalFee1 * currentPrice1;
  const rebalUsd = totalRebal0 * currentPrice0 + totalRebal1 * currentPrice1;
  // Volume USD: input side only to avoid double-counting
  const volumeUsd = volIn0 * currentPrice0 + volIn1 * currentPrice1;

  // Interest = residual (totalPnl - fees - rebalancing = net vault interest)
  const interestUsd = totalPnl - feesUsd - rebalUsd;

  const returnPct = netInvestedUsd > 0 ? totalPnl / netInvestedUsd : 0;

  return {
    navUsd,
    netInvestedUsd,
    totalPnl,
    feesUsd,
    rebalUsd,
    interestUsd,
    returnPct,
    currentPrices: { asset0: currentPrice0, asset1: currentPrice1 },
    flowCount: capital.flowCount,
    swapCount: swaps.length,
    volume0: totalVol0,
    volume1: totalVol1,
    volumeUsd,
  };
}

// ─── P&L Time Series ────────────────────────────────────────────────

/** A single data point in the P&L time series chart */
export interface PnlTimePoint {
  timestamp: number;
  /** Cumulative swap fees in USD (at historical prices) */
  cumulativeFeesUsd: number;
  /** Cumulative rebalancing P&L in USD (at historical prices) */
  cumulativeRebalUsd: number;
  /** Cumulative net swap P&L = fees + IL */
  cumulativeNetUsd: number;
  /** NAV estimate = post-swap reserves valued at historical prices */
  navEstimateUsd: number;
}

/**
 * Build a P&L time series from swap events and historical price charts.
 * Each data point corresponds to a swap event, with cumulative metrics
 * valued at the USD prices that prevailed at that time.
 */
export function buildPnlTimeSeries(
  swaps: SwapEvent[],
  chart0: PriceChartPoint[],
  chart1: PriceChartPoint[],
  asset0Decimals: number,
  asset1Decimals: number,
): PnlTimePoint[] {
  const points: PnlTimePoint[] = [];
  let cumFeeUsd = 0;
  let cumRebalUsd = 0;

  for (const s of swaps) {
    const ts = s.timestamp ?? 0;
    if (ts === 0) continue; // skip swaps without timestamps

    const p0 = interpolatePrice(chart0, ts);
    const p1 = interpolatePrice(chart1, ts);

    const f0 = Number(formatUnits(s.fee0, asset0Decimals));
    const f1 = Number(formatUnits(s.fee1, asset1Decimals));
    const in0 = Number(formatUnits(s.amount0In, asset0Decimals));
    const out0 = Number(formatUnits(s.amount0Out, asset0Decimals));
    const in1 = Number(formatUnits(s.amount1In, asset1Decimals));
    const out1 = Number(formatUnits(s.amount1Out, asset1Decimals));

    cumFeeUsd += f0 * p0 + f1 * p1;
    cumRebalUsd += (in0 - out0) * p0 + (in1 - out1) * p1;

    // NAV estimate from post-swap reserves
    const r0 = Number(formatUnits(s.reserve0, asset0Decimals));
    const r1 = Number(formatUnits(s.reserve1, asset1Decimals));
    const navEstimateUsd = r0 * p0 + r1 * p1;

    points.push({
      timestamp: ts,
      cumulativeFeesUsd: cumFeeUsd,
      cumulativeRebalUsd: cumRebalUsd,
      cumulativeNetUsd: cumFeeUsd + cumRebalUsd,
      navEstimateUsd,
    });
  }

  return points;
}

// ─── Time-Weighted Return ───────────────────────────────────────────

export interface TwrResult {
  /** Cumulative TWR (e.g. 0.05 = 5%) */
  twr: number;
  /** Annualized return */
  annualizedReturn: number;
  /** Duration in days from first flow to now */
  durationDays: number;
}

/**
 * Compute time-weighted return across capital flow events.
 *
 * Chains sub-period returns between flows:
 *   R_i = nav_before_flow_i / nav_after_flow_{i-1} - 1
 *   TWR = Π(1 + R_i) - 1
 *
 * Position at each flow timestamp is estimated from the most recent
 * swap event's post-swap reserves, valued at interpolated DeFiLlama prices.
 */
export function computeTwr(
  flows: VaultFlow[],
  swaps: SwapEvent[],
  chart0: PriceChartPoint[],
  chart1: PriceChartPoint[],
  asset0Decimals: number,
  asset1Decimals: number,
): TwrResult | null {
  if (flows.length === 0) return null;

  // Sort flows by timestamp (should already be sorted by block, but need timestamps)
  const timedFlows = flows
    .filter(f => f.timestamp !== undefined && f.timestamp > 0)
    .sort((a, b) => a.timestamp! - b.timestamp!);

  if (timedFlows.length === 0) return null;

  // Sort swaps by timestamp for binary search
  const timedSwaps = swaps
    .filter(s => s.timestamp !== undefined && s.timestamp > 0)
    .sort((a, b) => a.timestamp! - b.timestamp!);

  /** Estimate NAV at a given timestamp using most recent swap's reserves */
  function estimateNav(ts: number): number {
    const p0 = interpolatePrice(chart0, ts);
    const p1 = interpolatePrice(chart1, ts);

    // Find most recent swap before this timestamp
    let bestIdx = -1;
    for (let i = timedSwaps.length - 1; i >= 0; i--) {
      if (timedSwaps[i].timestamp! <= ts) { bestIdx = i; break; }
    }

    if (bestIdx >= 0) {
      const s = timedSwaps[bestIdx];
      const r0 = Number(formatUnits(s.reserve0, asset0Decimals));
      const r1 = Number(formatUnits(s.reserve1, asset1Decimals));
      return r0 * p0 + r1 * p1;
    }

    // No prior swap — use zero (before any activity)
    return 0;
  }

  /** Value a flow in USD at its timestamp */
  function flowUsd(f: VaultFlow): number {
    const p0 = interpolatePrice(chart0, f.timestamp!);
    const p1 = interpolatePrice(chart1, f.timestamp!);
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const price = f.vaultIndex === 0 ? p0 : p1;
    const signed = f.direction === "deposit" ? amount : -amount;
    return signed * price;
  }

  // Chain sub-period returns
  let twrProduct = 1;
  let navAfterPrev = 0;

  for (let i = 0; i < timedFlows.length; i++) {
    const flow = timedFlows[i];
    const navBefore = estimateNav(flow.timestamp!);
    const flowVal = flowUsd(flow);

    if (i > 0 && navAfterPrev > 0) {
      // Sub-period return: how did NAV grow from after previous flow to before this flow
      const subReturn = navBefore / navAfterPrev;
      twrProduct *= subReturn;
    }

    navAfterPrev = navBefore + flowVal;
  }

  // Final sub-period: from last flow to now
  const now = Math.floor(Date.now() / 1000);
  const navNow = estimateNav(now);
  if (navAfterPrev > 0) {
    twrProduct *= navNow / navAfterPrev;
  }

  const twr = twrProduct - 1;
  const firstTs = timedFlows[0].timestamp!;
  const durationDays = (now - firstTs) / 86400;
  const annualizedReturn = durationDays > 0 && 1 + twr > 0
    ? Math.pow(1 + twr, 365 / durationDays) - 1
    : twr;

  return { twr, annualizedReturn, durationDays };
}
