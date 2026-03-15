// 1inch Fusion order types — parsed from API + used for fill construction
// Reference: github.com/1inch/fusion-resolver-example

import type { Address, Hex, Chain } from "viem";
import { mainnet } from "viem/chains";

// ---- API response types ----

export interface FusionApiOrder {
  orderHash: Hex;
  /** Raw limit order struct fields */
  order: {
    salt: string;
    maker: Address;
    receiver: Address;
    makerAsset: Address;
    takerAsset: Address;
    makingAmount: string;
    takingAmount: string;
    makerTraits: string;
  };
  /** ABI-encoded signature */
  signature: Hex;
  /** Auction start time (unix seconds) */
  auctionStartDate: number;
  /** Auction end time (unix seconds) */
  auctionEndDate: number;
  /** Remaining maker amount (partial fills reduce this) */
  remainingMakerAmount: string;
  /** Extension bytes for the Settlement contract */
  extension: Hex;
  /** Resolved taking amount at current timestamp (from API) */
  calculatedTakingAmount?: string;
  /** Dutch auction points: array of (delay_seconds, coefficient) pairs */
  auctionDetails?: {
    startAmount: string;
    endAmount: string;
    points: Array<{ delay: number; coefficient: number }>;
  };
}

export interface FusionApiResponse {
  items: FusionApiOrder[];
}

// ---- Resolved order (after applying auction decay) ----

export interface ResolvedFusionAmounts {
  /** Amount of makerAsset the resolver receives */
  makingAmount: bigint;
  /** Amount of takerAsset the resolver must provide (after auction decay) */
  takingAmount: bigint;
}

// ---- Multichain config ----

/** Per-chain deployment addresses and config */
export interface ChainConfig {
  chain: Chain;
  chainId: number;
  /** LOP V4 address (same on all EVM chains except zkSync) */
  limitOrderProtocol: Address;
  /** EulerSwap pool address for the target pair */
  pool: Address;
  /** Resolver contract address (deployed per chain) */
  resolver?: Address;
  /** Token pair: asset0 is quote (USDC), asset1 is base (WETH) */
  asset0: Address;
  asset1: Address;
  /** Native wrapped token (WETH/WMATIC/etc.) for gas cost conversion */
  wrappedNative: Address;
  /** Token decimals for formatting */
  asset0Decimals: number;
  asset1Decimals: number;
  /** Token symbols for logging */
  asset0Symbol: string;
  asset1Symbol: string;
}

// LOP V4 is deployed at the same address on all EVM chains (except zkSync)
const LOP_V4: Address = "0x111111125421cA6dc452d289314280a0f8842A65";

/** Registry of supported chain configurations */
export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  [mainnet.id]: {
    chain: mainnet,
    chainId: mainnet.id,
    limitOrderProtocol: LOP_V4,
    pool: "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address,
    asset0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address, // USDC
    asset1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address, // WETH
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
    asset0Decimals: 6,
    asset1Decimals: 18,
    asset0Symbol: "USDC",
    asset1Symbol: "WETH",
  },
  // Add new chains here as EulerSwap pools are deployed:
  // [arbitrum.id]: { ... },
  // [base.id]: { ... },
};

/** Get chain config or throw */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    const supported = Object.keys(CHAIN_CONFIGS).join(", ");
    throw new Error(`Unsupported chain ${chainId}. Supported: ${supported}`);
  }
  return config;
}

/** Build 1inch Fusion API base URL for a given chain */
export function getApiBaseUrl(chainId: number): string {
  return `https://api.1inch.dev/fusion/orders/v2.0/${chainId}`;
}

// ---- Resolver contract ABI ----

export const resolverAbi = [
  {
    name: "settleOrders",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
  },
  {
    name: "approveToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "withdrawAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
] as const;

// LOP V4 fillOrderArgs ABI fragment (used to construct settleOrders calldata)
//
// IMPORTANT: The LOP V4 Order struct uses `type Address is uint256` (Solidity UDVT).
// UDVTs compile to their underlying type in the ABI, so all Order fields are uint256
// in the canonical signature — NOT address. Using `address` here would produce the
// wrong 4-byte function selector and every call would revert.
export const lopFillOrderArgsAbi = [
  {
    name: "fillOrderArgs",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "uint256" },
          { name: "receiver", type: "uint256" },
          { name: "makerAsset", type: "uint256" },
          { name: "takerAsset", type: "uint256" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
      },
      { name: "r", type: "bytes32" },
      { name: "vs", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "takerTraits", type: "uint256" },
      { name: "args", type: "bytes" },
    ],
    outputs: [
      { name: "makingAmount", type: "uint256" },
      { name: "takingAmount", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
] as const;
