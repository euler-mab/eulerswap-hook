import type { Address } from "viem";

export interface PoolConfig {
  /** EulerSwap pool contract address */
  address: Address;
  /** Hook contract address (for hook-managed pools) */
  hook?: Address;
  /** Agent EOA that manages this pool (for wallet balance tracking) */
  agentEoa: Address;
  /** Euler sub-account used by the pool */
  eulerAccount: Address;
  /** Display name, e.g. "USDC/WETH #1" */
  name: string;
  /** Short description / strategy note */
  description?: string;
  /** Block number from which to start fetching historical events */
  deployBlock: bigint;
  /** Uniswap V3 pool used by the hook as oracle price reference */
  uniswapPool?: Address;
  /** Uniswap V3 pool fee tier in bps (e.g. 5 for 0.05%) */
  uniswapFeeBps?: number;
  /** Secondary Uniswap V3 reference pool (cross-validation) */
  uniswapPool2?: Address;
  /** Display label for secondary pool (e.g. "WETH/USDT 0.01%") */
  uniswapPool2Label?: string;
  /** Token decimals [token0, token1] in the secondary Uni pool */
  uniswapPool2Decimals?: [number, number];
  /** If true, invert the secondary pool's native price to match the primary convention */
  uniswapPool2Invert?: boolean;
  /** Uniswap V4 PoolManager address for extsload oracle reads */
  v4PoolManager?: Address;
  /** V4 pool ID (bytes32) */
  v4PoolId?: `0x${string}`;
  /** Token decimals [token0, token1] in the V4 pool */
  v4Decimals?: [number, number];
}

export const POOLS: PoolConfig[] = [
  {
    address: "0x4311031739918Aba578C3C667DA3028A12Ce28A8",
    hook: "0x9572Bf3D41613987f548Ecfc8aDC73EeFF955048",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    name: "USDC/WETH #1",
    description: "Dynamic fee hook, test pool",
    deployBlock: 24591724n,
    uniswapPool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    uniswapFeeBps: 5,
    uniswapPool2: "0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b",
    uniswapPool2Label: "WETH/USDT 0.01%",
    uniswapPool2Decimals: [18, 6],  // WETH, USDT
    uniswapPool2Invert: true,       // invert USDT/WETH → WETH/USDC convention
  },
  {
    address: "0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8",
    hook: "0x99b97FD05b4F943899358F90855C0BEE34584e41",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909BCc87c17D8be263621bf087Bc806ba313BFf",
    name: "USDC/USDT #1",
    description: "1-tick range, V7 hook, V4 oracle, 0.05 bps base fee",
    deployBlock: 24593397n,
    uniswapPool: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
    uniswapFeeBps: 1,
    v4PoolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    v4PoolId: "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5",
    v4Decimals: [6, 6], // USDC, USDT
  },
];

/** Static token metadata for known assets */
export const TOKEN_META: Record<string, { symbol: string; decimals: number; color: string }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, color: "#2775ca" },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, color: "#627eea" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, color: "#26a17b" },
};
