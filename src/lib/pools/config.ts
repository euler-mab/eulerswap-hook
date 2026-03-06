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
  /** Initial deposits at deployment (raw bigint amounts) for P&L tracking */
  initialDeposit0?: bigint;
  initialDeposit1?: bigint;
}

export const POOLS: PoolConfig[] = [
  {
    address: "0x4311031739918Aba578C3C667DA3028A12Ce28A8",
    hook: "0x7f93AC4B43Ba7A777bBE85f4CdbCE45445664dDd",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    name: "USDC/WETH #1",
    description: "Dynamic fee hook, test pool",
    deployBlock: 24591724n,
    initialDeposit0: 42_510_000n,    // 42.51 USDC
    initialDeposit1: 20_000_000_000_000_000n, // 0.02 WETH
  },
  {
    address: "0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8",
    hook: "0xdc1b84c674fa39a66cbecf3cec4ed62e18ca021f",
    agentEoa: "0x2909bCc87c17d8Be263621bF087bC806BA313BFE",
    eulerAccount: "0x2909BCc87c17D8be263621bf087Bc806ba313BFf",
    name: "USDC/USDT #1",
    description: "One-sided USDC equity, ±1% range, dynamic fee hook",
    deployBlock: 24593397n,
    initialDeposit0: 500_000_000n,   // 500 USDC
    initialDeposit1: 0n,
  },
];

/** Static token metadata for known assets */
export const TOKEN_META: Record<string, { symbol: string; decimals: number; color: string }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, color: "#2775ca" },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, color: "#627eea" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, color: "#26a17b" },
};
