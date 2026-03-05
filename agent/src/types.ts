import type { Address, Hash } from "viem";

// --- On-chain state ---

export interface PoolSnapshot {
  timestamp: number;
  blockNumber: bigint;
  reserve0: bigint;
  reserve1: bigint;
  equilibriumReserve0: bigint;
  equilibriumReserve1: bigint;
  priceX: bigint;
  priceY: bigint;
  concentrationX: bigint;
  concentrationY: bigint;
  fee0: bigint;
  fee1: bigint;
  oraclePrice: bigint; // asset1 per asset0 (WAD)
  marginalPrice: bigint; // reserve1/reserve0 (WAD)
  mismatch: bigint; // |oracle - marginal| / oracle (WAD)
}

export interface HookStats {
  tradeCount: bigint;
  cumulativeVolume0: bigint;
  cumulativeVolume1: bigint;
  lastTradeAsset0In: boolean;
  lastTradeSize: bigint;
  lastTradeBlock: bigint;
}

export interface HookFeeParams {
  baseFee: bigint;
  maxFee: bigint;
  minFee: bigint;
  mismatchScale: bigint;
  paused: boolean;
}

// --- Actions ---

export type ActionType =
  | "reconfigure"
  | "setFeeParams"
  | "setPaused";

export interface Action {
  type: ActionType;
  reason: string;
  params: Record<string, unknown>;
}

export interface ExecutedAction extends Action {
  txHash: Hash;
  gasUsed: bigint;
  success: boolean;
  timestamp: number;
}

// --- Rules ---

export interface RuleResult {
  name: string;
  triggered: boolean;
  action?: Action;
  reason: string;
}

// --- Claude ---

export interface ClaudeRecommendation {
  type: ActionType;
  params: Record<string, unknown>;
  reasoning: string;
  confidence: number; // 0-1
}

export interface ClaudeReview {
  timestamp: number;
  recommendations: ClaudeRecommendation[];
  marketAnalysis: string;
  strategyNotes: string;
}

// --- Metrics ---

export interface AgentMetrics {
  startTime: number;
  totalTrades: bigint;
  totalVolume0: bigint;
  totalVolume1: bigint;
  totalGasSpent: bigint; // in wei
  totalReconfigures: number;
  snapshots: PoolSnapshot[];
  actions: ExecutedAction[];
  reviews: ClaudeReview[];
}

// --- Config ---

export interface AgentConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  poolAddress: Address;
  hookAddress: Address;
  evcAddress: Address;
  eulerAccount: Address; // the pool owner's EVC account
  anthropicApiKey: string;
  flashbotsRpcUrl?: string;
  pollInterval: number; // seconds
  claudeReviewInterval: number; // seconds
  dailyGasBudget: bigint; // wei

  // Safety bounds
  minBaseFee: bigint; // WAD
  maxBaseFee: bigint; // WAD
  minConcentration: bigint; // WAD
  maxConcentration: bigint; // WAD
  maxReconfigsPerHour: number;
}

export const WAD = 10n ** 18n;
export const BPS = 10n ** 14n; // 1 basis point in WAD
