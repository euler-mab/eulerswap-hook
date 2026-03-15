// EulerSwap quote comparison for 1inch Fusion order profitability

import type { PublicClient, Address } from "viem";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import type { FusionApiOrder, ChainConfig } from "./types";
import { resolveAmounts, tokenSymbol, formatTokenAmount } from "./api";

export interface QuoteResult {
  orderHash: string;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  eulerSwapOutput: bigint;
  grossProfit: bigint;
  gasCost: bigint;
  netProfit: bigint;
  profitBps: number;
  withinLimits: boolean;
  profitable: boolean;
}

const GAS_ESTIMATE = 300_000n;
const PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei

/** Evaluate whether a Fusion order can be profitably filled via EulerSwap */
export async function evaluateOrder(
  client: PublicClient,
  apiOrder: FusionApiOrder,
  minProfitBps: number,
  config: ChainConfig,
): Promise<QuoteResult> {
  const { pool: poolAddress, wrappedNative } = config;
  const now = Math.floor(Date.now() / 1000);
  const { makingAmount, takingAmount } = resolveAmounts(apiOrder, now);
  const { makerAsset, takerAsset } = apiOrder.order;

  const [limits, eulerSwapOutput, gasPrice] = await Promise.all([
    client.readContract({
      address: poolAddress, abi: eulerSwapAbi,
      functionName: "getLimits", args: [makerAsset, takerAsset],
    }) as Promise<readonly [bigint, bigint]>,
    client.readContract({
      address: poolAddress, abi: eulerSwapAbi,
      functionName: "computeQuote", args: [makerAsset, takerAsset, makingAmount, true],
    }).catch(() => 0n) as Promise<bigint>,
    client.getGasPrice().catch(() => 10_000_000_000n),
  ]);

  const withinLimits = makingAmount <= limits[0];
  const gasCostWei = GAS_ESTIMATE * (gasPrice + PRIORITY_FEE);

  let gasCost: bigint;
  if (takerAsset.toLowerCase() === wrappedNative.toLowerCase()) {
    gasCost = gasCostWei;
  } else {
    // Convert gas cost to takerAsset via pool price
    const ethPrice = await client.readContract({
      address: poolAddress, abi: eulerSwapAbi,
      functionName: "computeQuote", args: [wrappedNative, takerAsset, 10n ** 18n, true],
    }).catch(() => 0n) as bigint;
    gasCost = ethPrice === 0n ? takingAmount : (gasCostWei * ethPrice) / 10n ** 18n;
  }

  const grossProfit = eulerSwapOutput - takingAmount;
  const netProfit = grossProfit - gasCost;
  const profitBps = takingAmount > 0n ? Number((netProfit * 10000n) / takingAmount) : 0;

  return {
    orderHash: apiOrder.orderHash,
    makerAsset, takerAsset, makingAmount, takingAmount,
    eulerSwapOutput, grossProfit, gasCost, netProfit, profitBps,
    withinLimits,
    profitable: withinLimits && netProfit > 0n && profitBps >= minProfitBps,
  };
}

export function formatQuote(q: QuoteResult, config?: ChainConfig): string {
  const makerSym = tokenSymbol(q.makerAsset, config);
  const takerSym = tokenSymbol(q.takerAsset, config);
  const makeAmt = formatTokenAmount(q.makingAmount, q.makerAsset, config);
  const needAmt = formatTokenAmount(q.takingAmount, q.takerAsset, config);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.takerAsset, config);
  const gas = formatTokenAmount(q.gasCost, q.takerAsset, config);
  const net = formatTokenAmount(q.netProfit > 0n ? q.netProfit : -q.netProfit, q.takerAsset, config);
  const sign = q.netProfit >= 0n ? "+" : "-";

  const flags = [
    !q.withinLimits ? "OVERLIMIT" : null,
    q.profitable ? "PROFITABLE" : null,
  ].filter(Boolean).join(",");

  return `${makerSym}->${takerSym} make=${makeAmt} need=${needAmt} es=${esOut} gas=${gas} ${sign}${net} (${q.profitBps}bps) [${flags || "skip"}]`;
}
