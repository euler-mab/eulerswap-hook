// 1inch Fusion API client + auction decay resolution

import type { Address } from "viem";
import {
  type FusionApiOrder,
  type FusionApiResponse,
  type ResolvedFusionAmounts,
  type ChainConfig,
  getApiBaseUrl,
} from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 10;

async function fetchPage(
  apiKey: string,
  chainId: number,
  page: number,
): Promise<FusionApiOrder[]> {
  const url = `${getApiBaseUrl(chainId)}/order/active?page=${page}&limit=${PAGE_LIMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`1inch API ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return ((await res.json()) as FusionApiResponse).items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all active Fusion orders (paginated) */
export async function fetchActiveOrders(
  apiKey: string,
  chainId: number = 1,
): Promise<FusionApiOrder[]> {
  const all: FusionApiOrder[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage(apiKey, chainId, page);
    all.push(...items);
    if (items.length < PAGE_LIMIT) break;
  }
  return all;
}

/** Filter orders to only the target pair (either direction) */
export function filterForPool(
  orders: FusionApiOrder[],
  asset0: Address,
  asset1: Address,
): FusionApiOrder[] {
  const a0 = asset0.toLowerCase();
  const a1 = asset1.toLowerCase();
  return orders.filter((o) => {
    const m = o.order.makerAsset.toLowerCase();
    const t = o.order.takerAsset.toLowerCase();
    return (m === a0 && t === a1) || (m === a1 && t === a0);
  });
}

// ---- Auction Decay ----
// Piecewise linear interpolation matching 1inch Fusion SDK's AuctionCalculator.
// resolvedTakingAmount = baseTakingAmount * (rateBump + DENOMINATOR) / DENOMINATOR

const RATE_BUMP_DENOMINATOR = 10_000_000n;

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

  const remaining = finishTime - timestamp;
  const tailDuration = finishTime - currentPointTime;
  if (tailDuration === 0) return 0n;
  return BigInt(Math.floor((remaining * currentBump) / tailDuration));
}

/** Parse remaining maker amount, handling null/"" correctly (|| would treat "0" as falsy) */
function parseRemaining(order: FusionApiOrder): bigint {
  return BigInt(
    order.remainingMakerAmount != null && order.remainingMakerAmount !== ""
      ? order.remainingMakerAmount
      : order.order.makingAmount,
  );
}

/** Resolve Fusion order amounts at a given timestamp (applies auction decay + partial fill scaling) */
export function resolveAmounts(order: FusionApiOrder, timestamp: number): ResolvedFusionAmounts {
  const fullMakingAmount = BigInt(order.order.makingAmount);
  const remainingMakingAmount = parseRemaining(order);

  // If the API provides a pre-calculated taking amount, use it
  if (order.calculatedTakingAmount) {
    let takingAmount = BigInt(order.calculatedTakingAmount);
    if (remainingMakingAmount < fullMakingAmount && fullMakingAmount > 0n) {
      takingAmount = (takingAmount * remainingMakingAmount) / fullMakingAmount;
    }
    return { makingAmount: remainingMakingAmount, takingAmount };
  }

  const baseTakingAmount = BigInt(order.order.takingAmount);
  const duration = order.auctionEndDate - order.auctionStartDate;

  if (!order.auctionDetails || duration <= 0) {
    const scaled = fullMakingAmount > 0n
      ? (baseTakingAmount * remainingMakingAmount) / fullMakingAmount
      : baseTakingAmount;
    return { makingAmount: remainingMakingAmount, takingAmount: scaled };
  }

  const startAmount = BigInt(order.auctionDetails.startAmount);
  const endAmount = BigInt(order.auctionDetails.endAmount);
  const initialRateBump = endAmount > 0n
    ? Number((RATE_BUMP_DENOMINATOR * startAmount) / endAmount - RATE_BUMP_DENOMINATOR)
    : 0;

  const bump = getAuctionBump(
    timestamp, order.auctionStartDate, duration,
    initialRateBump, order.auctionDetails.points,
  );

  let takingAmount = (endAmount * (bump + RATE_BUMP_DENOMINATOR)) / RATE_BUMP_DENOMINATOR;
  if (remainingMakingAmount < fullMakingAmount && fullMakingAmount > 0n) {
    takingAmount = (takingAmount * remainingMakingAmount) / fullMakingAmount;
  }

  return { makingAmount: remainingMakingAmount, takingAmount };
}

// ---- Formatting helpers ----

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
