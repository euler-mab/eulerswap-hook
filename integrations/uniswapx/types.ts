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

// ---- Filler config ----

export interface FillerConfig {
  rpcUrl: string;
  privateKey?: Hex;
  poolAddress: Address;
  reactorAddress: Address;
  executorAddress?: Address;
  asset0: Address; // USDC
  asset1: Address; // WETH
  pollIntervalMs: number;
  minProfitBps: number; // minimum profit in basis points to attempt fill
  maxGasGwei: number; // skip fills when base fee exceeds this
  flashbotsRpcUrl?: string;
  live: boolean; // false = monitoring only
}

// ---- Addresses ----

export const ADDRESSES = {
  pool: "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address,
  reactorV2: "0x00000011F84B9aa48e5f8aA8B9897600006289Be" as Address,
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
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
