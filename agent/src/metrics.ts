import type {
  AgentMetrics,
  PoolSnapshot,
  ExecutedAction,
  ClaudeReview,
} from "./types.js";

let metrics: AgentMetrics = {
  startTime: Date.now(),
  totalGasSpent: 0n,
  totalReconfigures: 0,
  snapshots: [],
  actions: [],
  reviews: [],
};

const MAX_HISTORY = 1000; // keep last N entries

export function reset(): void {
  metrics = {
    startTime: Date.now(),
    totalGasSpent: 0n,
    totalReconfigures: 0,
    snapshots: [],
    actions: [],
    reviews: [],
  };
}

export function recordSnapshot(snap: PoolSnapshot): void {
  metrics.snapshots.push(snap);
  if (metrics.snapshots.length > MAX_HISTORY) {
    metrics.snapshots.shift();
  }
}

export function recordAction(action: ExecutedAction): void {
  metrics.actions.push(action);
  metrics.totalGasSpent += action.gasUsed;
  if (action.type === "reconfigure") {
    metrics.totalReconfigures++;
  }
  if (metrics.actions.length > MAX_HISTORY) {
    metrics.actions.shift();
  }
}

export function recordReview(review: ClaudeReview): void {
  metrics.reviews.push(review);
  if (metrics.reviews.length > MAX_HISTORY) {
    metrics.reviews.shift();
  }
}

export function getMetrics(): AgentMetrics {
  return metrics;
}

export function getGasSpentToday(): bigint {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);

  return metrics.actions
    .filter((a) => a.timestamp >= dayStartSec)
    .reduce((sum, a) => sum + a.gasUsed, 0n);
}

export function getRecentActions(n: number = 10): ExecutedAction[] {
  return metrics.actions.slice(-n);
}

/**
 * Compute realized per-block volatility from oracle price changes between snapshots.
 * Returns σ in basis points — the standard deviation of per-block oracle price moves.
 */
export function getRealizedVol(): { volBps: number; avgBlocksBetweenPolls: number; sampleSize: number } | null {
  const snaps = metrics.snapshots;
  if (snaps.length < 10) return null;

  const recent = snaps.slice(-50); // use last 50 snapshots
  const returns: number[] = [];
  let totalBlocks = 0;

  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    if (prev.oraclePrice <= 0n || curr.oraclePrice <= 0n) continue;

    // Log return between snapshots (in bps)
    const logReturn = Math.log(Number(curr.oraclePrice) / Number(prev.oraclePrice)) * 10000;
    const blocksBetween = Number(curr.blockNumber - prev.blockNumber);
    if (blocksBetween <= 0) continue;

    // Normalize to per-block return (variance scales linearly with time)
    const perBlockReturn = logReturn / Math.sqrt(blocksBetween);
    returns.push(perBlockReturn);
    totalBlocks += blocksBetween;
  }

  if (returns.length < 5) return null;

  // Standard deviation of per-block returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const volBps = Math.sqrt(variance);
  const avgBlocksBetweenPolls = totalBlocks / returns.length;

  return { volBps, avgBlocksBetweenPolls, sampleSize: returns.length };
}

/**
 * Estimate gasThreshold: minimum mismatch for profitable arb.
 *
 * gasThreshold ≈ swapGasCost_ETH / (poolDepth_ETH × 2)
 *
 * An arb needs the fee savings to exceed gas cost. With a pool of depth D (in ETH),
 * a mismatch of m produces an arb profit ≈ m × D. Setting fee = m captures all of it,
 * so the arb is unprofitable if m × D < gasCost, i.e. m < gasCost / D.
 *
 * @param gasPriceGwei Current gas price in gwei
 * @param swapGasUnits Gas units for an arb swap (~150,000)
 * @param poolDepthEth Total pool depth in ETH terms (both sides)
 * @returns gasThreshold as WAD-scaled value
 */
export function computeGasThreshold(
  gasPriceGwei: number,
  swapGasUnits: number = 150_000,
  poolDepthEth: number = 450,
): bigint {
  const gasCostEth = gasPriceGwei * swapGasUnits * 1e-9;
  const threshold = gasCostEth / (poolDepthEth * 2);
  // Convert to WAD (1e18), clamp to [1 bps, 200 bps]
  const thresholdWad = Math.max(1e14, Math.min(200e14, threshold * 1e18));
  return BigInt(Math.round(thresholdWad));
}

/**
 * Default capture rate: 80% of arb profit above threshold.
 * This leaves 20% for the arber as incentive to execute, while capturing most LVR.
 */
export function computeCaptureRate(): bigint {
  return BigInt("800000000000000000"); // 0.8e18 = 80%
}

/** Compute a trend summary from recent snapshots for Claude context */
export function getTrendSummary(): string | null {
  const snaps = metrics.snapshots;
  if (snaps.length < 3) return null;

  // Use last 20 snapshots (or all if fewer)
  const recent = snaps.slice(-20);
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const periodMin = Math.round((last.timestamp - first.timestamp) / 60);
  if (periodMin <= 0) return null;

  // Average mismatch
  const avgMismatch = recent.reduce((sum, s) => sum + Number(s.mismatch), 0) / recent.length;
  const avgMismatchBps = avgMismatch / 1e14;

  // Mismatch trend: compare first half avg vs second half avg
  const mid = Math.floor(recent.length / 2);
  const firstHalfMismatch = recent.slice(0, mid).reduce((s, r) => s + Number(r.mismatch), 0) / mid;
  const secondHalfMismatch = recent.slice(mid).reduce((s, r) => s + Number(r.mismatch), 0) / (recent.length - mid);
  const mismatchDelta = secondHalfMismatch - firstHalfMismatch;
  const mismatchTrend = Math.abs(mismatchDelta) < firstHalfMismatch * 0.1
    ? "stable"
    : mismatchDelta > 0 ? "rising" : "falling";

  // Reserve drift: % change from first to last
  const drift0 = first.reserve0 > 0n
    ? Number((last.reserve0 - first.reserve0) * 10000n / first.reserve0) / 100
    : 0;
  const drift1 = first.reserve1 > 0n
    ? Number((last.reserve1 - first.reserve1) * 10000n / first.reserve1) / 100
    : 0;

  // Imbalance: current reserves vs equilibrium
  const imbal0 = last.equilibriumReserve0 > 0n
    ? Number((last.reserve0 - last.equilibriumReserve0) * 10000n / last.equilibriumReserve0) / 100
    : 0;
  const imbal1 = last.equilibriumReserve1 > 0n
    ? Number((last.reserve1 - last.equilibriumReserve1) * 10000n / last.equilibriumReserve1) / 100
    : 0;

  // Action count in this period
  const periodStart = first.timestamp;
  const actionsInPeriod = metrics.actions.filter(a => a.timestamp >= periodStart).length;

  return `Over last ${periodMin} min (${recent.length} snapshots):
  Avg mismatch: ${avgMismatchBps.toFixed(1)} bps (${mismatchTrend})
  Reserve drift: asset0 ${drift0 >= 0 ? "+" : ""}${drift0.toFixed(1)}%, asset1 ${drift1 >= 0 ? "+" : ""}${drift1.toFixed(1)}%
  Current imbalance: asset0 ${imbal0 >= 0 ? "+" : ""}${imbal0.toFixed(1)}% vs eq, asset1 ${imbal1 >= 0 ? "+" : ""}${imbal1.toFixed(1)}% vs eq
  Agent actions in period: ${actionsInPeriod}`;
}

