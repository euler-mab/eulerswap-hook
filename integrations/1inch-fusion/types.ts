// 1inch Fusion order types — parsed from API + used for fill construction

import type { Address, Hex, Chain } from "viem";
import { mainnet } from "viem/chains";

// ---- API response types ----

export interface FusionApiOrder {
  orderHash: Hex;
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
  signature: Hex;
  auctionStartDate: number;
  auctionEndDate: number;
  remainingMakerAmount: string;
  extension: Hex;
  calculatedTakingAmount?: string;
  auctionDetails?: {
    startAmount: string;
    endAmount: string;
    points: Array<{ delay: number; coefficient: number }>;
  };
}

export interface FusionApiResponse {
  items: FusionApiOrder[];
}

export interface ResolvedFusionAmounts {
  makingAmount: bigint;
  takingAmount: bigint;
}

// ---- Multichain config ----

export interface ChainConfig {
  chain: Chain;
  limitOrderProtocol: Address;
  pool: Address;
  asset0: Address;
  asset1: Address;
  wrappedNative: Address;
  asset0Decimals: number;
  asset1Decimals: number;
  asset0Symbol: string;
  asset1Symbol: string;
}

const LOP_V4: Address = "0x111111125421cA6dc452d289314280a0f8842A65";

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  [mainnet.id]: {
    chain: mainnet,
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
};

export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ${chainId}. Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`);
  }
  return config;
}

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

// LOP V4 fillOrderArgs ABI fragment
//
// IMPORTANT: The LOP V4 Order struct uses `type Address is uint256` (Solidity UDVT).
// All Order fields are uint256 in the ABI — NOT address. Using `address` would produce
// the wrong 4-byte selector and every call would revert.
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
