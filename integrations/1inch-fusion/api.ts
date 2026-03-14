// 1inch Fusion API: fetch active orders, filter for USDC/WETH pair
// Docs: https://portal.1inch.dev/documentation/fusion/api

import type { Address } from "viem";
import {
  type FusionApiOrder,
  type FusionApiResponse,
  type ResolvedFusionAmounts,
  ADDRESSES,
} from "./types";

const API_BASE = "https://api.1inch.dev/fusion/orders/v2.0/1";

/** Fetch active Fusion orders from 1inch API */
export async function fetchActiveOrders(apiKey: string): Promise<FusionApiOrder[]> {
  const url = `${API_BASE}/order/active?page=1&limit=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`1inch Fusion API ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as FusionApiResponse;
  return data.items ?? [];
}

/** Filter orders to only USDC/WETH pair (either direction) */
export function filterForPool(
  orders: FusionApiOrder[],
  asset0: Address = ADDRESSES.usdc,
  asset1: Address = ADDRESSES.weth,
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

/**
 * Resolve Fusion order amounts at a given timestamp.
 *
 * In 1inch Fusion Dutch auctions:
 * - makingAmount is fixed (what the maker sells)
 * - takingAmount decays DOWN over time (resolver pays less as auction progresses)
 *
 * The API may provide `calculatedTakingAmount` pre-resolved. If not,
 * we use the auction start/end amounts with linear interpolation.
 */
export function resolveAmounts(
  order: FusionApiOrder,
  timestamp: number,
): ResolvedFusionAmounts {
  const makingAmount = BigInt(order.remainingMakerAmount || order.order.makingAmount);

  // If the API provides a pre-calculated taking amount, use it
  if (order.calculatedTakingAmount) {
    return {
      makingAmount,
      takingAmount: BigInt(order.calculatedTakingAmount),
    };
  }

  // Otherwise resolve from auction parameters
  const { auctionStartDate, auctionEndDate } = order;
  const baseTakingAmount = BigInt(order.order.takingAmount);

  if (!order.auctionDetails) {
    // No auction details — use base taking amount
    return { makingAmount, takingAmount: baseTakingAmount };
  }

  const startAmount = BigInt(order.auctionDetails.startAmount);
  const endAmount = BigInt(order.auctionDetails.endAmount);

  if (timestamp <= auctionStartDate) {
    return { makingAmount, takingAmount: startAmount };
  }
  if (timestamp >= auctionEndDate) {
    return { makingAmount, takingAmount: endAmount };
  }

  // Linear decay between start and end
  const elapsed = BigInt(timestamp - auctionStartDate);
  const duration = BigInt(auctionEndDate - auctionStartDate);

  // Taking amount decreases linearly: start - (start - end) * elapsed / duration
  const takingAmount = startAmount - ((startAmount - endAmount) * elapsed) / duration;

  return { makingAmount, takingAmount };
}

/** Check if an order's auction has expired */
export function isExpired(order: FusionApiOrder, timestamp: number): boolean {
  return timestamp > order.auctionEndDate;
}

/** Format order for logging */
export function formatOrder(order: FusionApiOrder): string {
  const makerSym = tokenSymbol(order.order.makerAsset);
  const takerSym = tokenSymbol(order.order.takerAsset);
  const making = formatTokenAmount(BigInt(order.order.makingAmount), order.order.makerAsset);
  const taking = formatTokenAmount(BigInt(order.order.takingAmount), order.order.takerAsset);

  return `${makerSym}->${takerSym} make=${making} take=${taking} hash=${order.orderHash.slice(0, 10)}`;
}

function tokenSymbol(addr: Address): string {
  const lower = addr.toLowerCase();
  if (lower === ADDRESSES.usdc.toLowerCase()) return "USDC";
  if (lower === ADDRESSES.weth.toLowerCase()) return "WETH";
  return addr.slice(0, 8);
}

function formatTokenAmount(amount: bigint, token: Address): string {
  const lower = token.toLowerCase();
  if (lower === ADDRESSES.usdc.toLowerCase()) {
    return `${(Number(amount) / 1e6).toFixed(2)}`;
  }
  if (lower === ADDRESSES.weth.toLowerCase()) {
    return `${(Number(amount) / 1e18).toFixed(6)}`;
  }
  return amount.toString();
}
