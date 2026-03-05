import type {
  AgentMetrics,
  PoolSnapshot,
  HookStats,
  ExecutedAction,
  ClaudeReview,
} from "./types.js";

let metrics: AgentMetrics = {
  startTime: Date.now(),
  totalTrades: 0n,
  totalVolume0: 0n,
  totalVolume1: 0n,
  totalGasSpent: 0n,
  totalReconfigures: 0,
  snapshots: [],
  statsHistory: [],
  actions: [],
  reviews: [],
};

const MAX_HISTORY = 1000; // keep last N entries

export function reset(): void {
  metrics = {
    startTime: Date.now(),
    totalTrades: 0n,
    totalVolume0: 0n,
    totalVolume1: 0n,
    totalGasSpent: 0n,
    totalReconfigures: 0,
    snapshots: [],
    statsHistory: [],
    actions: [],
    reviews: [],
  };
}

export function recordSnapshot(snap: PoolSnapshot, stats?: HookStats): void {
  metrics.snapshots.push(snap);
  if (stats) {
    metrics.statsHistory.push(stats);
  }
  if (metrics.snapshots.length > MAX_HISTORY) {
    metrics.snapshots.shift();
    metrics.statsHistory.shift();
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
 * This is the key input for calibrating decaySurcharge.
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

/**
 * Analyze flow quality by comparing (snapshot, stats) pairs between polls.
 *
 * Key heuristics:
 * - Trades that coincide with mismatch DECREASING are likely arb (restoring alignment)
 * - Trades that coincide with mismatch INCREASING are likely informed/retail (creating new imbalance)
 * - High trade count in short intervals with mismatch resolution = arb-dominated
 * - Large single trades that move reserves significantly = likely informed
 */
export function getFlowSummary(): string | null {
  const snaps = metrics.snapshots;
  const stats = metrics.statsHistory;
  // Need at least 5 paired intervals to infer anything
  if (snaps.length < 5 || stats.length < 5) return null;

  // Use last 20 intervals (or all if fewer)
  const n = Math.min(20, snaps.length, stats.length);
  const recentSnaps = snaps.slice(-n);
  const recentStats = stats.slice(-n);

  let arbIntervals = 0;       // trades happened + mismatch decreased
  let retailIntervals = 0;    // trades happened + mismatch increased or stable
  let quietIntervals = 0;     // no trades
  let totalTrades = 0;
  let totalVolume0 = 0n;
  let totalVolume1 = 0n;
  let arbVolume0 = 0n;
  let sameDirectionRuns = 0;  // consecutive intervals with same trade direction
  let lastDirection: boolean | null = null;
  let currentRun = 0;

  for (let i = 1; i < n; i++) {
    const prevStat = recentStats[i - 1]!;
    const currStat = recentStats[i]!;
    const prevSnap = recentSnaps[i - 1]!;
    const currSnap = recentSnaps[i]!;

    const deltaTrades = currStat.tradeCount - prevStat.tradeCount;
    const deltaVol0 = currStat.cumulativeVolume0 - prevStat.cumulativeVolume0;
    const deltaVol1 = currStat.cumulativeVolume1 - prevStat.cumulativeVolume1;

    if (deltaTrades <= 0n) {
      quietIntervals++;
      continue;
    }

    totalTrades += Number(deltaTrades);
    totalVolume0 += deltaVol0;
    totalVolume1 += deltaVol1;

    // Did mismatch increase or decrease?
    const mismatchBefore = Number(prevSnap.mismatch);
    const mismatchAfter = Number(currSnap.mismatch);
    const mismatchDecreased = mismatchAfter < mismatchBefore * 0.8; // >20% drop = significant

    if (mismatchDecreased) {
      arbIntervals++;
      arbVolume0 += deltaVol0;
    } else {
      retailIntervals++;
    }

    // Track directional consistency (same-direction runs = informed/structural flow)
    const dir = currStat.lastTradeAsset0In;
    if (lastDirection !== null && dir === lastDirection) {
      currentRun++;
    } else {
      if (currentRun >= 3) sameDirectionRuns++;
      currentRun = 1;
    }
    lastDirection = dir;
  }
  if (currentRun >= 3) sameDirectionRuns++;

  const activeIntervals = arbIntervals + retailIntervals;
  if (activeIntervals === 0) return null;

  const arbPct = (arbIntervals / activeIntervals * 100).toFixed(0);
  const avgTradeSize = activeIntervals > 0 && totalTrades > 0
    ? Number(totalVolume0) / totalTrades
    : 0;
  const arbVolPct = totalVolume0 > 0n
    ? (Number(arbVolume0) * 100 / Number(totalVolume0)).toFixed(0)
    : "0";

  const periodMin = Math.round(
    (recentSnaps[n - 1]!.timestamp - recentSnaps[0]!.timestamp) / 60
  );

  return `Over last ${periodMin} min (${n - 1} intervals):
  Trade velocity: ${totalTrades} trades (${(totalTrades / Math.max(periodMin, 1) * 60).toFixed(1)}/hr)
  Active intervals: ${activeIntervals}/${n - 1} (${quietIntervals} quiet)
  Arb-like intervals: ${arbIntervals} (${arbPct}%) — trades that resolved mismatch
  Retail-like intervals: ${retailIntervals} — trades that created/maintained mismatch
  Arb volume share: ~${arbVolPct}% of total volume
  Directional runs (≥3 same direction): ${sameDirectionRuns}${sameDirectionRuns > 0 ? " — possible structural/informed flow" : ""}`;
}
