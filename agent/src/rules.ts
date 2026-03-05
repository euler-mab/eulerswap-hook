import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  VaultDebtInfo,
  RuleResult,
  ClaudeRecommendation,
} from "./types.js";
import { WAD, BPS } from "./types.js";

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
  vaultDebt?: VaultDebtInfo
): RuleResult[] {
  const results: RuleResult[] = [];

  results.push(checkEmergencyPause(snapshot, feeParams));
  results.push(checkPriceRecenter(snapshot));
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
 * If oracle price has drifted >5% from pool equilibrium, reconfigure the pool
 * to realign. A recenter does three things:
 *   1. Computes totalValue in asset1-equivalent raw units (preserving pool value)
 *   2. Splits 50/50 to get new equilibriumReserve0 and equilibriumReserve1
 *   3. Updates priceX/priceY (AMM curve params) to match current oracle
 *
 * priceX/priceY MUST be updated alongside equilibrium. They define the AMM
 * curve's exchange rate (amountOut ≈ amountIn * priceX / priceY). If equilibrium
 * shifts but prices stay stale, swaps produce near-zero in one direction and
 * drain the pool in the other.
 *
 * Safety: rejects recenters that would change reserves by >3x (stale oracle guard).
 */
function checkPriceRecenter(snapshot: PoolSnapshot): RuleResult {
  if (snapshot.mismatch < RECENTER_THRESHOLD) {
    return { name: "priceRecenter", triggered: false, reason: "mismatch within threshold" };
  }

  // Compute new equilibrium reserves that match the oracle price.
  // totalValue is denominated in asset1 raw units:
  //   eq0 * oraclePrice / WAD converts asset0 raw → asset1-equivalent raw
  const totalValue =
    snapshot.equilibriumReserve0 * snapshot.oraclePrice / WAD +
    snapshot.equilibriumReserve1;

  // Split 50/50 by value: eq1 = totalValue/2, eq0 = totalValue/(2*oraclePrice)
  let newEq1 = totalValue / 2n;
  let newEq0 = snapshot.oraclePrice > 0n
    ? (totalValue * WAD) / (2n * snapshot.oraclePrice)
    : snapshot.equilibriumReserve0;

  // Safety: cap change at MAX_RECENTER_CHANGE× in either direction.
  // Prevents catastrophic recenters from stale/mismatched oracle prices.
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
      reason: `recenter would change reserves by >${MAX_RECENTER_CHANGE}x — oracle likely stale or mismatched, skipping`,
    };
  }

  return {
    name: "priceRecenter",
    triggered: true,
    reason: `mismatch ${formatBps(snapshot.mismatch)} bps exceeds ${formatBps(RECENTER_THRESHOLD)} bps threshold`,
    action: {
      type: "reconfigure",
      reason: "Recenter equilibrium to match oracle price",
      params: {
        equilibriumReserve0: newEq0.toString(),
        equilibriumReserve1: newEq1.toString(),
        // Update AMM curve prices to match current oracle.
        // priceX/priceY are value-per-raw-unit (fixnum basis 1e18), derived by
        // dividing the oracle's getQuote(WAD, asset, uoa) by WAD.
        priceX: (snapshot.oraclePrice0 / WAD).toString(),
        priceY: (snapshot.oraclePrice1 / WAD).toString(),
      },
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
 *   85-95% (above kink): strong asymmetry — minFee=1bps, maxFee=3×baseFee
 *   > 95% (critical):    maximum asymmetry — minFee=1bps, maxFee=500bps
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
  let newMinFee: bigint;
  let newMaxFee: bigint;
  let severity: string;

  if (worstUtilization >= UTILIZATION_CRITICAL) {
    // Critical: maximum asymmetry
    newMinFee = 1n * BPS;        // 1 bps floor
    newMaxFee = 500n * BPS;      // 500 bps ceiling
    severity = "CRITICAL";
  } else if (worstUtilization >= UTILIZATION_HIGH) {
    // High: strong asymmetry
    newMinFee = 1n * BPS;
    newMaxFee = feeParams.baseFee * 3n;  // 3× baseFee
    if (newMaxFee < 100n * BPS) newMaxFee = 100n * BPS;  // at least 100 bps
    severity = "HIGH";
  } else {
    // Mild: widen spread by 2 bps each direction
    newMinFee = feeParams.minFee > 2n * BPS ? feeParams.minFee - 2n * BPS : 1n * BPS;
    newMaxFee = feeParams.maxFee + 2n * BPS;
    severity = "MILD";
  }

  // Enforce ordering: minFee ≤ baseFee ≤ maxFee
  if (newMinFee > feeParams.baseFee) newMinFee = feeParams.baseFee;
  if (newMaxFee < feeParams.baseFee) newMaxFee = feeParams.baseFee;
  if (newMaxFee > WAD) newMaxFee = WAD - 1n;  // must be < 100%

  // Skip if fees are already at or beyond these levels
  if (feeParams.minFee <= newMinFee && feeParams.maxFee >= newMaxFee) {
    return {
      name: "interestRebalance",
      triggered: false,
      reason: `${severity}: utilization ${formatPct(worstUtilization)}, but fees already sufficient (min=${formatBps(feeParams.minFee)}bps, max=${formatBps(feeParams.maxFee)}bps)`,
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
        minFee: newMinFee.toString(),
        maxFee: newMaxFee.toString(),
        mismatchScale: feeParams.mismatchScale.toString(),
      },
    },
  };
}

/// Rule 3: Emergency pause
/// If oracle price is zero (stale/broken) and pool is not already paused, pause it.
function checkEmergencyPause(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams
): RuleResult {
  if (feeParams.paused) {
    return { name: "emergencyPause", triggered: false, reason: "already paused" };
  }

  // Oracle returning 0 means it's broken or stale
  if (snapshot.oraclePrice === 0n) {
    return {
      name: "emergencyPause",
      triggered: true,
      reason: "oracle returned zero — likely stale or misconfigured",
      action: {
        type: "setPaused",
        reason: "Emergency pause: oracle returned zero",
        params: { paused: true },
      },
    };
  }

  return { name: "emergencyPause", triggered: false, reason: "oracle healthy" };
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
    const minFee = BigInt(rec.params["minFee"] as string || "0");
    const mismatchScale = BigInt(rec.params["mismatchScale"] as string || "0");

    // All fee params must be present
    if (!rec.params["baseFee"] || !rec.params["maxFee"] || !rec.params["minFee"] || !rec.params["mismatchScale"]) {
      return { safe: false, reason: "setFeeParams requires all 4 params: baseFee, maxFee, minFee, mismatchScale" };
    }

    // Bounds checks
    if (baseFee < config.minBaseFee || baseFee > config.maxBaseFee) {
      return { safe: false, reason: `baseFee ${baseFee} outside bounds [${config.minBaseFee}, ${config.maxBaseFee}]` };
    }
    if (maxFee > WAD) {
      return { safe: false, reason: `maxFee ${maxFee} exceeds 100%` };
    }
    if (mismatchScale > 100n * WAD) {
      return { safe: false, reason: `mismatchScale ${mismatchScale} exceeds 100x cap` };
    }

    // Fee ordering: min ≤ base ≤ max
    if (!(minFee <= baseFee && baseFee <= maxFee)) {
      return { safe: false, reason: `fee ordering violated: min(${minFee}) ≤ base(${baseFee}) ≤ max(${maxFee})` };
    }
  }

  if (rec.type === "reconfigure") {
    // Reject forbidden fields — Claude must not set these
    const FORBIDDEN_FIELDS = ["priceX", "priceY", "swapHook", "fee0", "fee1", "expiration", "swapHookedOperations", "minReserve0", "minReserve1"];
    for (const field of FORBIDDEN_FIELDS) {
      if (rec.params[field] !== undefined) {
        return { safe: false, reason: `Claude cannot set ${field} — managed automatically` };
      }
    }

    const cx = BigInt(rec.params["concentrationX"] as string || "0");
    const cy = BigInt(rec.params["concentrationY"] as string || "0");
    const eq0 = rec.params["equilibriumReserve0"] ? BigInt(rec.params["equilibriumReserve0"] as string) : null;
    const eq1 = rec.params["equilibriumReserve1"] ? BigInt(rec.params["equilibriumReserve1"] as string) : null;

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

  if (rec.type === "setPaused") {
    return { safe: false, reason: "Claude cannot pause/unpause — only rules engine or owner" };
  }

  if (rec.type === "externalSwap") {
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
