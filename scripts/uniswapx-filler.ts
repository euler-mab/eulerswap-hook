#!/usr/bin/env npx tsx
/**
 * UniswapX Filler Bot for EulerSwap
 *
 * Monitors UniswapX open orders for USDC/WETH, evaluates profitability
 * against our EulerSwap pool, and optionally fills profitable orders.
 *
 * Usage:
 *   npx tsx scripts/uniswapx-filler.ts              # monitoring mode (default)
 *   npx tsx scripts/uniswapx-filler.ts --live        # live fill mode
 *
 * Env vars:
 *   NEXT_PUBLIC_RPC_URL   - Ethereum RPC endpoint (required)
 *   PRIVATE_KEY           - Filler wallet private key (required for --live)
 *   FLASHBOTS_RPC_URL     - Flashbots Protect RPC (optional, for --live)
 *   MIN_PROFIT_BPS        - Minimum profit threshold in bps (default: 5)
 *   MAX_GAS_GWEI          - Skip fills above this base fee (default: 50)
 *   POLL_INTERVAL_MS      - Polling interval in ms (default: 2000)
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local if present (Next.js doesn't load it for scripts)
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

import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { fetchOpenOrders, filterForPool, formatOrder } from "../src/lib/uniswapx/api";
import { evaluateOrder, formatQuote } from "../src/lib/uniswapx/quote";
import { ADDRESSES } from "../src/lib/uniswapx/types";

// ---- Config ----

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
if (!RPC_URL) {
  console.error("NEXT_PUBLIC_RPC_URL not set");
  process.exit(1);
}

const LIVE = process.argv.includes("--live");
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS ?? "5");
const MAX_GAS_GWEI = parseInt(process.env.MAX_GAS_GWEI ?? "50");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "2000");

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

// ---- State ----

const seenOrders = new Set<string>();
let totalOrdersSeen = 0;
let totalMatchingOrders = 0;
let totalProfitable = 0;
let cycleCount = 0;

// ---- Main loop ----

async function poll() {
  cycleCount++;
  try {
    const allOrders = await fetchOpenOrders(1);
    const matching = filterForPool(allOrders);

    // Count new orders
    let newOrders = 0;
    for (const order of matching) {
      if (!seenOrders.has(order.orderHash)) {
        seenOrders.add(order.orderHash);
        newOrders++;
        totalMatchingOrders++;
      }
    }
    totalOrdersSeen += allOrders.length;

    if (matching.length === 0) {
      if (cycleCount <= 3 || cycleCount % 30 === 0) {
        console.log(
          `[${ts()}] ${allOrders.length} open orders, 0 USDC/WETH | total: ${totalMatchingOrders} matching, ${totalProfitable} profitable`,
        );
      }
      return;
    }

    console.log(
      `[${ts()}] ${allOrders.length} open orders, ${matching.length} USDC/WETH (${newOrders} new)`,
    );

    // Evaluate each matching order
    for (const apiOrder of matching) {
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

          if (LIVE) {
            console.log(`  !!! WOULD FILL ${apiOrder.orderHash} (not yet implemented)`);
            // TODO: Phase 2 — call fill.ts to submit transaction
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ERR ${apiOrder.orderHash.slice(0, 10)}: ${msg}`);
      }
    }
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
  console.log("UniswapX Filler Bot for EulerSwap");
  console.log("=================================");
  console.log(`Mode:           ${LIVE ? "LIVE (fills enabled)" : "MONITOR (read-only)"}`);
  console.log(`Pool:           ${ADDRESSES.pool}`);
  console.log(`Reactor:        ${ADDRESSES.reactorV2}`);
  console.log(`Min profit:     ${MIN_PROFIT_BPS} bps`);
  console.log(`Max gas:        ${MAX_GAS_GWEI} gwei`);
  console.log(`Poll interval:  ${POLL_INTERVAL_MS}ms`);
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

  // Initial poll
  await poll();

  // Continuous polling
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
