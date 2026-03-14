#!/usr/bin/env npx tsx
/**
 * UniswapX Filler Bot for EulerSwap
 *
 * Monitors UniswapX open orders for USDC/WETH, evaluates profitability
 * against our EulerSwap pool, and optionally fills profitable orders.
 *
 * Usage:
 *   npx tsx integrations/uniswapx/filler.ts              # monitoring mode (default)
 *   npx tsx integrations/uniswapx/filler.ts --live        # live fill mode
 *
 * Env vars:
 *   NEXT_PUBLIC_RPC_URL   - Ethereum RPC endpoint (required)
 *   PRIVATE_KEY           - Filler wallet private key (required for --live)
 *   EXECUTOR_ADDRESS      - Deployed UniswapXFiller contract (required for --live)
 *   FLASHBOTS_AUTH_KEY    - Throwaway key for bundle mode (zero gas on failure)
 *   FLASHBOTS_RPC_URL    - Flashbots Protect RPC URL (fallback, reverts cost gas)
 *   MIN_PROFIT_BPS        - Minimum profit threshold in bps (default: 5)
 *   MAX_GAS_GWEI          - Skip fills above this base fee (default: 50)
 *   POLL_INTERVAL_MS      - Polling interval in ms (default: 200)
 *   WEBHOOK_PORT          - If set, start webhook server for push-based order sourcing
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

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { fetchOpenOrders, filterForPool } from "./api";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import { evaluateOrder, formatQuote, type QuoteResult, GasEstimator } from "./quote";
import {
  callbackFill,
  batchCallbackFill,
  buildSignedFillTx,
  buildSignedBatchFillTx,
  simulateFill,
  simulateBatchFill,
} from "./fill";
import {
  submitBundleWithRedundancy,
  getCurrentBlock,
} from "./flashbots";
import { startWebhookServer } from "./webhook";
import { ADDRESSES, type UniswapXApiOrder } from "./types";

// ---- Config ----

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
if (!RPC_URL) {
  console.error("NEXT_PUBLIC_RPC_URL not set");
  process.exit(1);
}

const LIVE = process.argv.includes("--live");
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS ?? "5");
const MAX_GAS_GWEI = parseInt(process.env.MAX_GAS_GWEI ?? "50");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "200");
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS as Address | undefined;
const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY as Hex | undefined;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT
  ? parseInt(process.env.WEBHOOK_PORT)
  : undefined;

const TX_CONFIRMATION_TIMEOUT = 120_000; // 2 minutes

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

// Wallet client for live fills.
// Always uses normal RPC for nonce/gas estimation.
// For bundle mode (FLASHBOTS_AUTH_KEY), the signed tx goes directly to the relay.
// For non-bundle mode, FLASHBOTS_RPC_URL provides Protect RPC (reverts still cost gas).
const walletClient =
  LIVE && process.env.PRIVATE_KEY
    ? createWalletClient({
        account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex),
        chain: mainnet,
        transport: http(
          FLASHBOTS_AUTH_KEY
            ? RPC_URL // Bundle mode: wallet uses normal RPC, signed tx → relay
            : (process.env.FLASHBOTS_RPC_URL ?? RPC_URL), // Protect RPC fallback
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

const rateLimiter = new RateLimiter(6, 1000); // UniswapX API: 6 req/s

// ---- Fill serialization (Fix 4: nonce mutex) ----

/**
 * Serializes fill submissions to prevent nonce collisions.
 * Without this, concurrent fills from poll + webhook could get the same nonce
 * from prepareTransactionRequest, causing one to fail.
 */
let fillChain: Promise<void> = Promise.resolve();

function serializeFill<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fillChain = fillChain.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject), // continue chain even if prior fill failed
    );
  });
}

// ---- State ----

/** Tracks seen orders with their deadline for eviction */
const seenOrders = new Map<string, number>(); // hash -> deadline (unix seconds)
const pendingFills = new Set<string>();
const gasEstimator = new GasEstimator(); // adaptive gas estimate from simulation feedback
let totalOrdersSeen = 0;
let totalMatchingOrders = 0;
let totalProfitable = 0;
let cycleCount = 0;
let consecutiveErrors = 0; // for exponential backoff

/** Evict expired entries from seenOrders to prevent unbounded growth */
function evictStaleOrders() {
  const now = Math.floor(Date.now() / 1000);
  for (const [hash, deadline] of seenOrders) {
    if (deadline < now) seenOrders.delete(hash);
  }
}

// ---- Pool Status ----

const WAD = 1_000_000_000_000_000_000n; // 1e18

/**
 * Check if the pool is available for swaps.
 * Mirrors the CoW driver's pool filtering: skip if expired, locked, fee >= 100%, or not installed.
 * Returns null if available, or a reason string if not.
 */
async function checkPoolAvailable(poolAddress: Address): Promise<string | null> {
  try {
    const [reserves, dynamicParams, installed] = await Promise.all([
      client.readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "getReserves",
      }) as Promise<readonly [bigint, bigint, number]>,
      client.readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "getDynamicParams",
      }) as Promise<{
        fee0: bigint;
        fee1: bigint;
        expiration: number;
        [key: string]: unknown;
      }>,
      client.readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "isInstalled",
      }) as Promise<boolean>,
    ]);

    const [, , status] = reserves;
    if (status !== 1) return `pool status ${status} (expected 1=unlocked)`;

    if (!installed) return "pool not installed in EVC";

    const now = Math.floor(Date.now() / 1000);
    if (dynamicParams.expiration !== 0 && dynamicParams.expiration <= now) {
      return `pool expired at ${dynamicParams.expiration}`;
    }

    if (dynamicParams.fee0 >= WAD || dynamicParams.fee1 >= WAD) {
      return "fee >= 100% (swap rejected)";
    }

    return null; // available
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `pool status check failed: ${msg}`;
  }
}

// ---- Evaluate & Fill ----

/**
 * Evaluate orders and optionally fill profitable ones.
 * Shared by both poll loop and webhook handler.
 */
async function evaluateAndFill(apiOrders: UniswapXApiOrder[]) {
  // Skip evaluation entirely when gas is too expensive
  if (LIVE) {
    try {
      const gasPrice = await client.getGasPrice();
      const gasPriceGwei = Number(gasPrice / 1_000_000_000n);
      if (gasPriceGwei > MAX_GAS_GWEI) {
        console.log(`  gas ${gasPriceGwei} gwei > max ${MAX_GAS_GWEI} — skipping fills`);
        return;
      }
    } catch {}
  }

  // Check pool status before evaluating (mirrors CoW driver pattern)
  const unavailable = await checkPoolAvailable(ADDRESSES.pool);
  if (unavailable) {
    console.log(`  POOL UNAVAILABLE: ${unavailable}`);
    return;
  }

  const profitable: { order: UniswapXApiOrder; quote: QuoteResult }[] = [];

  for (const apiOrder of apiOrders) {
    if (pendingFills.has(apiOrder.orderHash)) continue;
    try {
      const quote = await evaluateOrder(
        client,
        apiOrder,
        MIN_PROFIT_BPS,
        ADDRESSES.pool,
        gasEstimator.estimate,
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
    // Serialize fills to prevent nonce collisions from concurrent poll + webhook
    await serializeFill(() => executeFills(profitable));
  }
}

/**
 * Simulate then fill profitable orders.
 * Uses batch fill for 2+ orders, single fill for 1.
 */
async function executeFills(
  fills: { order: UniswapXApiOrder; quote: QuoteResult }[],
) {
  if (!walletClient || !EXECUTOR_ADDRESS) {
    console.log(
      `  !!! ${fills.length} profitable order(s) — PRIVATE_KEY or EXECUTOR_ADDRESS not set`,
    );
    return;
  }

  const fillerAddress = walletClient.account.address;
  const orders = fills.map((f) => f.order);

  // Mark as pending to avoid re-evaluation
  for (const f of fills) pendingFills.add(f.order.orderHash);

  try {
    // Simulate first (targets executor contract, single RPC call)
    const sim =
      orders.length === 1
        ? await simulateFill(
            client,
            orders[0],
            EXECUTOR_ADDRESS,
            ADDRESSES.pool,
            0n,
            fillerAddress,
          )
        : await simulateBatchFill(
            client,
            orders,
            EXECUTOR_ADDRESS,
            ADDRESSES.pool,
            0n,
            fillerAddress,
          );

    if (!sim.success) {
      console.log(`  SIM FAIL: ${sim.error}`);
      return;
    }

    // Feed actual gas back into adaptive estimator (Fix 5: normalize for batch)
    if (sim.gasEstimate) {
      const prevEstimate = gasEstimator.estimate;
      // For batch fills, normalize gas per order so the estimator
      // tracks single-order gas cost (used for per-order profitability).
      const perOrderGas = orders.length > 1
        ? sim.gasEstimate / BigInt(orders.length)
        : sim.gasEstimate;
      gasEstimator.update(perOrderGas);
      console.log(
        `  SIM OK (gas: ${sim.gasEstimate}${orders.length > 1 ? ` (${perOrderGas}/order)` : ""}, est: ${prevEstimate}→${gasEstimator.estimate}, n=${gasEstimator.samples}) — submitting fill...`,
      );
    } else {
      console.log(`  SIM OK (gas: unknown) — submitting fill...`);
    }

    if (FLASHBOTS_AUTH_KEY) {
      // Bundle mode: build raw signed tx, submit to Flashbots relay.
      // Failed bundles cost zero gas (vs Protect RPC where reverts still pay).
      const signedTx =
        orders.length === 1
          ? await buildSignedFillTx(
              walletClient,
              client,
              orders[0],
              EXECUTOR_ADDRESS,
              ADDRESSES.pool,
              0n,
            )
          : await buildSignedBatchFillTx(
              walletClient,
              client,
              orders,
              EXECUTOR_ADDRESS,
              ADDRESSES.pool,
              0n,
            );

      const currentBlock = await getCurrentBlock(client);
      const bundle = await submitBundleWithRedundancy(
        signedTx,
        currentBlock,
        FLASHBOTS_AUTH_KEY,
      );
      console.log(
        `  BUNDLE SUBMITTED: ${bundle.bundleHash} (target: ${currentBlock + 1n}+)`,
      );
      // Bundle inclusion is best-effort — no on-chain confirmation available.
      // The bundle either lands in block+1/+2 or expires silently (zero gas cost).
    } else {
      // Non-bundle mode: submit via wallet client RPC (Protect or standard).
      const txHash =
        orders.length === 1
          ? await callbackFill(
              walletClient,
              client,
              orders[0],
              EXECUTOR_ADDRESS,
              ADDRESSES.pool,
              0n,
            )
          : await batchCallbackFill(
              walletClient,
              client,
              orders,
              EXECUTOR_ADDRESS,
              ADDRESSES.pool,
              0n,
            );

      console.log(`  TX SENT: ${txHash} — waiting for confirmation...`);

      // Fix 6: Wait for confirmation to track success/failure
      try {
        const receipt = await client.waitForTransactionReceipt({
          hash: txHash,
          timeout: TX_CONFIRMATION_TIMEOUT,
        });
        if (receipt.status === "success") {
          const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
          console.log(
            `  CONFIRMED: ${txHash} block=${receipt.blockNumber} gas=${receipt.gasUsed} cost=${(Number(gasCost) / 1e18).toFixed(6)} ETH`,
          );
        } else {
          console.log(`  REVERTED: ${txHash} block=${receipt.blockNumber}`);
        }
      } catch {
        console.log(`  TIMEOUT: ${txHash} — confirmation not received within ${TX_CONFIRMATION_TIMEOUT / 1000}s`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FILL ERROR: ${msg}`);
  } finally {
    for (const f of fills) pendingFills.delete(f.order.orderHash);
  }
}

// ---- Poll loop ----

async function poll() {
  cycleCount++;
  try {
    const allOrders = await fetchOpenOrders(1);
    consecutiveErrors = 0; // reset backoff on success

    const matching = filterForPool(allOrders);

    // Count new orders and track with expiry for eviction
    const now = Math.floor(Date.now() / 1000);
    let newOrders = 0;
    for (const order of matching) {
      if (!seenOrders.has(order.orderHash)) {
        // Orders typically expire within 2 minutes; evict after 5 minutes
        seenOrders.set(order.orderHash, now + 300);
        newOrders++;
        totalMatchingOrders++;
      }
    }
    totalOrdersSeen += allOrders.length;

    // Periodically evict expired orders to prevent unbounded memory growth
    if (cycleCount % 100 === 0) evictStaleOrders();

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

    await evaluateAndFill(matching);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] poll error: ${msg}`);

    // Fix 7: Exponential backoff on consecutive errors (caps at ~30s)
    consecutiveErrors++;
    if (consecutiveErrors > 1) {
      const backoffMs = Math.min(1000 * 2 ** (consecutiveErrors - 1), 30_000);
      console.log(`  backing off ${backoffMs}ms (${consecutiveErrors} consecutive errors)`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

// ---- Entry point ----

async function main() {
  console.log("UniswapX Filler Bot for EulerSwap");
  console.log("=================================");
  console.log(
    `Mode:           ${LIVE ? "LIVE (fills enabled)" : "MONITOR (read-only)"}`,
  );
  console.log(`Pool:           ${ADDRESSES.pool}`);
  console.log(`Reactor:        ${ADDRESSES.reactorV2}`);
  console.log(`Executor:       ${EXECUTOR_ADDRESS ?? "(not set)"}`);
  console.log(`Min profit:     ${MIN_PROFIT_BPS} bps`);
  console.log(`Max gas:        ${MAX_GAS_GWEI} gwei`);
  console.log(`Gas estimate:   ${gasEstimator.estimate} (adaptive, 20% margin)`);
  console.log(`Poll interval:  ${POLL_INTERVAL_MS}ms`);
  console.log(
    `Flashbots:      ${FLASHBOTS_AUTH_KEY ? "bundle mode (zero gas on failure)" : process.env.FLASHBOTS_RPC_URL ? "protect RPC (reverts still cost gas)" : "disabled"}`,
  );
  console.log(`Webhook:        ${WEBHOOK_PORT ? `port ${WEBHOOK_PORT}` : "disabled"}`);

  if (LIVE && !walletClient) {
    console.error("--live requires PRIVATE_KEY env var");
    process.exit(1);
  }
  if (LIVE && !EXECUTOR_ADDRESS) {
    console.error("--live requires EXECUTOR_ADDRESS env var");
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

  // Start webhook server if configured
  if (WEBHOOK_PORT) {
    startWebhookServer(WEBHOOK_PORT, async (orders) => {
      const matching = filterForPool(orders);
      if (matching.length > 0) {
        console.log(`[${ts()}] webhook: ${matching.length} matching order(s)`);
        await evaluateAndFill(matching);
      }
    });
  }

  console.log(`\nStarting poll loop...\n`);

  // Continuous polling with rate limiting
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
