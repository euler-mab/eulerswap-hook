import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  Action,
  RuleResult,
  ClaudeRecommendation,
} from "./types.js";
import { WAD, BPS } from "./types.js";

const RECENTER_THRESHOLD = WAD / 20n; // 5% drift triggers recenter
const ORACLE_STALE_SECONDS = 1800; // 30 minutes
const HOUR_MS = 3_600_000;

// Track recent actions (reconfigs + setFeeParams) for rate limiting
const recentActions: number[] = [];

export function evaluate(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  config: AgentConfig,
  gasSpentToday: bigint
): RuleResult[] {
  const results: RuleResult[] = [];

  results.push(checkEmergencyPause(snapshot, feeParams));
  results.push(checkPriceRecenter(snapshot));
  results.push(checkGasBudget(gasSpentToday, config));
  results.push(checkRateLimit(config));

  return results;
}

/// Rule 1: Price recentering
/// If oracle price has drifted significantly from pool equilibrium, recenter.
function checkPriceRecenter(snapshot: PoolSnapshot): RuleResult {
  if (snapshot.mismatch < RECENTER_THRESHOLD) {
    return { name: "priceRecenter", triggered: false, reason: "mismatch within threshold" };
  }

  // Compute new equilibrium reserves that match the oracle price
  // Keep the same total value, but adjust ratio to match oracle
  // New eq0/eq1 should satisfy: eq1/eq0 ≈ oraclePrice
  const totalValue =
    snapshot.equilibriumReserve0 * snapshot.oraclePrice / WAD +
    snapshot.equilibriumReserve1;

  // eq1 = totalValue / 2, eq0 = totalValue / (2 * oraclePrice)
  const newEq1 = totalValue / 2n;
  const newEq0 = snapshot.oraclePrice > 0n
    ? (totalValue * WAD) / (2n * snapshot.oraclePrice)
    : snapshot.equilibriumReserve0;

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
      },
    },
  };
}

/// Rule 2: Emergency pause
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

/// Validate a Claude recommendation against safety bounds
export function isSafe(
  rec: ClaudeRecommendation,
  config: AgentConfig
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
  }

  if (rec.type === "setPaused") {
    return { safe: false, reason: "Claude cannot pause/unpause — only rules engine or owner" };
  }

  return { safe: true, reason: "within bounds" };
}

// --- Formatters ---

function formatBps(wadValue: bigint): string {
  return (Number(wadValue) / Number(BPS)).toFixed(1);
}

function formatEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(4);
}
