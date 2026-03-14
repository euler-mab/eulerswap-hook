// EulerSwap quote comparison for 1inch Fusion order profitability

import type { PublicClient, Address } from "viem";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import type { FusionApiOrder } from "./types";
import { ADDRESSES } from "./types";
import { resolveAmounts } from "./api";

export interface QuoteResult {
  orderHash: string;
  /** Token the resolver receives from the maker (makerAsset) */
  makerAsset: Address;
  /** Token the resolver must provide to the maker (takerAsset) */
  takerAsset: Address;
  /** Amount of makerAsset received */
  makingAmount: bigint;
  /** Amount of takerAsset required (after auction decay) */
  takingAmount: bigint;
  /** Amount of takerAsset EulerSwap would give for the makerAsset */
  eulerSwapOutput: bigint;
  /** Gross profit in takerAsset units (eulerSwapOutput - takingAmount) */
  grossProfit: bigint;
  /** Estimated gas cost in takerAsset units */
  gasCost: bigint;
  /** Net profit after gas */
  netProfit: bigint;
  /** Net profit in basis points of takingAmount */
  profitBps: number;
  /** Whether the pool can handle this order size */
  withinLimits: boolean;
  /** Whether filling is profitable after gas and min threshold */
  profitable: boolean;
}

const DEFAULT_GAS_ESTIMATE = 300_000n; // slightly higher than UniswapX due to LOP overhead
const DEFAULT_PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei

/**
 * Evaluate whether a Fusion order can be profitably filled via EulerSwap.
 *
 * The resolver receives makerAsset and must provide takerAsset.
 * We check if swapping the makerAsset through EulerSwap produces enough takerAsset.
 */
export async function evaluateOrder(
  client: PublicClient,
  apiOrder: FusionApiOrder,
  minProfitBps: number,
  poolAddress: Address = ADDRESSES.pool,
  gasEstimate: bigint = DEFAULT_GAS_ESTIMATE,
): Promise<QuoteResult> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = resolveAmounts(apiOrder, now);

  const makerAsset = apiOrder.order.makerAsset;
  const takerAsset = apiOrder.order.takerAsset;
  const { makingAmount, takingAmount } = resolved;

  // Check pool limits + get quote + get gas price in parallel
  const [limits, eulerSwapOutput, gasPrice] = await Promise.all([
    client.readContract({
      address: poolAddress,
      abi: eulerSwapAbi,
      functionName: "getLimits",
      args: [makerAsset, takerAsset],
    }) as Promise<readonly [bigint, bigint]>,
    client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [makerAsset, takerAsset, makingAmount, true],
      })
      .catch(() => 0n) as Promise<bigint>,
    client.getGasPrice().catch(() => 10_000_000_000n),
  ]);

  const [limitIn] = limits;
  const withinLimits = makingAmount <= limitIn;

  // Compute gas cost in takerAsset units
  const effectiveGasPrice = gasPrice + DEFAULT_PRIORITY_FEE;
  const gasCostWei = gasEstimate * effectiveGasPrice;
  let gasCost: bigint;
  if (takerAsset.toLowerCase() === ADDRESSES.weth.toLowerCase()) {
    gasCost = gasCostWei;
  } else {
    // Convert ETH gas cost to takerAsset (USDC) via pool price
    const ethPrice = await client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [ADDRESSES.weth, ADDRESSES.usdc, 10n ** 18n, true],
      })
      .catch(() => 2000_000_000n) as bigint;
    gasCost = (gasCostWei * ethPrice) / 10n ** 18n;
  }

  const grossProfit = eulerSwapOutput - takingAmount;
  const netProfit = grossProfit - gasCost;
  const profitBps =
    takingAmount > 0n ? Number((netProfit * 10000n) / takingAmount) : 0;

  return {
    orderHash: apiOrder.orderHash,
    makerAsset,
    takerAsset,
    makingAmount,
    takingAmount,
    eulerSwapOutput,
    grossProfit,
    gasCost,
    netProfit,
    profitBps,
    withinLimits,
    profitable: withinLimits && netProfit > 0n && profitBps >= minProfitBps,
  };
}

/** Format a quote result for human-readable logging */
export function formatQuote(q: QuoteResult): string {
  const makerSym = tokenSymbol(q.makerAsset);
  const takerSym = tokenSymbol(q.takerAsset);
  const makeAmt = formatTokenAmount(q.makingAmount, q.makerAsset);
  const needAmt = formatTokenAmount(q.takingAmount, q.takerAsset);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.takerAsset);
  const gas = formatTokenAmount(q.gasCost, q.takerAsset);
  const net = formatTokenAmount(
    q.netProfit > 0n ? q.netProfit : -q.netProfit,
    q.takerAsset,
  );
  const sign = q.netProfit >= 0n ? "+" : "-";

  const flags = [
    !q.withinLimits ? "OVERLIMIT" : null,
    q.profitable ? "PROFITABLE" : null,
  ]
    .filter(Boolean)
    .join(",");

  return `${makerSym}->${takerSym} make=${makeAmt} need=${needAmt} es=${esOut} gas=${gas} ${sign}${net} (${q.profitBps}bps) [${flags || "skip"}]`;
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
