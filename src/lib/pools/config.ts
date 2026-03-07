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
}

export const POOLS: PoolConfig[] = [
  {
    address: "0x4311031739918Aba578C3C667DA3028A12Ce28A8",
    hook: "0xF4Cea28cE81ede6200B6E1E033A9E72415d5D701",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    name: "USDC/WETH #1",
    description: "Dynamic fee hook, test pool",
    deployBlock: 24591724n,
    uniswapPool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    uniswapFeeBps: 5,
  },
  {
    address: "0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8",
    hook: "0xdC45Ee622320CD6466F0B9717818299606AE0E2c",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909BCc87c17D8be263621bf087Bc806ba313BFf",
    name: "USDC/USDT #1",
    description: "One-sided USDC equity, ±1% range, dynamic fee hook",
    deployBlock: 24593397n,
    uniswapPool: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
    uniswapFeeBps: 1,
  },
];

/** Static token metadata for known assets */
export const TOKEN_META: Record<string, { symbol: string; decimals: number; color: string }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, color: "#2775ca" },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, color: "#627eea" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, color: "#26a17b" },
};
