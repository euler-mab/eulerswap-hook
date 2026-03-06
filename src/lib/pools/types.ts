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

  // Hook state
  hookPaused?: boolean;
  hookBaseFee?: bigint;
  hookMaxFee?: bigint;
  hookMinFee?: bigint;
  hookMismatchScale?: bigint;
  hookTradeCount?: bigint;
  hookVolume0?: bigint;
  hookVolume1?: bigint;
  hookLastBlock?: bigint;
  hookOraclePrice?: bigint;
  // Live fees from hook.getFee (computed at current block)
  hookLiveFee0In?: bigint; // fee when asset0 is input
  hookLiveFee1In?: bigint; // fee when asset1 is input
  // Decay params
  hookDecaySurcharge?: bigint;
  hookDecayPeriod?: number;
  hookLastTradeTimestamp?: number;

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
