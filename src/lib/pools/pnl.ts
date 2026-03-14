import { formatUnits } from "viem";
import type { Address } from "viem";
import type { PoolState, SwapEvent, VaultFlow } from "./types";
import { fetchCurrentPrices } from "./prices";

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

/**
 * Compute exact vault interest per asset from ALL vault events (including swap-induced).
 *
 * Interest = current_position - Σ(all_flows):
 *   supply_interest = current_deposits - Σ(deposits) + Σ(withdrawals)
 *   borrow_interest = current_debt - Σ(borrows) + Σ(repays)
 *   net_interest = supply_interest - borrow_interest
 *
 * This is exact — no residual, no price dependency at the asset level.
 */
export function computeVaultInterest(
  allVaultEvents: VaultFlow[],
  currentDeposit0: number,
  currentDeposit1: number,
  currentDebt0: number,
  currentDebt1: number,
  asset0Decimals: number,
  asset1Decimals: number,
): { interest0: number; interest1: number } {
  let netDeposits0 = 0, netDeposits1 = 0;
  let netBorrows0 = 0, netBorrows1 = 0;

  for (const ev of allVaultEvents) {
    const decimals = ev.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(ev.assets, decimals));

    if (ev.vaultIndex === 0) {
      if (ev.operation === "deposit") netDeposits0 += amount;
      else if (ev.operation === "withdraw") netDeposits0 -= amount;
      else if (ev.operation === "borrow") netBorrows0 += amount;
      else if (ev.operation === "repay") netBorrows0 -= amount;
    } else {
      if (ev.operation === "deposit") netDeposits1 += amount;
      else if (ev.operation === "withdraw") netDeposits1 -= amount;
      else if (ev.operation === "borrow") netBorrows1 += amount;
      else if (ev.operation === "repay") netBorrows1 -= amount;
    }
  }

  // Interest = current position minus what position would be from just the flows
  return {
    interest0: (currentDeposit0 - netDeposits0) - (currentDebt0 - netBorrows0),
    interest1: (currentDeposit1 - netDeposits1) - (currentDebt1 - netBorrows1),
  };
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
  /** Accumulated swap fees in USD (valued at per-block Uniswap prices) */
  feesUsd: number;
  /** Swap rebalancing P&L (IL/adverse selection, valued at per-block prices) */
  swapRebalUsd: number;
  /** External rebalancing P&L (cost of DEX rebalancing txs, valued at per-block prices) */
  extRebalUsd: number;
  /** Net vault interest: exact per-asset computation, valued at current prices */
  interestUsd: number;
  /** Mark-to-market: residual from valuing historical positions at current vs historical prices */
  markToMarketUsd: number;
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
 * Uses per-block Uniswap prices (USDC ≈ $1, WETH from oracle).
 * Only includes pure capital flows (not rebalancing).
 */
export function computeCostBasis(
  flows: VaultFlow[],
  blockPrices: Map<bigint, number>,
  asset0Decimals: number,
  asset1Decimals: number,
  fallbackEthPrice = 0,
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
    if (!capitalTxs.has(f.transactionHash)) continue;
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const price = f.vaultIndex === 0
      ? 1 // USDC ≈ $1
      : (blockPrices.get(f.blockNumber) ?? fallbackEthPrice);
    const signed = amount * equitySign(f.operation);
    total += signed * price;
  }
  return total;
}

/**
 * Compute P&L attribution using on-chain events and per-block Uniswap prices.
 *
 * 5-way decomposition:
 *   fees         = swap fees earned (valued at per-block Uniswap prices)
 *   swapRebal    = IL/adverse selection from swaps (valued at per-block prices)
 *   extRebal     = cost of DEX rebalancing txs (valued at per-block prices)
 *   interest     = exact vault interest (per-asset computation, valued at current prices)
 *   markToMarket = residual: price changes on accumulated positions
 */
export async function computePnl(
  state: PoolState,
  swaps: SwapEvent[],
  capital: CapitalSnapshot,
  nonSwapFlows: VaultFlow[],
  blockPrices: Map<bigint, number>,
  interest: { interest0: number; interest1: number },
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

  // Cost basis: external capital valued at historical prices
  // For capital flows, USDC ≈ $1, WETH = block price
  const netInvestedUsd = costBasisUsd;

  // Total P&L
  const totalPnl = navUsd - netInvestedUsd;

  // Helper: get price pair at a block (USDC ≈ $1, WETH from Uniswap oracle)
  const priceAt = (block: bigint): [number, number] => {
    const wethPrice = blockPrices.get(block);
    return [1, wethPrice ?? ethPrice]; // fallback to current ETH price
  };

  // Accumulated fees and rebalancing from swap events (valued at per-block prices)
  let feesUsd = 0;
  let swapRebalUsd = 0;
  let totalVol0 = 0, totalVol1 = 0;
  let volIn0 = 0, volIn1 = 0;
  for (const s of swaps) {
    const [p0, p1] = priceAt(s.blockNumber);
    const f0 = Number(formatUnits(s.fee0, state.asset0Decimals));
    const f1 = Number(formatUnits(s.fee1, state.asset1Decimals));
    const in0 = Number(formatUnits(s.amount0In, state.asset0Decimals));
    const out0 = Number(formatUnits(s.amount0Out, state.asset0Decimals));
    const in1 = Number(formatUnits(s.amount1In, state.asset1Decimals));
    const out1 = Number(formatUnits(s.amount1Out, state.asset1Decimals));
    feesUsd += f0 * p0 + f1 * p1;
    swapRebalUsd += (in0 - out0) * p0 + (in1 - out1) * p1;
    totalVol0 += in0 + out0;
    totalVol1 += in1 + out1;
    volIn0 += in0;
    volIn1 += in1;
  }

  // External rebalancing valued at per-block prices
  // Classify flows same way as buildCapitalSnapshot
  const byTx = new Map<string, VaultFlow[]>();
  for (const f of nonSwapFlows) {
    const arr = byTx.get(f.transactionHash) ?? [];
    arr.push(f);
    byTx.set(f.transactionHash, arr);
  }
  let extRebalUsd = 0;
  for (const [, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    const isRebal = vaults.size > 1 ||
      ((ops.has("deposit") || ops.has("withdraw")) && (ops.has("borrow") || ops.has("repay")));
    if (!isRebal) continue;
    for (const ev of txEvents) {
      const [p0, p1] = priceAt(ev.blockNumber);
      const decimals = ev.vaultIndex === 0 ? state.asset0Decimals : state.asset1Decimals;
      const amount = Number(formatUnits(ev.assets, decimals));
      const price = ev.vaultIndex === 0 ? p0 : p1;
      extRebalUsd += amount * equitySign(ev.operation) * price;
    }
  }

  // Volume in current USD (for display)
  const volumeUsd = volIn0 * currentPrice0 + volIn1 * currentPrice1;

  // Interest: exact per-asset computation, valued at current prices
  const interestUsd = interest.interest0 * currentPrice0 + interest.interest1 * currentPrice1;

  // Mark-to-market: residual captures price changes on accumulated positions
  const markToMarketUsd = totalPnl - feesUsd - swapRebalUsd - extRebalUsd - interestUsd;

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
    markToMarketUsd,
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
 * Build a P&L time series from swap events and per-block Uniswap prices.
 * Each data point corresponds to a swap event, with cumulative metrics
 * valued at the on-chain prices that prevailed at that block.
 */
export function buildPnlTimeSeries(
  swaps: SwapEvent[],
  blockPrices: Map<bigint, number>,
  asset0Decimals: number,
  asset1Decimals: number,
  fallbackEthPrice = 0,
): PnlTimePoint[] {
  const points: PnlTimePoint[] = [];
  let cumFeeUsd = 0;
  let cumRebalUsd = 0;

  for (const s of swaps) {
    const ts = s.timestamp ?? 0;
    if (ts === 0) continue; // skip swaps without timestamps

    const p0 = 1; // USDC ≈ $1
    const p1 = blockPrices.get(s.blockNumber) ?? fallbackEthPrice;

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
 * Uses per-block Uniswap prices for exact valuation.
 *
 * Chains sub-period returns between flows:
 *   R_i = nav_before_flow_i / nav_after_flow_{i-1} - 1
 *   TWR = Π(1 + R_i) - 1
 *
 * Position at each flow is estimated from the most recent swap's
 * post-swap reserves, valued at per-block Uniswap prices.
 */
export function computeTwr(
  flows: VaultFlow[],
  swaps: SwapEvent[],
  blockPrices: Map<bigint, number>,
  asset0Decimals: number,
  asset1Decimals: number,
  fallbackEthPrice = 0,
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

  // Sort flows by block number
  const sortedFlows = [...capitalFlows].sort((a, b) =>
    Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex
  );

  // Sort swaps by block number for lookup
  const sortedSwaps = [...swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber));

  /** Estimate NAV at a given block using most recent swap's reserves */
  function estimateNav(block: bigint): number {
    const p0 = 1; // USDC ≈ $1
    const p1 = blockPrices.get(block) ?? fallbackEthPrice;

    // Find most recent swap at or before this block
    let bestIdx = -1;
    for (let i = sortedSwaps.length - 1; i >= 0; i--) {
      if (sortedSwaps[i].blockNumber <= block) { bestIdx = i; break; }
    }

    if (bestIdx >= 0) {
      const s = sortedSwaps[bestIdx];
      const r0 = Number(formatUnits(s.reserve0, asset0Decimals));
      const r1 = Number(formatUnits(s.reserve1, asset1Decimals));
      return r0 * p0 + r1 * p1;
    }

    return 0;
  }

  /** Value a capital flow's equity effect in USD at its block */
  function flowUsd(f: VaultFlow): number {
    const p0 = 1;
    const p1 = blockPrices.get(f.blockNumber) ?? fallbackEthPrice;
    const decimals = f.vaultIndex === 0 ? asset0Decimals : asset1Decimals;
    const amount = Number(formatUnits(f.assets, decimals));
    const price = f.vaultIndex === 0 ? p0 : p1;
    return amount * equitySign(f.operation) * price;
  }

  // Chain sub-period returns
  let twrProduct = 1;
  let navAfterPrev = 0;

  for (let i = 0; i < sortedFlows.length; i++) {
    const flow = sortedFlows[i];
    const navBefore = estimateNav(flow.blockNumber);
    const flowVal = flowUsd(flow);

    if (i > 0 && navAfterPrev > 0) {
      const subReturn = navBefore / navAfterPrev;
      twrProduct *= subReturn;
    }

    navAfterPrev = navBefore + flowVal;
  }

  // Final sub-period: use current block price
  const currentNav = estimateNav(sortedSwaps.length > 0 ? sortedSwaps[sortedSwaps.length - 1].blockNumber : 0n);
  if (navAfterPrev > 0 && currentNav > 0) {
    twrProduct *= currentNav / navAfterPrev;
  }

  const twr = twrProduct - 1;
  const firstTs = sortedFlows[0].timestamp;
  const now = Math.floor(Date.now() / 1000);
  const durationDays = firstTs ? (now - firstTs) / 86400 : 0;
  const annualizedReturn = durationDays > 0 && 1 + twr > 0
    ? Math.pow(1 + twr, 365 / durationDays) - 1
    : twr;

  return { twr, annualizedReturn, durationDays };
}
