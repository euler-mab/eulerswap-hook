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
const HOUR_MS = 3_600_000;

// Track recent reconfigs for rate limiting
const recentReconfigs: number[] = [];

export function evaluate(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  config: AgentConfig,
  gasSpentToday: bigint
): RuleResult[] {
  const results: RuleResult[] = [];

  results.push(checkPriceRecenter(snapshot, config));
  results.push(checkGasBudget(gasSpentToday, config));
  results.push(checkRateLimit(config));

  return results;
}

/// Rule 1: Price recentering
/// If oracle price has drifted significantly from pool equilibrium, recenter.
function checkPriceRecenter(
  snapshot: PoolSnapshot,
  _config: AgentConfig
): RuleResult {
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

/// Rule 4: Gas budget check
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

/// Rule 5: Rate limiting
function checkRateLimit(config: AgentConfig): RuleResult {
  const now = Date.now();
  // Clean old entries
  while (recentReconfigs.length > 0 && recentReconfigs[0]! < now - HOUR_MS) {
    recentReconfigs.shift();
  }

  const overLimit = recentReconfigs.length >= config.maxReconfigsPerHour;
  return {
    name: "rateLimit",
    triggered: overLimit,
    reason: overLimit
      ? `Rate limit reached (${recentReconfigs.length}/${config.maxReconfigsPerHour} per hour)`
      : `Rate limit OK (${recentReconfigs.length}/${config.maxReconfigsPerHour} per hour)`,
  };
}

export function recordReconfig(): void {
  recentReconfigs.push(Date.now());
}

/// Validate a Claude recommendation against safety bounds
export function isSafe(
  rec: ClaudeRecommendation,
  config: AgentConfig
): { safe: boolean; reason: string } {
  if (rec.type === "setFeeParams") {
    const baseFee = BigInt(rec.params["baseFee"] as string || "0");
    if (baseFee < config.minBaseFee || baseFee > config.maxBaseFee) {
      return { safe: false, reason: `baseFee ${baseFee} outside bounds [${config.minBaseFee}, ${config.maxBaseFee}]` };
    }
  }

  if (rec.type === "reconfigure") {
    const cx = BigInt(rec.params["concentrationX"] as string || "0");
    const cy = BigInt(rec.params["concentrationY"] as string || "0");
    if (cx > 0n && (cx < config.minConcentration || cx > config.maxConcentration)) {
      return { safe: false, reason: `concentrationX ${cx} outside bounds` };
    }
    if (cy > 0n && (cy < config.minConcentration || cy > config.maxConcentration)) {
      return { safe: false, reason: `concentrationY ${cy} outside bounds` };
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
