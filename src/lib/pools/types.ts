import type { Address } from "viem";

/** Current on-chain state for a single pool */
export interface PoolState {
  // Reserves
  reserve0: bigint;
  reserve1: bigint;
  status: number;

  // Assets
  asset0: Address;
  asset1: Address;
  asset0Symbol: string;
  asset1Symbol: string;
  asset0Decimals: number;
  asset1Decimals: number;

  // Dynamic params
  equilibriumReserve0: bigint;
  equilibriumReserve1: bigint;
  minReserve0: bigint;
  minReserve1: bigint;
  priceX: bigint;
  priceY: bigint;
  concentrationX: bigint;
  concentrationY: bigint;
  fee0: bigint;
  fee1: bigint;
  expiration: number;
  swapHook: Address;

  // Static params
  supplyVault0: Address;
  supplyVault1: Address;
  borrowVault0: Address;
  borrowVault1: Address;
  eulerAccount: Address;
  feeRecipient: Address;

  // Derived
  marginalPrice: number; // asset1/asset0 in human units (accounts for reserve displacement)
  equilibriumPrice: number; // asset1/asset0 at equilibrium (px/py normalised)
  isInstalled: boolean;

  // Uniswap V3 oracle price (asset1/asset0 in human units, same convention as marginalPrice)
  uniswapPrice?: number;
  twapPrice5m?: number;  // 5-minute TWAP from Uni V3 observe()
  // Secondary Uniswap V3 reference (cross-validation, same convention)
  uniswapPrice2?: number;
  twapPrice5m2?: number;
  uniswapPool2Label?: string;

  // Hook state
  hookBaseFee?: bigint;
  hookMaxFee?: bigint;
  hookGasCoeff?: bigint;       // threshold = gasCoeff × √(tx.gasprice)
  hookExternalFee?: bigint;    // WAD: arber's external cost floor (Uni swap fee)
  hookCaptureRate?: bigint;    // WAD: fraction of net edge captured on arb side
  hookAttractRate?: bigint;    // WAD: fraction of excess captured on attract side
  // Live fees from hook.getFee (computed at current block with realistic gas price)
  hookLiveFee0In?: bigint; // fee when asset0 is input
  hookLiveFee1In?: bigint; // fee when asset1 is input

  // Auction state (v2 hooks only)
  auctionActive?: boolean;
  auctionStart?: number;         // unix timestamp of auction start
  auctionAttractAsset1?: boolean; // true = want asset1 in, false = want asset0 in
  auctionThreshold0?: bigint;    // reserve0 level below which asset0 debt triggers
  auctionThreshold1?: bigint;    // reserve1 level below which asset1 debt triggers
  auctionDelta?: bigint;         // WAD: off-market price shift
  auctionStartFee?: bigint;      // WAD: starting fee for decay
  auctionDecayPerSecond?: bigint; // WAD: fee decay per second

  // V7 hook: exposure state
  v7ExposureRel?: number;        // relative exposure (0-1+, WAD-scaled on-chain)
  v7ExposureAbsWeth?: number;    // absolute exposure in WETH (human units)
  v7NetLongWeth?: boolean;       // true = pool is net long WETH
  v7CachedNav?: bigint;          // cached NAV in asset0 raw units
  v7AuctionTrigger?: number;     // trigger threshold (0-1, WAD-scaled on-chain)

  // Agent wallet balances
  agentEthBalance: bigint;
  agentToken0Balance: bigint;
  agentToken1Balance: bigint;

  // Vault positions for euler account
  vaultDeposit0: bigint;
  vaultDeposit1: bigint;
  vaultDebt0: bigint;
  vaultDebt1: bigint;

  // Trade limits (from getLimits)
  limit0In: bigint;  // max asset0 that can be sold
  limit1Out: bigint; // max asset1 that can be bought (when selling asset0)
  limit1In: bigint;  // max asset1 that can be sold
  limit0Out: bigint; // max asset0 that can be bought (when selling asset1)

  // Arb probe (computeQuote-based estimate vs Uniswap)
  arbProbe?: {
    direction: string;       // e.g. "buy WETH on ES, sell on Uni"
    bestProfitUsd: number;   // best net profit after gas (in asset0 ≈ USD)
    bestTradeUsd: number;    // trade size that yields best profit
    gasCostUsd: number;      // gas cost in USD
    edgeBps: number;         // effective edge at optimal size
  } | null;

  // Network
  gasPrice: bigint;

  // Metadata
  fetchedAt: number;
  blockNumber: bigint;
  blockTimestamp: number;
}

/** Parsed Swap event log */
export interface SwapEvent {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  timestamp?: number;
  sender: Address;
  to: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  fee0: bigint;
  fee1: bigint;
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * A vault event affecting the euler account's equity.
 * Covers all 4 operations on both vaults:
 *   deposit  → supply increases  → equity +
 *   withdraw → supply decreases  → equity -
 *   borrow   → debt increases    → equity -
 *   repay    → debt decreases    → equity +
 */
export interface VaultFlow {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  timestamp?: number;
  /** Which vault (0 = asset0, 1 = asset1) */
  vaultIndex: 0 | 1;
  /** The vault operation type */
  operation: "deposit" | "withdraw" | "borrow" | "repay";
  /** Raw asset amount (always positive — sign is determined by operation) */
  assets: bigint;
}

/** Derived chart data point from swap events */
export interface PricePoint {
  timestamp: number;
  blockNumber: number;
  price: number;
  reserve0: number;
  reserve1: number;
  cumulativeFee0: number;
  cumulativeFee1: number;
}
