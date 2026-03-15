// 1inch Fusion API: fetch active orders, filter for USDC/WETH pair
// Docs: https://portal.1inch.dev/documentation/fusion/api

import type { Address } from "viem";
import {
  type FusionApiOrder,
  type FusionApiResponse,
  type ResolvedFusionAmounts,
  type ChainConfig,
  getApiBaseUrl,
} from "./types";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 10; // safety cap to avoid infinite loops

/** Fetch a single page of active Fusion orders */
async function fetchPage(
  apiKey: string,
  chainId: number,
  page: number,
  timeoutMs: number,
): Promise<FusionApiOrder[]> {
  const url = `${getApiBaseUrl(chainId)}/order/active?page=${page}&limit=${PAGE_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`1inch Fusion API ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as FusionApiResponse;
    return data.items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all active Fusion orders from 1inch API (paginated) */
export async function fetchActiveOrders(
  apiKey: string,
  chainId: number = 1,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<FusionApiOrder[]> {
  const allOrders: FusionApiOrder[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage(apiKey, chainId, page, timeoutMs);
    allOrders.push(...items);
    if (items.length < PAGE_LIMIT) break; // last page
  }
  return allOrders;
}

/** Filter orders to only the target pair (either direction) */
export function filterForPool(
  orders: FusionApiOrder[],
  asset0: Address,
  asset1: Address,
): FusionApiOrder[] {
  const a0 = asset0.toLowerCase();
  const a1 = asset1.toLowerCase();

  return orders.filter((order) => {
    const makerAsset = order.order.makerAsset.toLowerCase();
    const takerAsset = order.order.takerAsset.toLowerCase();

    return (
      (makerAsset === a0 && takerAsset === a1) ||
      (makerAsset === a1 && takerAsset === a0)
    );
  });
}

// ---- Auction Decay ----
// Reference: 1inch/fusion-sdk AuctionCalculator
//
// Fusion V2 uses piecewise linear interpolation on a "rate bump" that decays to 0.
// resolvedTakingAmount = baseTakingAmount * (rateBump + RATE_BUMP_DENOMINATOR) / RATE_BUMP_DENOMINATOR
//
// The bump starts at `initialRateBump` and decays through `points` to 0 at auction end.
// Each point has:
//   - delay: seconds after PREVIOUS point (cumulative from auction start)
//   - coefficient: the rate bump value at this point (absolute, not delta)
// Between points, decay is linearly interpolated.

const RATE_BUMP_DENOMINATOR = 10_000_000n;

/**
 * Compute the auction rate bump at a given timestamp using piecewise linear interpolation.
 *
 * Algorithm (from AuctionCalculator.sol / auction-calculator.ts):
 *   1. Before auction start: return initialRateBump
 *   2. Walk through points: if timestamp falls between two points, linearly interpolate
 *   3. After last point: linearly decay from last point's coefficient to 0 at finishTime
 *   4. After finishTime: return 0
 */
function getAuctionBump(
  timestamp: number,
  startTime: number,
  duration: number,
  initialRateBump: number,
  points: Array<{ delay: number; coefficient: number }>,
): bigint {
  const finishTime = startTime + duration;

  if (timestamp <= startTime) return BigInt(initialRateBump);
  if (timestamp >= finishTime) return 0n;

  let currentPointTime = startTime;
  let currentBump = initialRateBump;

  for (const point of points) {
    const nextPointTime = currentPointTime + point.delay;

    if (timestamp <= nextPointTime) {
      // Linear interpolation between currentBump and point.coefficient
      // Formula: ((t - t0) * r1 + (t1 - t) * r0) / (t1 - t0)
      const elapsed = timestamp - currentPointTime;
      const segment = nextPointTime - currentPointTime;
      if (segment === 0) return BigInt(point.coefficient);
      return BigInt(
        Math.floor(
          (elapsed * point.coefficient + (segment - elapsed) * currentBump) / segment,
        ),
      );
    }

    currentPointTime = nextPointTime;
    currentBump = point.coefficient;
  }

  // After last point: linear decay from currentBump to 0 at finishTime
  const remaining = finishTime - timestamp;
  const tailDuration = finishTime - currentPointTime;
  if (tailDuration === 0) return 0n;
  return BigInt(Math.floor((remaining * currentBump) / tailDuration));
}

/**
 * Resolve Fusion order amounts at a given timestamp.
 *
 * Uses the piecewise linear auction to compute the rate bump, then:
 *   resolvedTakingAmount = baseTakingAmount * (bump + 10_000_000) / 10_000_000
 *
 * For partial fills, scales takingAmount proportionally to remaining maker amount.
 */
export function resolveAmounts(
  order: FusionApiOrder,
  timestamp: number,
): ResolvedFusionAmounts {
  const fullMakingAmount = BigInt(order.order.makingAmount);
  const remainingMakingAmount = BigInt(
    order.remainingMakerAmount != null && order.remainingMakerAmount !== ""
      ? order.remainingMakerAmount
      : order.order.makingAmount,
  );

  // If the API provides a pre-calculated taking amount, use it (already accounts for decay)
  if (order.calculatedTakingAmount) {
    let takingAmount = BigInt(order.calculatedTakingAmount);
    // Scale for partial fills if needed
    if (remainingMakingAmount < fullMakingAmount && fullMakingAmount > 0n) {
      takingAmount = (takingAmount * remainingMakingAmount) / fullMakingAmount;
    }
    return { makingAmount: remainingMakingAmount, takingAmount };
  }

  // Resolve from auction parameters
  const baseTakingAmount = BigInt(order.order.takingAmount);
  const { auctionStartDate, auctionEndDate } = order;
  const duration = auctionEndDate - auctionStartDate;

  if (!order.auctionDetails || duration <= 0) {
    // No auction — use base taking amount, scaled for partial fills
    const scaled = fullMakingAmount > 0n
      ? (baseTakingAmount * remainingMakingAmount) / fullMakingAmount
      : baseTakingAmount;
    return { makingAmount: remainingMakingAmount, takingAmount: scaled };
  }

  // Compute initial rate bump from start/end amounts
  const startAmount = BigInt(order.auctionDetails.startAmount);
  const endAmount = BigInt(order.auctionDetails.endAmount);

  // initialRateBump = (DENOMINATOR * startAmount / endAmount) - DENOMINATOR
  // endAmount is the base (minimum), startAmount is the initial (with premium)
  const initialRateBump =
    endAmount > 0n
      ? Number((RATE_BUMP_DENOMINATOR * startAmount) / endAmount - RATE_BUMP_DENOMINATOR)
      : 0;

  const bump = getAuctionBump(
    timestamp,
    auctionStartDate,
    duration,
    initialRateBump,
    order.auctionDetails.points,
  );

  // resolvedTakingAmount = baseTakingAmount * (bump + DENOMINATOR) / DENOMINATOR
  // baseTakingAmount here is the endAmount (minimum the maker accepts)
  let takingAmount = (endAmount * (bump + RATE_BUMP_DENOMINATOR)) / RATE_BUMP_DENOMINATOR;

  // Scale for partial fills
  if (remainingMakingAmount < fullMakingAmount && fullMakingAmount > 0n) {
    takingAmount = (takingAmount * remainingMakingAmount) / fullMakingAmount;
  }

  return { makingAmount: remainingMakingAmount, takingAmount };
}

/** Check if an order's auction has expired */
export function isExpired(order: FusionApiOrder, timestamp: number): boolean {
  return timestamp > order.auctionEndDate;
}

/** Format order for logging */
export function formatOrder(order: FusionApiOrder, config?: ChainConfig): string {
  const makerSym = tokenSymbol(order.order.makerAsset, config);
  const takerSym = tokenSymbol(order.order.takerAsset, config);
  const making = formatTokenAmount(BigInt(order.order.makingAmount), order.order.makerAsset, config);
  const taking = formatTokenAmount(BigInt(order.order.takingAmount), order.order.takerAsset, config);

  return `${makerSym}->${takerSym} make=${making} take=${taking} hash=${order.orderHash.slice(0, 10)}`;
}

export function tokenSymbol(addr: Address, config?: ChainConfig): string {
  if (!config) return addr.slice(0, 8);
  const lower = addr.toLowerCase();
  if (lower === config.asset0.toLowerCase()) return config.asset0Symbol;
  if (lower === config.asset1.toLowerCase()) return config.asset1Symbol;
  return addr.slice(0, 8);
}

export function formatTokenAmount(amount: bigint, token: Address, config?: ChainConfig): string {
  if (!config) return amount.toString();
  const lower = token.toLowerCase();
  if (lower === config.asset0.toLowerCase()) {
    return `${(Number(amount) / 10 ** config.asset0Decimals).toFixed(2)}`;
  }
  if (lower === config.asset1.toLowerCase()) {
    return `${(Number(amount) / 10 ** config.asset1Decimals).toFixed(6)}`;
  }
  return amount.toString();
}
