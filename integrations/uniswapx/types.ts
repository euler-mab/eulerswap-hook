// UniswapX V2 Dutch Order types — parsed from API + ABI-decoded from encodedOrder
// Reference: github.com/Uniswap/UniswapX/src/lib/V2DutchOrderLib.sol

import type { Address, Hex } from "viem";

// ---- API response types ----

export interface UniswapXApiOrder {
  type: string; // "Dutch", "Dutch_V2", etc.
  orderStatus: string; // "open", "filled", "expired", "cancelled"
  chainId: number;
  orderHash: Hex;
  swapper: Address;
  createdAt: number;
  encodedOrder: Hex;
  signature: Hex;
  input: {
    token: Address;
    startAmount: string;
    endAmount: string;
  };
  outputs: Array<{
    token: Address;
    startAmount: string;
    endAmount: string;
    recipient: Address;
  }>;
}

export interface UniswapXApiResponse {
  orders: UniswapXApiOrder[];
}

// ---- Decoded on-chain types ----

export interface OrderInfo {
  reactor: Address;
  swapper: Address;
  nonce: bigint;
  deadline: bigint;
  additionalValidationContract: Address;
  additionalValidationData: Hex;
}

export interface DutchInput {
  token: Address;
  startAmount: bigint;
  endAmount: bigint;
}

export interface DutchOutput {
  token: Address;
  startAmount: bigint;
  endAmount: bigint;
  recipient: Address;
}

export interface CosignerData {
  decayStartTime: bigint;
  decayEndTime: bigint;
  exclusiveFiller: Address;
  exclusivityOverrideBps: bigint;
  inputOverride: bigint;
  outputOverrides: readonly bigint[];
}

export interface V2DutchOrder {
  info: OrderInfo;
  cosigner: Address;
  input: DutchInput;
  outputs: DutchOutput[];
  cosignerData: CosignerData;
  cosignature: Hex;
}

// ---- Resolved order (after applying decay) ----

export interface ResolvedAmounts {
  inputAmount: bigint;
  outputAmounts: bigint[];
}

// ---- Chain configuration ----

/** Token metadata for formatting and identification */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Per-pool configuration */
export interface PoolConfig {
  address: Address;
  asset0: TokenInfo;
  asset1: TokenInfo;
  enabled: boolean;
}

/** Chain-specific gas parameters */
export interface GasParams {
  defaultGasEstimate: bigint;
  defaultPriorityFee: bigint;
  maxGasGwei: number;
  /** Block time in seconds — affects decay buffer and min remaining lifetime */
  blockTimeSeconds: number;
}

/** Complete configuration for one chain */
export interface ChainConfig {
  chainId: number;
  /** viem chain identifier, e.g. "mainnet", "arbitrum", "base" */
  viemChainKey: string;
  reactorV2: Address;
  permit2: Address;
  pools: PoolConfig[];
  gas: GasParams;
  /** Flashbots relay URL, or null if not available on this chain */
  flashbotsRelay: string | null;
  /** UniswapX API base URL */
  apiBase: string;
  /** Webhook allowed IPs */
  webhookAllowedIps: string[];
}

// ---- Filler config ----

export interface FillerConfig {
  chainId: number;
  rpcUrl: string;
  privateKey?: Hex;
  reactorAddress: Address;
  executorAddress?: Address;
  pollIntervalMs: number;
  minProfitBps: number;
  maxGasGwei: number;
  flashbotsRpcUrl?: string;
  live: boolean;
}

// ---- Chain config registry ----

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    viemChainKey: "mainnet",
    reactorV2: "0x00000011F84B9aa48e5f8aA8B9897600006289Be" as Address,
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
    pools: [
      {
        address: "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address,
        asset0: {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
          symbol: "USDC",
          decimals: 6,
        },
        asset1: {
          address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
          symbol: "WETH",
          decimals: 18,
        },
        enabled: true,
      },
    ],
    gas: {
      defaultGasEstimate: 250_000n,
      defaultPriorityFee: 1_500_000_000n, // 1.5 gwei
      maxGasGwei: 50,
      blockTimeSeconds: 12,
    },
    flashbotsRelay: "https://relay.flashbots.net",
    apiBase: "https://api.uniswap.org/v2",
    webhookAllowedIps: ["3.14.56.90"],
  },
};

/** Load chain config from CHAIN_ID env var (defaults to 1 = Ethereum mainnet) */
export function loadChainConfig(): ChainConfig {
  const chainId = parseInt(process.env.CHAIN_ID ?? "1");
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(
      `No config for chainId ${chainId}. Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
    );
  }
  return config;
}

/** Get flattened unique token list from all pools in a chain config */
export function getTokens(config: ChainConfig): TokenInfo[] {
  const seen = new Set<string>();
  const tokens: TokenInfo[] = [];
  for (const pool of config.pools) {
    for (const token of [pool.asset0, pool.asset1]) {
      const key = token.address.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tokens.push(token);
      }
    }
  }
  return tokens;
}

// ---- Backward-compatible ADDRESSES (computed from mainnet config) ----

const _mainnet = CHAIN_CONFIGS[1];
export const ADDRESSES = {
  pool: _mainnet.pools[0].address,
  reactorV2: _mainnet.reactorV2,
  permit2: _mainnet.permit2,
  usdc: _mainnet.pools[0].asset0.address,
  weth: _mainnet.pools[0].asset1.address,
  executor: "0x2126177546c135a0Ef310005090A833a75586C67" as Address,
} as const;

// V2DutchOrder ABI tuple for decoding encodedOrder bytes
export const V2_DUTCH_ORDER_ABI = [
  {
    type: "tuple",
    components: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "reactor", type: "address" },
          { name: "swapper", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "additionalValidationContract", type: "address" },
          { name: "additionalValidationData", type: "bytes" },
        ],
      },
      { name: "cosigner", type: "address" },
      {
        name: "input",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
        ],
      },
      {
        name: "outputs",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      },
      {
        name: "cosignerData",
        type: "tuple",
        components: [
          { name: "decayStartTime", type: "uint256" },
          { name: "decayEndTime", type: "uint256" },
          { name: "exclusiveFiller", type: "address" },
          { name: "exclusivityOverrideBps", type: "uint256" },
          { name: "inputOverride", type: "uint256" },
          { name: "outputOverrides", type: "uint256[]" },
        ],
      },
      { name: "cosignature", type: "bytes" },
    ],
  },
] as const;
