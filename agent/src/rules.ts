import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  VaultDebtInfo,
  RuleResult,
  ClaudeRecommendation,
  AssetDecimals,
} from "./types.js";
import { WAD, BPS } from "./types.js";
import type { AggregatorQuote } from "./oracle.js";

const RECENTER_THRESHOLD = WAD / 20n; // 5% drift triggers recenter
const MAX_RECENTER_CHANGE = 3n; // max Nx change in either reserve per recenter
const ORACLE_STALE_SECONDS = 1800; // 30 minutes
const HOUR_MS = 3_600_000;

// Interest-rate rebalancing thresholds (utilization as WAD-scaled fractions)
const UTILIZATION_MILD = WAD * 70n / 100n;     // 70% — near IRM kink
const UTILIZATION_HIGH = WAD * 85n / 100n;     // 85% — above kink, rates accelerating
const UTILIZATION_CRITICAL = WAD * 95n / 100n; // 95% — emergency

// Track recent actions (reconfigs + setFeeParams) for rate limiting
const recentActions: number[] = [];

export function evaluate(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  config: AgentConfig,
  gasSpentToday: bigint,
  vaultDebt?: VaultDebtInfo,
  aggQuote?: AggregatorQuote | null,
  decimals?: AssetDecimals,
): RuleResult[] {
  const results: RuleResult[] = [];

  results.push(checkPriceRecenter(snapshot, aggQuote, decimals));
  if (vaultDebt) {
    results.push(checkInterestRateRebalance(snapshot, feeParams, vaultDebt, config));
  }
  results.push(checkGasBudget(gasSpentToday, config));
  results.push(checkRateLimit(config));

  return results;
}

/**
 * Rule 1: Price recentering
 *
 * Uses CowSwap mid-price as the primary reference (more accurate than Chainlink),
 * falling back to on-chain oracle if CowSwap is unavailable.
 *
 * If the reference price has drifted >5% from pool marginal price, reconfigure:
 *   1. Computes totalValue in asset1-equivalent raw units (preserving pool value)
 *   2. Splits 50/50 to get new equilibriumReserve0 and equilibriumReserve1
 *   3. Updates priceX/priceY — priceX from on-chain oracle (USDC stable),
 *      priceY derived from CowSwap so the AMM curve matches the real market rate
 *
 * priceX/priceY MUST be updated alongside equilibrium. They define the AMM
 * curve's exchange rate (amountOut ≈ amountIn * priceX / priceY). If equilibrium
 * shifts but prices stay stale, swaps produce near-zero in one direction and
 * drain the pool in the other.
 *
 * Safety: rejects recenters that would change reserves by >3x (stale price guard).
 */
function checkPriceRecenter(
  snapshot: PoolSnapshot,
  aggQuote?: AggregatorQuote | null,
  decimals?: AssetDecimals,
): RuleResult {
  // Compute reference price: CowSwap if available, else on-chain oracle
  let refPrice = snapshot.oraclePrice;
  let priceSource = "on-chain oracle";

  if (aggQuote && decimals && aggQuote.midPrice > 0) {
    // Convert CowSwap mid (human asset1-per-asset0) to WAD-scaled raw ratio.
    // midPrice is in human units (e.g. 0.000470 WETH per 1 USDC).
    // raw ratio = midPrice * 10^(dec1 - dec0), then WAD-scale it.
    const decDiff = decimals.dec1 - decimals.dec0;
    const scaledMid = aggQuote.midPrice * (10 ** decDiff);
    refPrice = BigInt(Math.round(scaledMid * 1e18));
    priceSource = "cowswap";
  }

  if (refPrice === 0n) {
    return { name: "priceRecenter", triggered: false, reason: "no reference price available" };
  }

  // Mismatch: |refPrice - marginal| / refPrice
  let mismatch = 0n;
  if (refPrice > snapshot.marginalPrice) {
    mismatch = ((refPrice - snapshot.marginalPrice) * WAD) / refPrice;
  } else {
    mismatch = ((snapshot.marginalPrice - refPrice) * WAD) / refPrice;
  }

  if (mismatch < RECENTER_THRESHOLD) {
    return { name: "priceRecenter", triggered: false, reason: `mismatch within threshold (${priceSource})` };
  }

  // Compute new equilibrium reserves that match the reference price.
  // totalValue is denominated in asset1 raw units:
  //   eq0 * refPrice / WAD converts asset0 raw → asset1-equivalent raw
  const totalValue =
    snapshot.equilibriumReserve0 * refPrice / WAD +
    snapshot.equilibriumReserve1;

  // Split 50/50 by value: eq1 = totalValue/2, eq0 = totalValue/(2*refPrice)
  const newEq1 = totalValue / 2n;
  const newEq0 = (totalValue * WAD) / (2n * refPrice);

  // Safety: cap change at MAX_RECENTER_CHANGE× in either direction.
  // Prevents catastrophic recenters from stale/mismatched prices.
  const eq0 = snapshot.equilibriumReserve0;
  const eq1 = snapshot.equilibriumReserve1;
  if (
    eq0 > 0n && eq1 > 0n &&
    (newEq0 > eq0 * MAX_RECENTER_CHANGE || newEq0 * MAX_RECENTER_CHANGE < eq0 ||
     newEq1 > eq1 * MAX_RECENTER_CHANGE || newEq1 * MAX_RECENTER_CHANGE < eq1)
  ) {
    return {
      name: "priceRecenter",
      triggered: false,
      reason: `recenter would change reserves by >${MAX_RECENTER_CHANGE}x — ${priceSource} price likely stale, skipping`,
    };
  }

  // priceX from on-chain oracle (USDC is stable, Chainlink accurate for stables).
  // priceY derived from CowSwap reference so AMM curve matches real market rate:
  //   priceX/priceY = refPrice/WAD  →  priceY = (priceX * WAD²) / refPrice
  //   = oraclePrice0 / refPrice
  const newPriceX = snapshot.oraclePrice0 / WAD;
  const newPriceY = snapshot.oraclePrice0 / refPrice;

  // Recompute price boundaries based on the same percentage range width.
  // Instead of preserving the eq/min ratio (which can drift the absolute range),
  // compute the current range width as a price ratio, then re-apply it around
  // the new equilibrium price. This maintains e.g. ±5% range consistently.
  //
  // For c=0: pUpper/eqPrice = (eq0/min0)², so rangeRatio = (eq0/min0)²
  // For c>0: pUpper/eqPrice = cx + (1-cx)*(eq0/min0)²
  // We preserve this rangeRatio and compute new min from new eq.
  const reconfigParams: Record<string, string> = {
    equilibriumReserve0: newEq0.toString(),
    equilibriumReserve1: newEq1.toString(),
    priceX: newPriceX.toString(),
    priceY: newPriceY.toString(),
  };

  if (snapshot.minReserve0 > 0n && snapshot.equilibriumReserve0 > 0n) {
    // Compute the old eq/min ratio and apply it to the new equilibrium.
    // This preserves the same percentage range width around the new center.
    // ratio = oldEq0 / oldMin0 → newMin0 = newEq0 / ratio = newEq0 * oldMin0 / oldEq0
    const newMin0 = newEq0 * snapshot.minReserve0 / snapshot.equilibriumReserve0;
    reconfigParams["minReserve0"] = newMin0.toString();
  }
  if (snapshot.minReserve1 > 0n && snapshot.equilibriumReserve1 > 0n) {
    const newMin1 = newEq1 * snapshot.minReserve1 / snapshot.equilibriumReserve1;
    reconfigParams["minReserve1"] = newMin1.toString();
  }

  return {
    name: "priceRecenter",
    triggered: true,
    reason: `mismatch ${formatBps(mismatch)} bps exceeds ${formatBps(RECENTER_THRESHOLD)} bps threshold (${priceSource})`,
    action: {
      type: "reconfigure",
      reason: `Recenter equilibrium to match ${priceSource} price`,
      params: reconfigParams,
    },
  };
}

/**
 * Rule 2: Interest-rate-aware rebalancing
 *
 * When vault utilization is high and the pool has debt, adjust fee parameters
 * to encourage swaps in the rebalancing direction (adding the depleted asset).
 *
 * Severity tiers based on utilization:
 *   < 70% (below kink):  no action
 *   70-85% (near kink):  mild fee asymmetry — widen min/max by 2 bps
 *   85-95% (above kink): strong asymmetry — maxFee=3×baseFee
 *   > 95% (critical):    maximum asymmetry — maxFee=500bps
 */
function checkInterestRateRebalance(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  vaultDebt: VaultDebtInfo,
  config: AgentConfig
): RuleResult {
  // Find the worst utilization among vaults with pool debt
  const hasDebt0 = vaultDebt.hasBorrowVault0 && vaultDebt.debt0 > 0n;
  const hasDebt1 = vaultDebt.hasBorrowVault1 && vaultDebt.debt1 > 0n;

  if (!hasDebt0 && !hasDebt1) {
    return { name: "interestRebalance", triggered: false, reason: "no pool debt" };
  }

  // Use the higher utilization of the two vaults the pool is borrowing from
  const worstUtilization = hasDebt0 && hasDebt1
    ? (vaultDebt.utilization0 > vaultDebt.utilization1 ? vaultDebt.utilization0 : vaultDebt.utilization1)
    : hasDebt0 ? vaultDebt.utilization0 : vaultDebt.utilization1;

  if (worstUtilization < UTILIZATION_MILD) {
    return { name: "interestRebalance", triggered: false, reason: `utilization ${formatPct(worstUtilization)} below mild threshold` };
  }

  // Determine severity and compute new fee params
  let newMaxFee: bigint;
  let severity: string;

  if (worstUtilization >= UTILIZATION_CRITICAL) {
    newMaxFee = 500n * BPS;
    severity = "CRITICAL";
  } else if (worstUtilization >= UTILIZATION_HIGH) {
    newMaxFee = feeParams.baseFee * 3n;
    if (newMaxFee < 100n * BPS) newMaxFee = 100n * BPS;
    severity = "HIGH";
  } else {
    newMaxFee = feeParams.maxFee + 2n * BPS;
    severity = "MILD";
  }

  if (newMaxFee < feeParams.baseFee) newMaxFee = feeParams.baseFee;
  if (newMaxFee > WAD) newMaxFee = WAD - 1n;

  // Skip if maxFee is already sufficient
  if (feeParams.maxFee >= newMaxFee) {
    return {
      name: "interestRebalance",
      triggered: false,
      reason: `${severity}: utilization ${formatPct(worstUtilization)}, but maxFee already sufficient (${formatBps(feeParams.maxFee)}bps)`,
    };
  }

  const debtSummary = hasDebt0 && hasDebt1
    ? `debt0=${vaultDebt.debt0}, debt1=${vaultDebt.debt1}`
    : hasDebt0 ? `debt0=${vaultDebt.debt0}` : `debt1=${vaultDebt.debt1}`;

  return {
    name: "interestRebalance",
    triggered: true,
    reason: `${severity}: utilization ${formatPct(worstUtilization)}, ${debtSummary}`,
    action: {
      type: "setFeeParams",
      reason: `Interest rate rebalance (${severity}): widen fee spread to attract rebalancing flow`,
      params: {
        baseFee: feeParams.baseFee.toString(),
        maxFee: newMaxFee.toString(),
        mismatchScale: feeParams.mismatchScale.toString(),
      },
    },
  };
}

/// Rule 3: Gas budget check
function checkGasBudget(
  gasSpentToday: bigint,
  config: AgentConfig
): RuleResult {
  const overBudget = gasSpentToday >= config.dailyGasBudget;
  return {
    name: "gasBudget",
    triggered: overBudget,
    reason: overBudget
      ? `Daily gas budget exhausted (${formatEth(gasSpentToday)} / ${formatEth(config.dailyGasBudget)} ETH)`
      : `Gas budget OK (${formatEth(gasSpentToday)} / ${formatEth(config.dailyGasBudget)} ETH)`,
  };
}

/// Rule 4: Rate limiting (applies to both reconfigure and setFeeParams)
function checkRateLimit(config: AgentConfig): RuleResult {
  const now = Date.now();
  // Clean old entries
  while (recentActions.length > 0 && recentActions[0]! < now - HOUR_MS) {
    recentActions.shift();
  }

  const overLimit = recentActions.length >= config.maxReconfigsPerHour;
  return {
    name: "rateLimit",
    triggered: overLimit,
    reason: overLimit
      ? `Rate limit reached (${recentActions.length}/${config.maxReconfigsPerHour} per hour)`
      : `Rate limit OK (${recentActions.length}/${config.maxReconfigsPerHour} per hour)`,
  };
}

/** Record any on-chain action for rate limiting (reconfigure or setFeeParams) */
export function recordAction(): void {
  recentActions.push(Date.now());
}

/// Validate a Claude recommendation against safety bounds.
/// For reconfigure, requires current snapshot to validate equilibrium changes.
export function isSafe(
  rec: ClaudeRecommendation,
  config: AgentConfig,
  snapshot?: PoolSnapshot
): { safe: boolean; reason: string } {
  if (rec.type === "setFeeParams") {
    const baseFee = BigInt(rec.params["baseFee"] as string || "0");
    const maxFee = BigInt(rec.params["maxFee"] as string || "0");
    const mismatchScale = BigInt(rec.params["mismatchScale"] as string || "0");

    if (!rec.params["baseFee"] || !rec.params["maxFee"] || !rec.params["mismatchScale"]) {
      return { safe: false, reason: "setFeeParams requires all 3 params: baseFee, maxFee, mismatchScale" };
    }

    if (baseFee < config.minBaseFee || baseFee > config.maxBaseFee) {
      return { safe: false, reason: `baseFee ${baseFee} outside bounds [${config.minBaseFee}, ${config.maxBaseFee}]` };
    }
    if (maxFee > WAD) {
      return { safe: false, reason: `maxFee ${maxFee} exceeds 100%` };
    }
    if (mismatchScale > 100n * WAD) {
      return { safe: false, reason: `mismatchScale ${mismatchScale} exceeds 100x cap` };
    }
    if (baseFee > maxFee) {
      return { safe: false, reason: `fee ordering violated: base(${baseFee}) > max(${maxFee})` };
    }
  }

  if (rec.type === "reconfigure") {
    // Reject truly immutable fields — Claude must not set these
    const FORBIDDEN_FIELDS = ["swapHook", "fee0", "fee1", "expiration", "swapHookedOperations"];
    for (const field of FORBIDDEN_FIELDS) {
      if (rec.params[field] !== undefined) {
        return { safe: false, reason: `Claude cannot set ${field} — managed automatically` };
      }
    }

    const cx = BigInt(rec.params["concentrationX"] as string || "0");
    const cy = BigInt(rec.params["concentrationY"] as string || "0");
    const eq0 = rec.params["equilibriumReserve0"] ? BigInt(rec.params["equilibriumReserve0"] as string) : null;
    const eq1 = rec.params["equilibriumReserve1"] ? BigInt(rec.params["equilibriumReserve1"] as string) : null;
    const min0 = rec.params["minReserve0"] ? BigInt(rec.params["minReserve0"] as string) : null;
    const min1 = rec.params["minReserve1"] ? BigInt(rec.params["minReserve1"] as string) : null;

    if (cx > 0n && (cx < config.minConcentration || cx > config.maxConcentration)) {
      return { safe: false, reason: `concentrationX ${cx} outside bounds [${config.minConcentration}, ${config.maxConcentration}]` };
    }
    if (cy > 0n && (cy < config.minConcentration || cy > config.maxConcentration)) {
      return { safe: false, reason: `concentrationY ${cy} outside bounds [${config.minConcentration}, ${config.maxConcentration}]` };
    }

    // Equilibrium reserves must be positive if provided
    if (eq0 !== null && eq0 <= 0n) {
      return { safe: false, reason: "equilibriumReserve0 must be positive" };
    }
    if (eq1 !== null && eq1 <= 0n) {
      return { safe: false, reason: "equilibriumReserve1 must be positive" };
    }

    // minReserve must be < equilibrium (or they shrink the trading range to zero)
    if (min0 !== null && min0 < 0n) {
      return { safe: false, reason: "minReserve0 must be non-negative" };
    }
    if (min1 !== null && min1 < 0n) {
      return { safe: false, reason: "minReserve1 must be non-negative" };
    }
    // Validate minReserve < equilibrium (use proposed eq if provided, else current)
    const effectiveEq0 = eq0 ?? snapshot?.equilibriumReserve0 ?? 0n;
    const effectiveEq1 = eq1 ?? snapshot?.equilibriumReserve1 ?? 0n;
    if (min0 !== null && min0 > 0n && effectiveEq0 > 0n && min0 >= effectiveEq0) {
      return { safe: false, reason: `minReserve0 (${min0}) must be < equilibriumReserve0 (${effectiveEq0})` };
    }
    if (min1 !== null && min1 > 0n && effectiveEq1 > 0n && min1 >= effectiveEq1) {
      return { safe: false, reason: `minReserve1 (${min1}) must be < equilibriumReserve1 (${effectiveEq1})` };
    }

    // Cap equilibrium changes at MAX_RECENTER_CHANGE× relative to current values
    if (snapshot && eq0 !== null && snapshot.equilibriumReserve0 > 0n) {
      if (eq0 > snapshot.equilibriumReserve0 * MAX_RECENTER_CHANGE ||
          eq0 * MAX_RECENTER_CHANGE < snapshot.equilibriumReserve0) {
        return { safe: false, reason: `equilibriumReserve0 change too large: ${eq0} vs current ${snapshot.equilibriumReserve0} (max ${MAX_RECENTER_CHANGE}x)` };
      }
    }
    if (snapshot && eq1 !== null && snapshot.equilibriumReserve1 > 0n) {
      if (eq1 > snapshot.equilibriumReserve1 * MAX_RECENTER_CHANGE ||
          eq1 * MAX_RECENTER_CHANGE < snapshot.equilibriumReserve1) {
        return { safe: false, reason: `equilibriumReserve1 change too large: ${eq1} vs current ${snapshot.equilibriumReserve1} (max ${MAX_RECENTER_CHANGE}x)` };
      }
    }
  }

  if (rec.type === "externalSwap") {
    // Require high confidence for irreversible external swaps
    if (rec.confidence < 0.8) {
      return { safe: false, reason: `confidence ${rec.confidence} below 0.8 threshold for externalSwap` };
    }

    const sellAsset = rec.params["sellAsset"] as string;
    const sellAmount = rec.params["sellAmount"] ? BigInt(rec.params["sellAmount"] as string) : 0n;
    const minBuyAmount = rec.params["minBuyAmount"] ? BigInt(rec.params["minBuyAmount"] as string) : 0n;

    if (sellAsset !== "0" && sellAsset !== "1") {
      return { safe: false, reason: `sellAsset must be "0" or "1", got "${sellAsset}"` };
    }
    if (sellAmount <= 0n) {
      return { safe: false, reason: "sellAmount must be positive" };
    }
    if (minBuyAmount <= 0n) {
      return { safe: false, reason: "minBuyAmount must be positive" };
    }

    // Enforce slippage floor: minBuyAmount must be ≥ oracle-fair value minus swapSlippageBps
    if (snapshot && snapshot.oraclePrice > 0n) {
      // oraclePrice = asset0-per-asset1 in WAD. Compute fair buy amount from sell amount.
      const fairBuy = sellAsset === "0"
        ? sellAmount * snapshot.oraclePrice / WAD   // selling asset0 → buying asset1
        : sellAmount * WAD / snapshot.oraclePrice;  // selling asset1 → buying asset0
      const slippageFloor = fairBuy * (10000n - BigInt(config.swapSlippageBps)) / 10000n;
      if (minBuyAmount < slippageFloor) {
        return { safe: false, reason: `minBuyAmount ${minBuyAmount} below slippage floor ${slippageFloor} (${config.swapSlippageBps}bps from oracle)` };
      }
    }

    // Cap swap size at maxSwapPct of the relevant reserve
    if (snapshot) {
      const reserve = sellAsset === "0" ? snapshot.reserve0 : snapshot.reserve1;
      const maxAmount = reserve * config.maxSwapPct / WAD;
      if (sellAmount > maxAmount) {
        return { safe: false, reason: `sellAmount ${sellAmount} exceeds ${(Number(config.maxSwapPct) / 1e16).toFixed(0)}% of reserve (max ${maxAmount})` };
      }
    }
  }

  return { safe: true, reason: "within bounds" };
}

// --- Formatters ---

function formatBps(wadValue: bigint): string {
  return (Number(wadValue) / Number(BPS)).toFixed(1);
}

function formatPct(wadValue: bigint): string {
  return (Number(wadValue) / 1e16).toFixed(1) + "%";
}

function formatEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(4);
}
