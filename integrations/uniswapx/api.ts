// UniswapX API polling, order parsing, and filtering for USDC/WETH pair

import { decodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import {
  type UniswapXApiOrder,
  type UniswapXApiResponse,
  type V2DutchOrder,
  type ResolvedAmounts,
  V2_DUTCH_ORDER_ABI,
  ADDRESSES,
} from "./types";

const API_BASE = "https://api.uniswap.org/v2";

/** Fetch open V2 Dutch orders from UniswapX API.
 * Explicitly requests orderType=Dutch_V2 to avoid receiving V1, Priority,
 * or other order types that use different reactors and encoding. */
export async function fetchOpenOrders(chainId = 1): Promise<UniswapXApiOrder[]> {
  const url = `${API_BASE}/orders?orderStatus=open&chainId=${chainId}&orderType=Dutch_V2&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UniswapX API ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as UniswapXApiResponse;
  return data.orders;
}

/** Filter orders to only USDC/WETH pair (either direction) */
export function filterForPool(
  orders: UniswapXApiOrder[],
  asset0: Address = ADDRESSES.usdc,
  asset1: Address = ADDRESSES.weth,
): UniswapXApiOrder[] {
  const a0 = asset0.toLowerCase();
  const a1 = asset1.toLowerCase();

  return orders.filter((order) => {
    const inputToken = order.input.token.toLowerCase();
    const outputToken = order.outputs[0]?.token.toLowerCase();
    if (!outputToken) return false;

    // USDC -> WETH or WETH -> USDC
    return (
      (inputToken === a0 && outputToken === a1) ||
      (inputToken === a1 && outputToken === a0)
    );
  });
}

/** Decode V2DutchOrder from API encodedOrder bytes */
export function decodeV2DutchOrder(encodedOrder: Hex): V2DutchOrder {
  const [decoded] = decodeAbiParameters(V2_DUTCH_ORDER_ABI, encodedOrder);
  const d = decoded as {
    info: {
      reactor: Address;
      swapper: Address;
      nonce: bigint;
      deadline: bigint;
      additionalValidationContract: Address;
      additionalValidationData: Hex;
    };
    cosigner: Address;
    input: { token: Address; startAmount: bigint; endAmount: bigint };
    outputs: readonly {
      token: Address;
      startAmount: bigint;
      endAmount: bigint;
      recipient: Address;
    }[];
    cosignerData: {
      decayStartTime: bigint;
      decayEndTime: bigint;
      exclusiveFiller: Address;
      exclusivityOverrideBps: bigint;
      inputOverride: bigint;
      outputOverrides: readonly bigint[];
    };
    cosignature: Hex;
  };

  return {
    info: d.info,
    cosigner: d.cosigner,
    input: d.input,
    outputs: [...d.outputs],
    cosignerData: d.cosignerData,
    cosignature: d.cosignature,
  };
}

/**
 * Resolve V2 Dutch order amounts at a given timestamp.
 * Linear decay: input increases from start to end, outputs decrease.
 * Cosigner overrides replace start amounts when non-zero.
 */
export function resolveAmounts(
  order: V2DutchOrder,
  timestamp: bigint,
): ResolvedAmounts {
  const { decayStartTime, decayEndTime, inputOverride, outputOverrides } =
    order.cosignerData;

  // Effective start amounts (cosigner overrides take precedence)
  const inputStart =
    inputOverride > 0n ? inputOverride : order.input.startAmount;
  const inputEnd = order.input.endAmount;

  // Decay fraction [0, WAD]
  const fraction = decayFraction(timestamp, decayStartTime, decayEndTime);

  // Input decays UP (filler gets more input tokens over time)
  const inputAmount = linearDecay(inputStart, inputEnd, fraction);

  // Outputs decay DOWN (filler needs to provide fewer output tokens over time)
  const outputAmounts = order.outputs.map((output, i) => {
    const startAmt =
      outputOverrides[i] !== undefined && outputOverrides[i] > 0n
        ? outputOverrides[i]
        : output.startAmount;
    return linearDecay(startAmt, output.endAmount, fraction);
  });

  return { inputAmount, outputAmounts };
}

/** Compute linear decay fraction as numerator/WAD */
function decayFraction(
  timestamp: bigint,
  startTime: bigint,
  endTime: bigint,
): bigint {
  if (timestamp <= startTime) return 0n;
  if (timestamp >= endTime) return 10n ** 18n;
  return ((timestamp - startTime) * 10n ** 18n) / (endTime - startTime);
}

/** Linear interpolation: start + fraction * (end - start) / WAD */
function linearDecay(start: bigint, end: bigint, fraction: bigint): bigint {
  if (fraction === 0n) return start;
  if (fraction >= 10n ** 18n) return end;
  if (end >= start) {
    return start + ((end - start) * fraction) / 10n ** 18n;
  } else {
    return start - ((start - end) * fraction) / 10n ** 18n;
  }
}

/** Check if an order is expired */
export function isExpired(order: V2DutchOrder, timestamp: bigint): boolean {
  return timestamp > order.info.deadline;
}

/** Check if an order is in its exclusivity window */
export function isExclusive(order: V2DutchOrder, timestamp: bigint): boolean {
  const { exclusiveFiller, decayStartTime } = order.cosignerData;
  return (
    exclusiveFiller !== "0x0000000000000000000000000000000000000000" &&
    timestamp <= decayStartTime
  );
}

/** Format order for logging */
export function formatOrder(apiOrder: UniswapXApiOrder): string {
  const input = apiOrder.input;
  const output = apiOrder.outputs[0];
  if (!output) return `[no outputs]`;

  const inputSymbol = tokenSymbol(input.token);
  const outputSymbol = tokenSymbol(output.token);

  return `${inputSymbol}->${outputSymbol} in=${input.startAmount} out=${output.startAmount} hash=${apiOrder.orderHash.slice(0, 10)}`;
}

function tokenSymbol(addr: Address): string {
  const lower = addr.toLowerCase();
  if (lower === ADDRESSES.usdc.toLowerCase()) return "USDC";
  if (lower === ADDRESSES.weth.toLowerCase()) return "WETH";
  return addr.slice(0, 8);
}
