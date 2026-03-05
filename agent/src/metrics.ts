import type {
  AgentMetrics,
  PoolSnapshot,
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
