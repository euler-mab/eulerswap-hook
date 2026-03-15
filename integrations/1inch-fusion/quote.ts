// EulerSwap quote comparison for 1inch Fusion order profitability

import type { PublicClient, Address } from "viem";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import type { FusionApiOrder, ChainConfig } from "./types";
import { resolveAmounts, tokenSymbol, formatTokenAmount } from "./api";

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
  config: ChainConfig,
  gasEstimate: bigint = DEFAULT_GAS_ESTIMATE,
): Promise<QuoteResult> {
  const poolAddress = config.pool;
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
  if (takerAsset.toLowerCase() === config.wrappedNative.toLowerCase()) {
    gasCost = gasCostWei;
  } else {
    // Convert ETH gas cost to takerAsset via pool price
    // Use the pool's own quote as price source — no hardcoded fallback
    const ethPrice = await client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [config.wrappedNative, takerAsset, 10n ** 18n, true],
      })
      .catch(() => {
        // If pool quote fails, we can't accurately price gas — reject the order
        // by returning a very high gas cost
        return 0n;
      }) as bigint;
    if (ethPrice === 0n) {
      // Pool can't quote — set gasCost high to reject
      gasCost = takingAmount;
    } else {
      gasCost = (gasCostWei * ethPrice) / 10n ** 18n;
    }
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
export function formatQuote(q: QuoteResult, config?: ChainConfig): string {
  const makerSym = tokenSymbol(q.makerAsset, config);
  const takerSym = tokenSymbol(q.takerAsset, config);
  const makeAmt = formatTokenAmount(q.makingAmount, q.makerAsset, config);
  const needAmt = formatTokenAmount(q.takingAmount, q.takerAsset, config);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.takerAsset, config);
  const gas = formatTokenAmount(q.gasCost, q.takerAsset, config);
  const net = formatTokenAmount(
    q.netProfit > 0n ? q.netProfit : -q.netProfit,
    q.takerAsset,
    config,
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
