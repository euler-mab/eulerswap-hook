// 1inch Fusion order types — parsed from API + used for fill construction
// Reference: github.com/1inch/fusion-resolver-example

import type { Address, Hex } from "viem";

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

// ---- Filler config ----

export interface FillerConfig {
  rpcUrl: string;
  apiKey: string; // 1inch Developer Portal API key
  privateKey?: Hex;
  poolAddress: Address;
  resolverAddress?: Address;
  asset0: Address; // USDC
  asset1: Address; // WETH
  pollIntervalMs: number;
  minProfitBps: number;
  maxGasGwei: number;
  live: boolean;
}

// ---- Addresses ----

export const ADDRESSES = {
  pool: "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address,
  limitOrderProtocol: "0x111111125421cA6dc452d289314280a0f8842A65" as Address,
  settlement: "0xfb2809a5314473e1165f6b58018e20ed8f07b840" as Address,
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
} as const;

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
