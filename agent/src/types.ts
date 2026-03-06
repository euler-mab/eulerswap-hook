import type { Address, Hash } from "viem";

// --- On-chain state ---

export interface PoolSnapshot {
  timestamp: number;
  blockNumber: bigint;

  // Current reserves (raw token units — asset0 may have different decimals from asset1)
  reserve0: bigint;
  reserve1: bigint;

  // Equilibrium reserves — the "center" of the AMM curve (raw token units)
  equilibriumReserve0: bigint;
  equilibriumReserve1: bigint;

  // Min reserves — reserve floors that enforce price boundaries (raw token units)
  // When reserve0 hits minReserve0, the pool stops selling asset0 (upper price boundary).
  // When reserve1 hits minReserve1, the pool stops selling asset1 (lower price boundary).
  // 0 = no boundary (reserves can drain to near-zero).
  minReserve0: bigint;
  minReserve1: bigint;

  // AMM curve price parameters (value per 1 raw unit, fixnum basis 1e18).
  // Used by CurveLib to compute swap outputs: amountOut ≈ amountIn * priceX / priceY.
  // For USDC (6 dec): priceX = 1e-6 * 1e18 = 1e12.
  // For WETH (18 dec) at $2500: priceY = 2500e-18 * 1e18 = 2500.
  priceX: bigint;
  priceY: bigint;

  // Concentration (WAD): 0 = constant-product, 1e18 = constant-sum
  concentrationX: bigint;
  concentrationY: bigint;

  // Current dynamic fees from the hook (WAD-scaled)
  fee0: bigint;
  fee1: bigint;

  // Oracle price ratio: (price0 * WAD) / price1, matching hook's _getOraclePrice().
  // Units: raw asset1 per raw asset0, WAD-scaled.
  oraclePrice: bigint;

  // Individual oracle quotes: getQuote(WAD, asset, unitOfAccount).
  // price0 = value of 1e18 raw units of asset0 in unitOfAccount.
  // Needed to compute priceX/priceY for reconfigure: priceX = oraclePrice0 / WAD.
  oraclePrice0: bigint;
  oraclePrice1: bigint;

  // Marginal price from EulerSwap curve derivative (WAD-scaled, raw asset1 per raw asset0).
  // NOT the reserve ratio — computed from px, py, equilibrium, concentration, and current reserves.
  marginalPrice: bigint;

  // Mismatch: |oraclePrice - marginalPrice| / oraclePrice (WAD-scaled, 0 = perfectly aligned)
  mismatch: bigint;
}

export interface HookFeeParams {
  baseFee: bigint;
  maxFee: bigint;
  gasCoeff: bigint;
  externalFee: bigint;
  captureRate: bigint;
  attractRate: bigint;
}

// --- Vault debt/utilization ---

export interface VaultDebtInfo {
  // Per-vault state for each side (asset0 and asset1)
  debt0: bigint;           // pool's debt in borrow vault 0 (raw token units)
  debt1: bigint;           // pool's debt in borrow vault 1 (raw token units)
  deposit0: bigint;        // pool's deposit in supply vault 0 (underlying units)
  deposit1: bigint;        // pool's deposit in supply vault 1 (underlying units)
  utilization0: bigint;    // borrow vault 0 utilization (WAD-scaled, 0 = empty, 1e18 = 100%)
  utilization1: bigint;    // borrow vault 1 utilization (WAD-scaled)
  borrowRate0: bigint;     // borrow vault 0 interest rate (per-second, 1e27 ray)
  borrowRate1: bigint;     // borrow vault 1 interest rate (per-second, 1e27 ray)
  // Derived: daily interest cost in raw token units
  dailyCost0: bigint;      // debt0 × borrowRate0 × 86400 / 1e27
  dailyCost1: bigint;      // debt1 × borrowRate1 × 86400 / 1e27
  // Whether borrow vaults are configured (non-zero address)
  hasBorrowVault0: boolean;
  hasBorrowVault1: boolean;
  // Supply-side: deposit yield from supply vaults
  supplyRate0: bigint;        // supply vault 0 borrow rate (per-second, 1e27 ray)
  supplyRate1: bigint;        // supply vault 1 borrow rate
  supplyUtilization0: bigint; // supply vault 0 utilization (WAD-scaled)
  supplyUtilization1: bigint; // supply vault 1 utilization
  dailyYield0: bigint;        // deposit0 × supplyRate0 × supplyUtil0 × 86400 / (RAY × WAD)
  dailyYield1: bigint;        // deposit1 × supplyRate1 × supplyUtil1 × 86400 / (RAY × WAD)
  // Cross-vault LTV (basis points, 0-10000; e.g. 8400 = 84%)
  // ltv0 = borrowVault0.LTVBorrow(supplyVault1) — how much asset0 can borrow against asset1
  // ltv1 = borrowVault1.LTVBorrow(supplyVault0) — how much asset1 can borrow against asset0
  ltv0: number;
  ltv1: number;
  // Maximum leverage = 1 / (1 - LTV). At 84% LTV → 6.25x. 0 if LTV is 0.
  maxLeverage0: number;
  maxLeverage1: number;
  // Whether this is a booster (supplyVault == borrowVault for both assets)
  isBooster: boolean;
}

// --- Registry ---

export interface RegistryInfo {
  registered: boolean;        // pool found in registry
  validityBond: bigint;       // ETH bond amount (0 = not registered or challenged)
  totalPoolsInRegistry: bigint;
}

// --- Actions ---

export type ActionType =
  | "reconfigure"
  | "setFeeParams"
  | "externalSwap";

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

  // External swap bounds
  maxSwapPct: bigint; // WAD-scaled, max % of reserves per swap (default 10%)
  swapSlippageBps: number; // slippage tolerance for CowSwap orders (default 50 = 0.5%)

  // Registry
  registryAddress?: Address; // EulerSwap registry for bond monitoring

  // Funding rate (optional — for volatile pairs like ETH, BTC)
  fundingSymbol?: string; // e.g. "ETH" — queries Binance/Hyperliquid for perp funding
}

export const WAD = 10n ** 18n;
export const BPS = 10n ** 14n; // 1 basis point in WAD

// Token decimal info (read once at startup, passed to formatters)
export interface AssetDecimals {
  dec0: number;
  dec1: number;
}

/** Format a raw token amount using its actual decimals */
export function fmtToken(v: bigint, decimals: number): string {
  return (Number(v) / 10 ** decimals).toFixed(Math.min(decimals, 6));
}

/** Format a WAD-scaled value (fees, concentration, mismatch) */
export function fmtWad(v: bigint): string {
  return (Number(v) / 1e18).toFixed(6);
}

/** Format basis points from a WAD-scaled value */
export function fmtBps(v: bigint): string {
  return (Number(v) / Number(BPS)).toFixed(1);
}

/** Format ETH from wei */
export function fmtEth(v: bigint): string {
  return (Number(v) / 1e18).toFixed(6);
}
