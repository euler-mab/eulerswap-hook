#!/usr/bin/env npx tsx
/**
 * 1inch Fusion Filler Bot for EulerSwap
 *
 * Monitors 1inch Fusion active orders for USDC/WETH, evaluates profitability
 * against our EulerSwap pool, and optionally fills profitable orders via the
 * OneInchFusionResolver contract.
 *
 * Usage:
 *   npx tsx integrations/1inch-fusion/filler.ts              # monitoring mode
 *   npx tsx integrations/1inch-fusion/filler.ts --live        # live fill mode
 *
 * Env vars:
 *   NEXT_PUBLIC_RPC_URL   - Ethereum RPC endpoint (required)
 *   ONEINCH_API_KEY       - 1inch Developer Portal API key (required)
 *   PRIVATE_KEY           - Filler wallet private key (required for --live)
 *   RESOLVER_ADDRESS      - Deployed OneInchFusionResolver contract (required for --live)
 *   FLASHBOTS_AUTH_KEY    - Throwaway key for bundle mode
 *   MIN_PROFIT_BPS        - Minimum profit threshold in bps (default: 5)
 *   MAX_GAS_GWEI          - Skip fills above this base fee (default: 50)
 *   POLL_INTERVAL_MS      - Polling interval in ms (default: 2000)
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local if present
try {
  const envPath = resolve(process.cwd(), ".env.local");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { fetchActiveOrders, filterForPool, formatOrder } from "./api";
import { evaluateOrder, formatQuote, type QuoteResult } from "./quote";
import { buildFillCalldata, submitFill, simulateFill, buildSignedFillTx } from "./fill";
import {
  submitBundleWithRedundancy,
  getCurrentBlock,
} from "../uniswapx/flashbots";
import { ADDRESSES, type FusionApiOrder } from "./types";

// ---- Config ----

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
if (!RPC_URL) {
  console.error("NEXT_PUBLIC_RPC_URL not set");
  process.exit(1);
}

const API_KEY = process.env.ONEINCH_API_KEY;
if (!API_KEY) {
  console.error("ONEINCH_API_KEY not set (get one at portal.1inch.dev)");
  process.exit(1);
}

const LIVE = process.argv.includes("--live");
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS ?? "5");
const MAX_GAS_GWEI = parseInt(process.env.MAX_GAS_GWEI ?? "50");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "2000");
const RESOLVER_ADDRESS = process.env.RESOLVER_ADDRESS as Address | undefined;
const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY as Hex | undefined;

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

const walletClient =
  LIVE && process.env.PRIVATE_KEY
    ? createWalletClient({
        account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex),
        chain: mainnet,
        transport: http(
          FLASHBOTS_AUTH_KEY
            ? RPC_URL
            : (process.env.FLASHBOTS_RPC_URL ?? RPC_URL),
        ),
      })
    : undefined;

// ---- Rate limiter ----

class RateLimiter {
  private timestamps: number[] = [];
  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 1;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

// 1inch API: conservative rate limit (check portal for actual limits)
const rateLimiter = new RateLimiter(3, 1000);

// ---- State ----

const seenOrders = new Map<string, number>(); // hash -> auctionEndDate
const pendingFills = new Set<string>();
let totalOrdersSeen = 0;
let totalMatchingOrders = 0;
let totalProfitable = 0;
let cycleCount = 0;

function evictStaleOrders() {
  const now = Math.floor(Date.now() / 1000);
  for (const [hash, endDate] of seenOrders) {
    if (endDate < now) seenOrders.delete(hash);
  }
}

// ---- Evaluate & Fill ----

async function evaluateAndFill(apiOrders: FusionApiOrder[]) {
  if (LIVE) {
    try {
      const gasPrice = await client.getGasPrice();
      const gasPriceGwei = Number(gasPrice / 1_000_000_000n);
      if (gasPriceGwei > MAX_GAS_GWEI) {
        console.log(`  gas ${gasPriceGwei} gwei > max ${MAX_GAS_GWEI} — skipping`);
        return;
      }
    } catch {}
  }

  const profitable: { order: FusionApiOrder; quote: QuoteResult }[] = [];

  for (const apiOrder of apiOrders) {
    if (pendingFills.has(apiOrder.orderHash)) continue;
    try {
      const quote = await evaluateOrder(
        client,
        apiOrder,
        MIN_PROFIT_BPS,
        ADDRESSES.pool,
      );

      const tag = quote.profitable ? ">>>" : "   ";
      console.log(`  ${tag} ${formatQuote(quote)}`);

      if (quote.profitable) {
        totalProfitable++;
        profitable.push({ order: apiOrder, quote });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERR ${apiOrder.orderHash.slice(0, 10)}: ${msg}`);
    }
  }

  if (profitable.length > 0 && LIVE) {
    for (const fill of profitable) {
      await executeFill(fill.order, fill.quote);
    }
  }
}

async function executeFill(order: FusionApiOrder, quote: QuoteResult) {
  if (!walletClient || !RESOLVER_ADDRESS) {
    console.log(`  !!! Profitable order — PRIVATE_KEY or RESOLVER_ADDRESS not set`);
    return;
  }

  const fillerAddress = walletClient.account.address;
  pendingFills.add(order.orderHash);

  try {
    const fillCalldata = buildFillCalldata(order, RESOLVER_ADDRESS, ADDRESSES.pool);

    // Simulate first
    const sim = await simulateFill(client, RESOLVER_ADDRESS, fillCalldata, fillerAddress);
    if (!sim.success) {
      console.log(`  SIM FAIL: ${sim.error}`);
      return;
    }

    console.log(`  SIM OK — submitting fill...`);

    if (FLASHBOTS_AUTH_KEY) {
      const signedTx = await buildSignedFillTx(
        walletClient,
        client,
        RESOLVER_ADDRESS,
        fillCalldata,
      );
      const currentBlock = await getCurrentBlock(client);
      const bundle = await submitBundleWithRedundancy(
        signedTx,
        currentBlock,
        FLASHBOTS_AUTH_KEY,
      );
      console.log(`  BUNDLE: ${bundle.bundleHash} (target: ${currentBlock + 1n}+)`);
    } else {
      const txHash = await submitFill(walletClient, client, RESOLVER_ADDRESS, fillCalldata);
      console.log(`  FILLED: ${txHash}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FILL ERROR: ${msg}`);
  } finally {
    pendingFills.delete(order.orderHash);
  }
}

// ---- Poll loop ----

async function poll() {
  cycleCount++;
  try {
    const allOrders = await fetchActiveOrders(API_KEY);
    const matching = filterForPool(allOrders);

    const now = Math.floor(Date.now() / 1000);
    let newOrders = 0;
    for (const order of matching) {
      if (!seenOrders.has(order.orderHash)) {
        seenOrders.set(order.orderHash, order.auctionEndDate);
        newOrders++;
        totalMatchingOrders++;
      }
    }
    totalOrdersSeen += allOrders.length;

    if (cycleCount % 50 === 0) evictStaleOrders();

    if (matching.length === 0) {
      if (cycleCount <= 3 || cycleCount % 15 === 0) {
        console.log(
          `[${ts()}] ${allOrders.length} active orders, 0 USDC/WETH | total: ${totalMatchingOrders} matching, ${totalProfitable} profitable`,
        );
      }
      return;
    }

    console.log(
      `[${ts()}] ${allOrders.length} active orders, ${matching.length} USDC/WETH (${newOrders} new)`,
    );

    await evaluateAndFill(matching);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] poll error: ${msg}`);
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

// ---- Entry point ----

async function main() {
  console.log("1inch Fusion Filler Bot for EulerSwap");
  console.log("======================================");
  console.log(`Mode:           ${LIVE ? "LIVE (fills enabled)" : "MONITOR (read-only)"}`);
  console.log(`Pool:           ${ADDRESSES.pool}`);
  console.log(`LOP:            ${ADDRESSES.limitOrderProtocol}`);
  console.log(`Resolver:       ${RESOLVER_ADDRESS ?? "(not set)"}`);
  console.log(`Min profit:     ${MIN_PROFIT_BPS} bps`);
  console.log(`Max gas:        ${MAX_GAS_GWEI} gwei`);
  console.log(`Poll interval:  ${POLL_INTERVAL_MS}ms`);
  console.log(`Flashbots:      ${FLASHBOTS_AUTH_KEY ? "bundle mode" : "disabled"}`);

  if (LIVE && !walletClient) {
    console.error("--live requires PRIVATE_KEY env var");
    process.exit(1);
  }
  if (LIVE && !RESOLVER_ADDRESS) {
    console.error("--live requires RESOLVER_ADDRESS env var");
    process.exit(1);
  }

  console.log("");

  // Verify pool is accessible
  try {
    const [asset0, asset1] = (await client.readContract({
      address: ADDRESSES.pool,
      abi: [
        {
          name: "getAssets",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [
            { name: "asset0", type: "address" },
            { name: "asset1", type: "address" },
          ],
        },
      ],
      functionName: "getAssets",
    })) as [string, string];
    console.log(`Pool assets: ${asset0} / ${asset1}`);
  } catch {
    console.error("Failed to read pool — check RPC_URL");
    process.exit(1);
  }

  console.log(`\nStarting poll loop...\n`);

  while (true) {
    await rateLimiter.waitForSlot();
    await poll();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
