// EulerSwap quote comparison for UniswapX order profitability

import type { PublicClient, Address } from "viem";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import type { UniswapXApiOrder, V2DutchOrder, ResolvedAmounts } from "./types";
import { ADDRESSES } from "./types";
import { decodeV2DutchOrder, resolveAmounts } from "./api";

export interface QuoteResult {
  orderHash: string;
  inputToken: Address;
  outputToken: Address;
  /** Amount of input tokens the filler receives from the swapper */
  inputAmount: bigint;
  /** Amount of output tokens the filler must provide to the swapper */
  requiredOutput: bigint;
  /** Amount of output tokens EulerSwap would give for the input */
  eulerSwapOutput: bigint;
  /** Gross profit in output token units (eulerSwapOutput - requiredOutput) */
  grossProfit: bigint;
  /** Gross profit in basis points of required output */
  profitBps: number;
  /** Whether the pool can handle this order size */
  withinLimits: boolean;
  /** Whether the order is in exclusivity window */
  exclusive: boolean;
  /** Whether filling is profitable after min threshold */
  profitable: boolean;
}

/**
 * Evaluate whether an order can be profitably filled via EulerSwap.
 * Reads computeQuote and getLimits from the pool.
 */
export async function evaluateOrder(
  client: PublicClient,
  apiOrder: UniswapXApiOrder,
  minProfitBps: number,
  poolAddress: Address = ADDRESSES.pool,
): Promise<QuoteResult> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const decoded = decodeV2DutchOrder(apiOrder.encodedOrder);
  const resolved = resolveAmounts(decoded, now);

  const inputToken = decoded.input.token;
  const inputAmount = resolved.inputAmount;

  // All outputs must be the same token (standard for UniswapX swaps).
  // Sum all output amounts (covers fee-recipient splits).
  const outputToken = decoded.outputs[0].token;
  const allSameToken = decoded.outputs.every(
    (o) => o.token.toLowerCase() === outputToken.toLowerCase(),
  );
  if (!allSameToken) {
    return {
      orderHash: apiOrder.orderHash,
      inputToken,
      outputToken,
      inputAmount,
      requiredOutput: 0n,
      eulerSwapOutput: 0n,
      grossProfit: 0n,
      profitBps: 0,
      withinLimits: false,
      exclusive: false,
      profitable: false,
    };
  }
  const requiredOutput = resolved.outputAmounts.reduce((a, b) => a + b, 0n);

  // Check exclusivity
  const { exclusiveFiller, decayStartTime } = decoded.cosignerData;
  const exclusive =
    exclusiveFiller !== "0x0000000000000000000000000000000000000000" &&
    now <= decayStartTime;

  // Check pool limits
  const [limits, eulerSwapOutput] = await Promise.all([
    client.readContract({
      address: poolAddress,
      abi: eulerSwapAbi,
      functionName: "getLimits",
      args: [inputToken, outputToken],
    }) as Promise<readonly [bigint, bigint]>,
    client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [inputToken, outputToken, inputAmount, true],
      })
      .catch(() => 0n) as Promise<bigint>,
  ]);

  const [limitIn] = limits;
  const withinLimits = inputAmount <= limitIn;

  const grossProfit = eulerSwapOutput - requiredOutput;
  const profitBps =
    requiredOutput > 0n
      ? Number((grossProfit * 10000n) / requiredOutput)
      : 0;

  return {
    orderHash: apiOrder.orderHash,
    inputToken,
    outputToken,
    inputAmount,
    requiredOutput,
    eulerSwapOutput,
    grossProfit,
    profitBps,
    withinLimits,
    exclusive,
    profitable: !exclusive && withinLimits && profitBps >= minProfitBps,
  };
}

/** Format amounts for human-readable logging */
export function formatQuote(q: QuoteResult): string {
  const inSym = tokenSymbol(q.inputToken);
  const outSym = tokenSymbol(q.outputToken);
  const inAmt = formatTokenAmount(q.inputAmount, q.inputToken);
  const outReq = formatTokenAmount(q.requiredOutput, q.outputToken);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.outputToken);
  const profit = formatTokenAmount(
    q.grossProfit > 0n ? q.grossProfit : -q.grossProfit,
    q.outputToken,
  );
  const sign = q.grossProfit >= 0n ? "+" : "-";

  const flags = [
    q.exclusive ? "EXCLUSIVE" : null,
    !q.withinLimits ? "OVERLIMIT" : null,
    q.profitable ? "PROFITABLE" : null,
  ]
    .filter(Boolean)
    .join(",");

  return `${inSym}->${outSym} in=${inAmt} need=${outReq} es=${esOut} ${sign}${profit} (${q.profitBps}bps) [${flags || "skip"}]`;
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
    // 6 decimals
    return `${(Number(amount) / 1e6).toFixed(2)}`;
  }
  if (lower === ADDRESSES.weth.toLowerCase()) {
    // 18 decimals
    return `${(Number(amount) / 1e18).toFixed(6)}`;
  }
  return amount.toString();
}
