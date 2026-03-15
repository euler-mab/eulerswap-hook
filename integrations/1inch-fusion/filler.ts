#!/usr/bin/env npx tsx
/**
 * 1inch Fusion Filler Bot for EulerSwap
 *
 * Usage:
 *   npx tsx integrations/1inch-fusion/filler.ts              # monitor mode
 *   npx tsx integrations/1inch-fusion/filler.ts --live        # live fill mode
 *   CHAIN_ID=42161 npx tsx integrations/1inch-fusion/filler.ts
 *
 * Env vars: NEXT_PUBLIC_RPC_URL, ONEINCH_API_KEY, CHAIN_ID (default 1),
 *   PRIVATE_KEY, RESOLVER_ADDRESS, FLASHBOTS_AUTH_KEY,
 *   MIN_PROFIT_BPS (5), MAX_GAS_GWEI (50), POLL_INTERVAL_MS (2000)
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local if present
try {
  const envPath = resolve(process.cwd(), ".env.local");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1);
  }
} catch {}

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchActiveOrders, filterForPool } from "./api";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import { evaluateOrder, formatQuote, type QuoteResult } from "./quote";
import { buildFillCalldata, submitFill, simulateFill, buildSignedFillTx } from "./fill";
import { submitBundleWithRedundancy, getCurrentBlock } from "../uniswapx/flashbots";
import { type ChainConfig, type FusionApiOrder, getChainConfig } from "./types";

// ---- Config ----

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
if (!RPC_URL) { console.error("NEXT_PUBLIC_RPC_URL not set"); process.exit(1); }

const API_KEY = process.env.ONEINCH_API_KEY;
if (!API_KEY) { console.error("ONEINCH_API_KEY not set"); process.exit(1); }

const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "1");
let chainConfig: ChainConfig;
try { chainConfig = getChainConfig(CHAIN_ID); }
catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }

const LIVE = process.argv.includes("--live");
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS ?? "5");
const MAX_GAS_GWEI = parseInt(process.env.MAX_GAS_GWEI ?? "50");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "2000");
const RESOLVER_ADDRESS = process.env.RESOLVER_ADDRESS as Address | undefined;
const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY as Hex | undefined;

const client = createPublicClient({
  chain: chainConfig.chain,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

const walletClient =
  LIVE && process.env.PRIVATE_KEY
    ? createWalletClient({
        account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex),
        chain: chainConfig.chain,
        transport: http(FLASHBOTS_AUTH_KEY ? RPC_URL : (process.env.FLASHBOTS_RPC_URL ?? RPC_URL)),
      })
    : undefined;

// ---- Rate limiter ----

class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxRequests: number, private windowMs: number) {}
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 1;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(3, 1000);

// ---- State ----

const seenOrders = new Map<string, number>();
const pendingFills = new Set<string>();
let totalMatchingOrders = 0;
let totalProfitable = 0;
let cycleCount = 0;
let consecutiveErrors = 0;

// ---- Pool Status ----

const WAD = 1_000_000_000_000_000_000n;

async function checkPoolAvailable(poolAddress: Address): Promise<string | null> {
  try {
    const [reserves, dynamicParams, installed] = await Promise.all([
      client.readContract({ address: poolAddress, abi: eulerSwapAbi, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
      client.readContract({ address: poolAddress, abi: eulerSwapAbi, functionName: "getDynamicParams" }) as Promise<{ fee0: bigint; fee1: bigint; expiration: number; [k: string]: unknown }>,
      client.readContract({ address: poolAddress, abi: eulerSwapAbi, functionName: "isInstalled" }) as Promise<boolean>,
    ]);

    if (reserves[2] !== 1) return `pool status ${reserves[2]} (expected 1=unlocked)`;
    if (!installed) return "pool not installed";
    const now = Math.floor(Date.now() / 1000);
    if (dynamicParams.expiration !== 0 && dynamicParams.expiration <= now) return "pool expired";
    if (dynamicParams.fee0 >= WAD || dynamicParams.fee1 >= WAD) return "fee >= 100%";
    return null;
  } catch (err) {
    return `pool check failed: ${err instanceof Error ? err.message : err}`;
  }
}

// ---- Evaluate & Fill ----

async function evaluateAndFill(apiOrders: FusionApiOrder[]) {
  if (LIVE) {
    try {
      const gwei = Number((await client.getGasPrice()) / 1_000_000_000n);
      if (gwei > MAX_GAS_GWEI) { console.log(`  gas ${gwei} gwei > max ${MAX_GAS_GWEI} — skipping`); return; }
    } catch {}
  }

  const unavailable = await checkPoolAvailable(chainConfig.pool);
  if (unavailable) { console.log(`  POOL UNAVAILABLE: ${unavailable}`); return; }

  const profitable: { order: FusionApiOrder; quote: QuoteResult }[] = [];

  for (const apiOrder of apiOrders) {
    if (pendingFills.has(apiOrder.orderHash)) continue;
    try {
      const quote = await evaluateOrder(client, apiOrder, MIN_PROFIT_BPS, chainConfig);
      console.log(`  ${quote.profitable ? ">>>" : "   "} ${formatQuote(quote, chainConfig)}`);
      if (quote.profitable) {
        totalProfitable++;
        profitable.push({ order: apiOrder, quote });
      }
    } catch (err) {
      console.log(`  ERR ${apiOrder.orderHash.slice(0, 10)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (profitable.length > 0 && LIVE) {
    for (const { order, quote } of profitable) {
      await executeFill(order, quote);
    }
  }
}

async function executeFill(order: FusionApiOrder, quote: QuoteResult) {
  if (!walletClient || !RESOLVER_ADDRESS) {
    console.log(`  !!! Profitable order — PRIVATE_KEY or RESOLVER_ADDRESS not set`);
    return;
  }

  pendingFills.add(order.orderHash);
  try {
    // Pass gasCost as on-chain minProfit floor
    const fillCalldata = buildFillCalldata(order, RESOLVER_ADDRESS, chainConfig.pool, quote.gasCost);

    const sim = await simulateFill(client, RESOLVER_ADDRESS, fillCalldata, walletClient.account.address);
    if (!sim.success) { console.log(`  SIM FAIL: ${sim.error}`); return; }
    console.log(`  SIM OK — submitting...`);

    if (FLASHBOTS_AUTH_KEY && CHAIN_ID === 1) {
      const signedTx = await buildSignedFillTx(walletClient, RESOLVER_ADDRESS, fillCalldata);
      const currentBlock = await getCurrentBlock(client);
      const bundle = await submitBundleWithRedundancy(signedTx, currentBlock, FLASHBOTS_AUTH_KEY);
      console.log(`  BUNDLE: ${bundle.bundleHash} (target: ${currentBlock + 1n}+)`);
      return;
    }

    const txHash = await submitFill(walletClient, RESOLVER_ADDRESS, fillCalldata);
    console.log(`  TX SENT: ${txHash}`);

    try {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      console.log(`  ${receipt.status === "success" ? "CONFIRMED" : "REVERTED"}: ${txHash} (block ${receipt.blockNumber})`);
    } catch {
      console.log(`  CONFIRM TIMEOUT: ${txHash}`);
    }
  } catch (err) {
    console.error(`  FILL ERROR: ${err instanceof Error ? err.message : err}`);
  } finally {
    pendingFills.delete(order.orderHash);
  }
}

// ---- Poll loop ----

const pairLabel = `${chainConfig.asset0Symbol}/${chainConfig.asset1Symbol}`;

async function poll() {
  cycleCount++;
  try {
    const allOrders = await fetchActiveOrders(API_KEY, CHAIN_ID);
    const matching = filterForPool(allOrders, chainConfig.asset0, chainConfig.asset1);
    consecutiveErrors = 0;

    let newOrders = 0;
    for (const order of matching) {
      if (!seenOrders.has(order.orderHash)) {
        seenOrders.set(order.orderHash, order.auctionEndDate);
        newOrders++;
        totalMatchingOrders++;
      }
    }

    // Evict expired orders periodically
    if (cycleCount % 50 === 0) {
      const now = Math.floor(Date.now() / 1000);
      for (const [hash, end] of seenOrders) { if (end < now) seenOrders.delete(hash); }
    }

    if (matching.length === 0) {
      if (cycleCount <= 3 || cycleCount % 15 === 0) {
        console.log(`[${ts()}] ${allOrders.length} active, 0 ${pairLabel} | total: ${totalMatchingOrders} matching, ${totalProfitable} profitable`);
      }
      return;
    }

    console.log(`[${ts()}] ${allOrders.length} active, ${matching.length} ${pairLabel} (${newOrders} new)`);
    await evaluateAndFill(matching);
  } catch (err) {
    console.error(`[${ts()}] poll error: ${err instanceof Error ? err.message : err}`);
    consecutiveErrors++;
    const backoffMs = Math.min(1000 * 2 ** consecutiveErrors, 30_000);
    console.log(`  backing off ${backoffMs}ms (${consecutiveErrors} consecutive errors)`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

function ts(): string { return new Date().toISOString().slice(11, 23); }

// ---- Entry point ----

async function main() {
  console.log("1inch Fusion Filler Bot for EulerSwap");
  console.log("======================================");
  console.log(`Chain:     ${chainConfig.chain.name} (${CHAIN_ID})`);
  console.log(`Mode:      ${LIVE ? "LIVE" : "MONITOR"}`);
  console.log(`Pool:      ${chainConfig.pool}`);
  console.log(`Pair:      ${pairLabel}`);
  console.log(`Resolver:  ${RESOLVER_ADDRESS ?? "(not set)"}`);
  console.log(`Profit:    ${MIN_PROFIT_BPS} bps min, ${MAX_GAS_GWEI} gwei max`);
  console.log(`Flashbots: ${FLASHBOTS_AUTH_KEY && CHAIN_ID === 1 ? "yes" : "no"}`);

  if (LIVE && !walletClient) { console.error("--live requires PRIVATE_KEY"); process.exit(1); }
  if (LIVE && !RESOLVER_ADDRESS) { console.error("--live requires RESOLVER_ADDRESS"); process.exit(1); }

  // Verify pool assets match config
  try {
    const [asset0, asset1] = (await client.readContract({
      address: chainConfig.pool, abi: eulerSwapAbi, functionName: "getAssets",
    })) as [string, string];
    if (asset0.toLowerCase() !== chainConfig.asset0.toLowerCase() ||
        asset1.toLowerCase() !== chainConfig.asset1.toLowerCase()) {
      console.error(`Pool asset mismatch! Pool: ${asset0}/${asset1}, Config: ${chainConfig.asset0}/${chainConfig.asset1}`);
      process.exit(1);
    }
    console.log(`Assets:    ${asset0} / ${asset1}\n`);
  } catch {
    console.error("Failed to read pool — check RPC_URL and pool address");
    process.exit(1);
  }

  while (true) {
    await rateLimiter.waitForSlot();
    await poll();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
