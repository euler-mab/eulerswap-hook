/**
 * Find EVK vault addresses for a given underlying asset, optionally filtered
 * by Euler cluster (i.e. by governor address).
 *
 * The EVK has no on-chain "list vaults for asset X" view, so this script
 * enumerates every vault deployed by the GenericFactory (via
 * getProxyListLength + getProxyListSlice), then calls asset() and
 * governorAdmin() on each one (batched via viem multicall) and filters in
 * memory. As of 2026 there are ~840 vaults — the multicall path takes a few
 * seconds.
 *
 * Cluster concept: a "cluster" is the set of vaults sharing the same
 * governor (e.g. the "Prime" cluster has a single governor multisig managing
 * collateral/borrow factors across many vaults). Filtering by CLUSTER_GOV
 * lets you pick the asset's vault that belongs to a specific cluster — the
 * EVK lets anyone deploy a vault for any asset, so multiple unrelated vaults
 * exist for popular assets like USDC.
 *
 * Usage:
 *   MAINNET_RPC_URL=... ASSET=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
 *     npx tsx scripts/find-vaults.ts
 *
 *   # Filter to a single cluster (e.g. Prime):
 *   MAINNET_RPC_URL=... ASSET=0xA0b8...eB48 CLUSTER_GOV=0x... \
 *     npx tsx scripts/find-vaults.ts
 *
 *   # Override the factory address (rare):
 *   FACTORY=0x... ASSET=... npx tsx scripts/find-vaults.ts
 */

import { createPublicClient, http, getAddress, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";

// Default EVK GenericFactory on Ethereum mainnet (from
// contracts/euler-interfaces/addresses/1/CoreAddresses.json — eVaultFactory).
const DEFAULT_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e" as Address;

const RPC_URL = process.env.MAINNET_RPC_URL ?? process.env.RPC_URL;
if (!RPC_URL) {
  console.error("MAINNET_RPC_URL is not set. Copy .env.example to .env and source it.");
  process.exit(1);
}

const RAW_ASSET = process.env.ASSET;
if (!RAW_ASSET || !isAddress(RAW_ASSET)) {
  console.error("ASSET env var must be a valid address (the underlying token to find vaults for).");
  process.exit(1);
}
const ASSET = getAddress(RAW_ASSET);

const RAW_GOV = process.env.CLUSTER_GOV;
if (RAW_GOV !== undefined && !isAddress(RAW_GOV)) {
  console.error("CLUSTER_GOV is set but is not a valid address.");
  process.exit(1);
}
const CLUSTER_GOV = RAW_GOV ? getAddress(RAW_GOV) : undefined;

const RAW_FACTORY = process.env.FACTORY;
if (RAW_FACTORY !== undefined && !isAddress(RAW_FACTORY)) {
  console.error("FACTORY is set but is not a valid address.");
  process.exit(1);
}
const FACTORY = RAW_FACTORY ? getAddress(RAW_FACTORY) : DEFAULT_FACTORY;

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

const factoryAbi = [
  { name: "getProxyListLength", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "getProxyListSlice", type: "function", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "end", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

const eVaultAbi = [
  { name: "asset", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "governorAdmin", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

async function main() {
  console.log("Factory:    " + FACTORY);
  console.log("Asset:      " + ASSET);
  console.log("Cluster:    " + (CLUSTER_GOV ?? "(any)"));
  console.log();

  const length = await client.readContract({
    address: FACTORY, abi: factoryAbi, functionName: "getProxyListLength",
  });
  console.log("Enumerating " + length + " vaults from the factory...");

  // One slice call is enough — the factory has no per-call gas cap on view
  // functions and returns the full array fine for thousands of entries.
  const vaults = await client.readContract({
    address: FACTORY, abi: factoryAbi, functionName: "getProxyListSlice",
    args: [0n, length],
  });

  // Pull asset() and governorAdmin() for every vault. viem's multicall batch
  // config groups these into a few Multicall3 aggregate3 calls so this is
  // cheap (~3-5 RPC round trips for ~850 vaults).
  const reads = await Promise.all(
    vaults.flatMap((v) => [
      client.readContract({ address: v, abi: eVaultAbi, functionName: "asset" })
        .catch(() => null as Address | null),
      client.readContract({ address: v, abi: eVaultAbi, functionName: "governorAdmin" })
        .catch(() => null as Address | null),
    ])
  );

  type Match = { vault: Address; asset: Address; gov: Address };
  const matches: Match[] = [];
  for (let i = 0; i < vaults.length; i++) {
    const asset = reads[2 * i] as Address | null;
    const gov = reads[2 * i + 1] as Address | null;
    if (!asset || !gov) continue;
    if (getAddress(asset) !== ASSET) continue;
    if (CLUSTER_GOV && getAddress(gov) !== CLUSTER_GOV) continue;
    matches.push({ vault: vaults[i], asset: getAddress(asset), gov: getAddress(gov) });
  }

  console.log("Found " + matches.length + " matching vault(s).");
  console.log();

  if (matches.length === 0) return;

  // Best-effort symbol read — some vaults revert on symbol() (rare, but
  // happens for misconfigured implementations); fall back to "?".
  const symbols = await Promise.all(
    matches.map((m) =>
      client.readContract({ address: m.vault, abi: eVaultAbi, functionName: "symbol" })
        .catch(() => "?")
    )
  );

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    console.log("  vault:    " + m.vault);
    console.log("    symbol:   " + symbols[i]);
    console.log("    governor: " + m.gov);
    console.log();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
