#!/usr/bin/env npx tsx
/**
 * UniswapX Filler Bot for EulerSwap
 *
 * Monitors UniswapX open orders, evaluates profitability against EulerSwap
 * pool(s), and optionally fills profitable orders. Supports multichain
 * (one instance per chain) and multi-pool routing.
 *
 * Usage:
 *   npx tsx integrations/uniswapx/filler.ts              # monitoring mode (default)
 *   npx tsx integrations/uniswapx/filler.ts --live        # live fill mode
 *
 * Env vars:
 *   NEXT_PUBLIC_RPC_URL   - RPC endpoint (required)
 *   CHAIN_ID              - Target chain (default: 1 = Ethereum mainnet)
 *   PRIVATE_KEY           - Filler wallet private key (required for --live)
 *   EXECUTOR_ADDRESS      - Deployed UniswapXFiller contract (required for --live)
 *   FLASHBOTS_AUTH_KEY    - Throwaway key for bundle mode (zero gas on failure)
 *   FLASHBOTS_RPC_URL     - Flashbots Protect RPC URL (fallback, reverts cost gas)
 *   MIN_PROFIT_BPS        - Minimum profit threshold in bps (default: 5)
 *   MAX_GAS_GWEI          - Skip fills above this base fee (default: from chain config)
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
    const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import * as viemChains from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { fetchOpenOrders, filterForPools } from "./api";
import type { PoolMatch } from "./api";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import {
  evaluateOrder,
  evaluateOrderAcrossPools,
  formatQuote,
  type QuoteResult,
  GasEstimator,
} from "./quote";
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
import {
  loadChainConfig,
  getTokens,
  type ChainConfig,
  type PoolConfig,
  type TokenInfo,
  type UniswapXApiOrder,
} from "./types";

// ---- Chain config ----

const chainConfig = loadChainConfig();
const tokens = getTokens(chainConfig);

function getViemChain(key: string): Chain {
  const chain = (viemChains as Record<string, Chain>)[key];
  if (!chain) {
    throw new Error(
      `Unknown viem chain key: "${key}". Check ChainConfig.viemChainKey.`,
    );
  }
  return chain;
}

const viemChain = getViemChain(chainConfig.viemChainKey);

// ---- Config ----

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
if (!RPC_URL) {
  console.error("NEXT_PUBLIC_RPC_URL not set");
  process.exit(1);
}

const LIVE = process.argv.includes("--live");
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS ?? "5");
const MAX_GAS_GWEI = parseInt(
  process.env.MAX_GAS_GWEI ?? String(chainConfig.gas.maxGasGwei),
);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "200");
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS as Address | undefined;
const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY as Hex | undefined;
const FLASHBOTS_AVAILABLE = !!FLASHBOTS_AUTH_KEY && !!chainConfig.flashbotsRelay;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT
  ? parseInt(process.env.WEBHOOK_PORT)
  : undefined;

const TX_CONFIRMATION_TIMEOUT = 120_000; // 2 minutes

const client = createPublicClient({
  chain: viemChain,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

// Wallet client for live fills.
const walletClient =
  LIVE && process.env.PRIVATE_KEY
    ? createWalletClient({
        account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex),
        chain: viemChain,
        transport: http(
          FLASHBOTS_AVAILABLE
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

// ---- Fill serialization ----

let fillChain: Promise<void> = Promise.resolve();

function serializeFill<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fillChain = fillChain.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject),
    );
  });
}

// ---- State ----

const seenOrders = new Map<string, number>(); // hash -> deadline (unix seconds)
const pendingFills = new Set<string>();
const gasEstimator = new GasEstimator(chainConfig.gas.defaultGasEstimate);
let totalOrdersSeen = 0;
let totalMatchingOrders = 0;
let totalProfitable = 0;
let cycleCount = 0;
let consecutiveErrors = 0;

function evictStaleOrders() {
  const now = Math.floor(Date.now() / 1000);
  for (const [hash, deadline] of seenOrders) {
    if (deadline < now) seenOrders.delete(hash);
  }
}

// ---- Pool Health Monitoring ----

const WAD = 1_000_000_000_000_000_000n;

interface PoolHealthState {
  consecutiveFailures: number;
  lastAvailable: number; // unix timestamp
  expirationWarned: boolean;
  runtimeDisabled: boolean;
}

const poolHealth = new Map<string, PoolHealthState>();

function getPoolHealth(addr: Address): PoolHealthState {
  const key = addr.toLowerCase();
  if (!poolHealth.has(key)) {
    poolHealth.set(key, {
      consecutiveFailures: 0,
      lastAvailable: Math.floor(Date.now() / 1000),
      expirationWarned: false,
      runtimeDisabled: false,
    });
  }
  return poolHealth.get(key)!;
}

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

    // Expiration warning: log if pool expires within 24 hours
    const health = getPoolHealth(poolAddress);
    if (dynamicParams.expiration !== 0) {
      const hoursUntilExpiry = (dynamicParams.expiration - now) / 3600;
      if (hoursUntilExpiry > 0 && hoursUntilExpiry < 24 && !health.expirationWarned) {
        console.log(
          `  EXPIRY WARNING: pool ${poolAddress.slice(0, 10)} expires in ${hoursUntilExpiry.toFixed(1)} hours`,
        );
        health.expirationWarned = true;
      }
    }

    return null; // available
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `pool status check failed: ${msg}`;
  }
}

/** Get list of available pools, updating health state */
async function getAvailablePools(): Promise<PoolConfig[]> {
  const candidates = chainConfig.pools.filter((p) => {
    if (!p.enabled) return false;
    const health = getPoolHealth(p.address);
    return !health.runtimeDisabled;
  });

  if (candidates.length === 0) return [];

  // Check all pools in parallel
  const results = await Promise.all(
    candidates.map(async (pool) => ({
      pool,
      unavailable: await checkPoolAvailable(pool.address),
    })),
  );

  const available: PoolConfig[] = [];
  for (const { pool, unavailable } of results) {
    const health = getPoolHealth(pool.address);
    if (unavailable) {
      health.consecutiveFailures++;
      if (health.consecutiveFailures === 10) {
        console.log(
          `  WARN: pool ${pool.address.slice(0, 10)} unavailable for 10 cycles`,
        );
      }
      if (health.consecutiveFailures >= 50) {
        console.log(
          `  CRITICAL: pool ${pool.address.slice(0, 10)} persistently unavailable — auto-disabling for this session`,
        );
        health.runtimeDisabled = true;
      }
      if (health.consecutiveFailures <= 3 || health.consecutiveFailures % 10 === 0) {
        console.log(
          `  pool ${pool.address.slice(0, 10)} unavailable: ${unavailable}`,
        );
      }
    } else {
      if (health.consecutiveFailures > 0) {
        console.log(
          `  pool ${pool.address.slice(0, 10)} recovered after ${health.consecutiveFailures} failures`,
        );
      }
      health.consecutiveFailures = 0;
      health.lastAvailable = Math.floor(Date.now() / 1000);
      available.push(pool);
    }
  }

  return available;
}

// ---- Evaluate & Fill ----

async function evaluateAndFill(matches: PoolMatch[]) {
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

  // Check pool availability
  const availablePools = await getAvailablePools();
  if (availablePools.length === 0) {
    console.log(`  ALL POOLS UNAVAILABLE`);
    return;
  }

  const profitable: { order: UniswapXApiOrder; quote: QuoteResult; pool: PoolConfig }[] = [];

  for (const { order: apiOrder, matchingPools } of matches) {
    if (pendingFills.has(apiOrder.orderHash)) continue;

    // Only consider pools that are both matching AND available
    const candidatePools = matchingPools.filter((mp) =>
      availablePools.some((ap) => ap.address.toLowerCase() === mp.address.toLowerCase()),
    );
    if (candidatePools.length === 0) continue;

    try {
      const best = await evaluateOrderAcrossPools(
        client,
        apiOrder,
        MIN_PROFIT_BPS,
        candidatePools,
        gasEstimator.estimate,
        chainConfig,
      );

      if (best) {
        const tag = ">>>";
        console.log(`  ${tag} ${formatQuote(best.quote, tokens)} [${best.pool.address.slice(0, 10)}]`);
        totalProfitable++;
        profitable.push({ order: apiOrder, quote: best.quote, pool: best.pool });
      } else {
        // Log best non-profitable result for visibility
        // Evaluate just the first candidate for logging
        const quote = await evaluateOrder(
          client,
          apiOrder,
          MIN_PROFIT_BPS,
          candidatePools[0].address,
          gasEstimator.estimate,
          chainConfig,
        );
        console.log(`      ${formatQuote(quote, tokens)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERR ${apiOrder.orderHash.slice(0, 10)}: ${msg}`);
    }
  }

  if (profitable.length > 0 && LIVE) {
    // Group fills by pool for batching (same pool → batch, different pools → separate)
    const byPool = new Map<string, { order: UniswapXApiOrder; quote: QuoteResult; pool: PoolConfig }[]>();
    for (const fill of profitable) {
      const key = fill.pool.address.toLowerCase();
      if (!byPool.has(key)) byPool.set(key, []);
      byPool.get(key)!.push(fill);
    }

    for (const fills of byPool.values()) {
      await serializeFill(() => executeFills(fills, fills[0].pool.address));
    }
  }
}

async function executeFills(
  fills: { order: UniswapXApiOrder; quote: QuoteResult; pool: PoolConfig }[],
  poolAddress: Address,
) {
  if (!walletClient || !EXECUTOR_ADDRESS) {
    console.log(
      `  !!! ${fills.length} profitable order(s) — PRIVATE_KEY or EXECUTOR_ADDRESS not set`,
    );
    return;
  }

  const fillerAddress = walletClient.account.address;
  const orders = fills.map((f) => f.order);

  for (const f of fills) pendingFills.add(f.order.orderHash);

  try {
    const sim =
      orders.length === 1
        ? await simulateFill(
            client,
            orders[0],
            EXECUTOR_ADDRESS,
            poolAddress,
            0n,
            fillerAddress,
          )
        : await simulateBatchFill(
            // Note: combined pool limits for batched orders are NOT checked here —
            // simulateBatchFill catches this via on-chain revert if combined size exceeds limits.
            client,
            orders,
            EXECUTOR_ADDRESS,
            poolAddress,
            0n,
            fillerAddress,
          );

    if (!sim.success) {
      console.log(`  SIM FAIL: ${sim.error}`);
      return;
    }

    if (sim.gasEstimate) {
      const prevEstimate = gasEstimator.estimate;
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

    if (FLASHBOTS_AVAILABLE && FLASHBOTS_AUTH_KEY && chainConfig.flashbotsRelay) {
      const signedTx =
        orders.length === 1
          ? await buildSignedFillTx(
              walletClient,
              orders[0],
              EXECUTOR_ADDRESS,
              poolAddress,
              0n,
            )
          : await buildSignedBatchFillTx(
              walletClient,
              orders,
              EXECUTOR_ADDRESS,
              poolAddress,
              0n,
            );

      const currentBlock = await getCurrentBlock(client);
      const bundle = await submitBundleWithRedundancy(
        signedTx,
        currentBlock,
        FLASHBOTS_AUTH_KEY,
        chainConfig.flashbotsRelay,
      );
      console.log(
        `  BUNDLE SUBMITTED: ${bundle.bundleHash} (target: ${currentBlock + 1n}+)`,
      );
    } else {
      const txHash =
        orders.length === 1
          ? await callbackFill(
              walletClient,
              orders[0],
              EXECUTOR_ADDRESS,
              poolAddress,
              0n,
            )
          : await batchCallbackFill(
              walletClient,
              orders,
              EXECUTOR_ADDRESS,
              poolAddress,
              0n,
            );

      console.log(`  TX SENT: ${txHash} — waiting for confirmation...`);

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
    const allOrders = await fetchOpenOrders(chainConfig.chainId, chainConfig.apiBase);
    consecutiveErrors = 0;

    const matches = filterForPools(allOrders, chainConfig.pools);

    const now = Math.floor(Date.now() / 1000);
    let newOrders = 0;
    for (const { order } of matches) {
      if (!seenOrders.has(order.orderHash)) {
        // Use createdAt + 10min as eviction deadline. UniswapX V2 Dutch orders
        // typically expire within 2-5min; 10min covers edge cases. Orders are
        // removed from the API when filled/expired, so this is a safety net
        // against the API returning stale orders.
        const evictAt = (order.createdAt > 0 ? order.createdAt : now) + 600;
        seenOrders.set(order.orderHash, evictAt);
        newOrders++;
        totalMatchingOrders++;
      }
    }
    totalOrdersSeen += allOrders.length;

    if (cycleCount % 100 === 0) evictStaleOrders();

    // Build pair label from configured pools
    const pairLabels = chainConfig.pools
      .filter((p) => p.enabled)
      .map((p) => `${p.asset0.symbol}/${p.asset1.symbol}`)
      .filter((v, i, a) => a.indexOf(v) === i) // unique
      .join("+");

    if (matches.length === 0) {
      if (cycleCount <= 3 || cycleCount % 30 === 0) {
        console.log(
          `[${ts()}] ${allOrders.length} open orders, 0 ${pairLabels} | total: ${totalMatchingOrders} matching, ${totalProfitable} profitable`,
        );
      }
      return;
    }

    console.log(
      `[${ts()}] ${allOrders.length} open orders, ${matches.length} ${pairLabels} (${newOrders} new)`,
    );

    await evaluateAndFill(matches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] poll error: ${msg}`);

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
  // Validate chain ID matches RPC
  const rpcChainId = await client.getChainId();
  if (rpcChainId !== chainConfig.chainId) {
    console.error(
      `CHAIN MISMATCH: config chainId=${chainConfig.chainId}, RPC chainId=${rpcChainId}`,
    );
    process.exit(1);
  }

  const enabledPools = chainConfig.pools.filter((p) => p.enabled);
  const pairLabels = enabledPools
    .map((p) => `${p.asset0.symbol}/${p.asset1.symbol}`)
    .join(", ");

  console.log("UniswapX Filler Bot for EulerSwap");
  console.log("=================================");
  console.log(
    `Chain:          ${chainConfig.viemChainKey} (${chainConfig.chainId})`,
  );
  console.log(
    `Mode:           ${LIVE ? "LIVE (fills enabled)" : "MONITOR (read-only)"}`,
  );
  console.log(`Pools:          ${enabledPools.length} enabled (${pairLabels})`);
  for (const pool of enabledPools) {
    console.log(`                ${pool.address} ${pool.asset0.symbol}/${pool.asset1.symbol}`);
  }
  console.log(`Reactor:        ${chainConfig.reactorV2}`);
  console.log(`Executor:       ${EXECUTOR_ADDRESS ?? "(not set)"}`);
  console.log(`Min profit:     ${MIN_PROFIT_BPS} bps`);
  console.log(`Max gas:        ${MAX_GAS_GWEI} gwei`);
  console.log(`Gas estimate:   ${gasEstimator.estimate} (adaptive, 20% margin)`);
  console.log(`Poll interval:  ${POLL_INTERVAL_MS}ms`);
  console.log(
    `Flashbots:      ${FLASHBOTS_AVAILABLE ? "bundle mode (zero gas on failure)" : process.env.FLASHBOTS_RPC_URL ? "protect RPC (reverts still cost gas)" : chainConfig.flashbotsRelay ? "disabled (no auth key)" : "not available on this chain"}`,
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

  // Verify first pool is accessible
  if (enabledPools.length > 0) {
    try {
      const [asset0, asset1] = (await client.readContract({
        address: enabledPools[0].address,
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
      console.error("Failed to read pool — check RPC_URL and pool address");
      process.exit(1);
    }
  }

  // Start webhook server if configured
  if (WEBHOOK_PORT) {
    startWebhookServer(
      WEBHOOK_PORT,
      async (orders) => {
        const matches = filterForPools(orders, chainConfig.pools);
        if (matches.length === 0) return;

        const now = Math.floor(Date.now() / 1000);
        const freshMatches = matches.filter(({ order: o }) => {
          if (seenOrders.has(o.orderHash)) return false;
          const evictAt = (o.createdAt > 0 ? o.createdAt : now) + 600;
          seenOrders.set(o.orderHash, evictAt);
          return true;
        });
        if (freshMatches.length > 0) {
          console.log(`[${ts()}] webhook: ${freshMatches.length} new matching order(s)`);
          await evaluateAndFill(freshMatches);
        }
      },
      chainConfig.webhookAllowedIps,
    );
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
