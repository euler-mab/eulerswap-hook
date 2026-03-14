import { formatUnits } from "viem";
import type { Address } from "viem";
import type { PoolState, SwapEvent, VaultFlow } from "./types";
import { fetchCurrentPrices, interpolatePrice, type PriceChartPoint } from "./prices";

/**
 * Equity effect of a vault event:
 *   deposit  → equity + (supply increases)
 *   withdraw → equity - (supply decreases)
 *   borrow   → equity - (debt increases)
 *   repay    → equity + (debt decreases)
 */
function equitySign(op: VaultFlow["operation"]): number {
  switch (op) {
    case "deposit": return +1;
    case "withdraw": return -1;
    case "borrow": return -1;
    case "repay": return +1;
  }
}

/** P&L attribution breakdown, all denominated in USD */
export interface PnlAttribution {
  /** Current NAV in USD */
  navUsd: number;
  /** Total external capital deployed in USD at current prices */
  netInvestedUsd: number;
  /** Value of deposited assets at the time of deposit (cost basis) */
  depositedNavUsd: number;
  /** Total P&L = navUsd - netInvestedUsd */
  totalPnl: number;
  /** Accumulated swap fees in USD (valued at current prices) */
  feesUsd: number;
  /** Swap rebalancing P&L (IL from pool swaps, valued at current prices) */
  swapRebalUsd: number;
  /** External rebalancing P&L (cost of DEX rebalancing txs, valued at current prices) */
  extRebalUsd: number;
  /** Net vault interest (residual: totalPnl - fees - swapRebal - extRebal) */
  interestUsd: number;
  /** Return percentage: totalPnl / netInvestedUsd */
  returnPct: number;
  /** Current token prices in USD */
  currentPrices: { asset0: number; asset1: number };
  /** Number of external capital flow events */
  flowCount: number;
  /** Number of external rebalancing events */
  extRebalCount: number;
  /** Number of swaps */
  swapCount: number;
  /** Total volume per asset (raw human units) */
  volume0: number;
  volume1: number;
  /** Total volume in USD (input side, at current prices) */
  volumeUsd: number;
  /** Current ETH price in USD (always fetched, for wallet display) */
  ethPrice: number;
  /** Pool age in days (from deploy timestamp to now) */
  poolAgeDays: number;
}

/** Cached capital flow data (fetched once, immutable) */
export interface CapitalSnapshot {
  /** Net external capital per asset (equity effect of pure capital flows) */
  extCap0: number;
  extCap1: number;
  /** Net external rebalancing per asset (equity effect of rebalancing txs) */
  extRebal0: number;
  extRebal1: number;
  /** Number of external capital events */
  capitalFlowCount: number;
  /** Number of external rebalancing events */
  rebalFlowCount: number;
}

/**
 * Build capital snapshot from non-swap vault events.
 *
 * Categorizes events into external capital vs external rebalancing:
 * - External capital: txs that only touch one vault with one-directional ops (pure deposits/withdrawals)
 * - External rebalancing: txs that touch both vaults or mix supply+debt ops (DEX rebalancing, reconfigurations)
 */
export function buildCapitalSnapshot(
  flows: VaultFlow[],
  asset0Decimals: number,
  asset1Decimals: number,
): CapitalSnapshot {
  // Group by tx hash
  const byTx = new Map<string, VaultFlow[]>();
  for (const f of flows) {
    const arr = byTx.get(f.transactionHash) ?? [];
    arr.push(f);
    byTx.set(f.transactionHash, arr);
  }

  let extCap0 = 0, extCap1 = 0;
  let extRebal0 = 0, extRebal1 = 0;
  let capitalFlowCount = 0, rebalFlowCount = 0;

  for (const [, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    const touchesBothVaults = vaults.size > 1;
    const mixesSupplyAndDebt =
      (ops.has("deposit") || ops.has("withdraw")) &&
      (ops.has("borrow") || ops.has("repay"));
    const isRebal = touchesBothVaults || mixesSupplyAndDebt;

    for (const ev of txEvents) {
      const decimals = ev.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
      const amount = Number(formatUnits(ev.assets, decimals));
      const signed = amount * equitySign(ev.operation);

      if (isRebal) {
        if (ev.vaultIndex === 0) extRebal0 += signed;
        else extRebal1 += signed;
        rebalFlowCount++;
      } else {
        if (ev.vaultIndex === 0) extCap0 += signed;
        else extCap1 += signed;
        capitalFlowCount++;
      }
    }
  }

  return { extCap0, extCap1, extRebal0, extRebal1, capitalFlowCount, rebalFlowCount };
}

/**
 * Compute cost basis: value of each external capital flow at its historical USD price.
 * Only includes pure capital flows (not rebalancing).
 */
export function computeCostBasis(
  flows: VaultFlow[],
  chart0: PriceChartPoint[],
  chart1: PriceChartPoint[],
  asset0Decimals: number,
  asset1Decimals: number,
): number {
  // Group by tx to identify capital vs rebal (same logic as buildCapitalSnapshot)
  const byTx = new Map<string, VaultFlow[]>();
  for (const f of flows) {
    const arr = byTx.get(f.transactionHash) ?? [];
    arr.push(f);
    byTx.set(f.transactionHash, arr);
  }

  const capitalTxs = new Set<string>();
  for (const [txHash, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    const isRebal = vaults.size > 1 ||
      ((ops.has("deposit") || ops.has("withdraw")) && (ops.has("borrow") || ops.has("repay")));
    if (!isRebal) capitalTxs.add(txHash);
  }

  let total = 0;
  for (const f of flows) {
    if (!f.timestamp || !capitalTxs.has(f.transactionHash)) continue;
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const price = f.vaultIndex === 0
      ? interpolatePrice(chart0, f.timestamp)
      : interpolatePrice(chart1, f.timestamp);
    const signed = amount * equitySign(f.operation);
    total += signed * price;
  }
  return total;
}

/**
 * Compute P&L attribution using on-chain capital flows and current prices.
 *
 * 4-way decomposition:
 *   fees       = swap fees earned (from Swap event logs)
 *   swapRebal  = net position change from swaps (IL/adverse selection)
 *   extRebal   = net equity change from non-swap vault operations (DEX rebalancing)
 *   interest   = residual: totalPnl - fees - swapRebal - extRebal (net vault interest)
 */
export async function computePnl(
  state: PoolState,
  swaps: SwapEvent[],
  capital: CapitalSnapshot,
  costBasisUsd = 0,
  poolAgeDays = 0,
): Promise<PnlAttribution> {
  const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address;
  const tokenSet = new Set([state.asset0.toLowerCase(), state.asset1.toLowerCase(), WETH.toLowerCase()]);
  const tokens = [...tokenSet].map(t => t as Address);
  const currentPriceMap = await fetchCurrentPrices(tokens);

  const a0 = state.asset0.toLowerCase();
  const a1 = state.asset1.toLowerCase();
  const currentPrice0 = currentPriceMap.get(a0)?.price;
  const currentPrice1 = currentPriceMap.get(a1)?.price;
  const ethPrice = currentPriceMap.get(WETH.toLowerCase())?.price ?? 0;

  if (currentPrice0 === undefined || currentPrice1 === undefined) {
    throw new Error(`DeFiLlama missing current price for ${currentPrice0 === undefined ? state.asset0Symbol : state.asset1Symbol}`);
  }

  // Current NAV from vault positions (USD)
  const dep0 = Number(formatUnits(state.vaultDeposit0, state.asset0Decimals));
  const dep1 = Number(formatUnits(state.vaultDeposit1, state.asset1Decimals));
  const dbt0 = Number(formatUnits(state.vaultDebt0, state.asset0Decimals));
  const dbt1 = Number(formatUnits(state.vaultDebt1, state.asset1Decimals));
  const navUsd = (dep0 - dbt0) * currentPrice0 + (dep1 - dbt1) * currentPrice1;

  // Net invested = external capital equity effect at current prices
  const netInvestedUsd = capital.extCap0 * currentPrice0 + capital.extCap1 * currentPrice1;

  // Total P&L
  const totalPnl = navUsd - netInvestedUsd;

  // Accumulated fees and rebalancing from swap events (valued at current prices)
  let totalFee0 = 0, totalFee1 = 0;
  let swapRebal0 = 0, swapRebal1 = 0;
  let totalVol0 = 0, totalVol1 = 0;
  let volIn0 = 0, volIn1 = 0;
  for (const s of swaps) {
    const f0 = Number(formatUnits(s.fee0, state.asset0Decimals));
    const f1 = Number(formatUnits(s.fee1, state.asset1Decimals));
    const in0 = Number(formatUnits(s.amount0In, state.asset0Decimals));
    const out0 = Number(formatUnits(s.amount0Out, state.asset0Decimals));
    const in1 = Number(formatUnits(s.amount1In, state.asset1Decimals));
    const out1 = Number(formatUnits(s.amount1Out, state.asset1Decimals));
    totalFee0 += f0;
    totalFee1 += f1;
    swapRebal0 += (in0 - out0);
    swapRebal1 += (in1 - out1);
    totalVol0 += in0 + out0;
    totalVol1 += in1 + out1;
    volIn0 += in0;
    volIn1 += in1;
  }
  const feesUsd = totalFee0 * currentPrice0 + totalFee1 * currentPrice1;
  const swapRebalUsd = swapRebal0 * currentPrice0 + swapRebal1 * currentPrice1;
  const extRebalUsd = capital.extRebal0 * currentPrice0 + capital.extRebal1 * currentPrice1;
  const volumeUsd = volIn0 * currentPrice0 + volIn1 * currentPrice1;

  // Interest = residual after all tracked components
  const interestUsd = totalPnl - feesUsd - swapRebalUsd - extRebalUsd;

  const returnPct = netInvestedUsd > 0 ? totalPnl / netInvestedUsd : 0;

  return {
    navUsd,
    netInvestedUsd,
    depositedNavUsd: costBasisUsd,
    totalPnl,
    feesUsd,
    swapRebalUsd,
    extRebalUsd,
    interestUsd,
    returnPct,
    currentPrices: { asset0: currentPrice0, asset1: currentPrice1 },
    flowCount: capital.capitalFlowCount,
    extRebalCount: capital.rebalFlowCount,
    swapCount: swaps.length,
    volume0: totalVol0,
    volume1: totalVol1,
    volumeUsd,
    ethPrice,
    poolAgeDays,
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
 * Compute time-weighted return across external capital flow events.
 * Only uses pure capital flows (not rebalancing) for TWR calculation.
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
  // Filter to capital-only flows (exclude rebalancing txs)
  const byTx = new Map<string, VaultFlow[]>();
  for (const f of flows) {
    const arr = byTx.get(f.transactionHash) ?? [];
    arr.push(f);
    byTx.set(f.transactionHash, arr);
  }
  const capitalTxs = new Set<string>();
  for (const [txHash, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    const isRebal = vaults.size > 1 ||
      ((ops.has("deposit") || ops.has("withdraw")) && (ops.has("borrow") || ops.has("repay")));
    if (!isRebal) capitalTxs.add(txHash);
  }

  const capitalFlows = flows.filter(f => capitalTxs.has(f.transactionHash));
  if (capitalFlows.length === 0) return null;

  // Sort flows by timestamp
  const timedFlows = capitalFlows
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

  /** Value a capital flow's equity effect in USD at its timestamp */
  function flowUsd(f: VaultFlow): number {
    const p0 = interpolatePrice(chart0, f.timestamp!);
    const p1 = interpolatePrice(chart1, f.timestamp!);
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const price = f.vaultIndex === 0 ? p0 : p1;
    return amount * equitySign(f.operation) * price;
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
