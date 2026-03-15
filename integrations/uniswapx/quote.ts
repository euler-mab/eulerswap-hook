// EulerSwap quote comparison for UniswapX order profitability

import type { PublicClient, Address } from "viem";
import { eulerSwapAbi } from "../../src/lib/pools/abi";
import type {
  UniswapXApiOrder,
  ChainConfig,
  PoolConfig,
  TokenInfo,
} from "./types";
import { tokenSymbol } from "./api";
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
  /** Estimated gas cost in output token units */
  gasCost: bigint;
  /** Net profit after gas (grossProfit - gasCost) */
  netProfit: bigint;
  /** Net profit in basis points of required output */
  profitBps: number;
  /** Whether the pool can handle this order size */
  withinLimits: boolean;
  /** Whether the order is in exclusivity window */
  exclusive: boolean;
  /** Whether filling is profitable after gas and min threshold */
  profitable: boolean;
}

/**
 * Adaptive gas estimator using exponential moving average (EMA).
 * Feeds simulation gas results back into profitability evaluation.
 *
 * - Starts with a conservative default (chain-specific)
 * - Updates after each successful simulation with the actual gas
 * - EMA smoothing factor α=0.3 — responsive but not noisy
 * - Adds a safety margin (20%) to avoid false positives from gas variance
 */
export class GasEstimator {
  private ema: number;
  private sampleCount = 0;
  private readonly alpha: number;
  private readonly safetyMargin: number;

  constructor(
    initialEstimate: bigint = 250_000n,
    alpha = 0.3,
    safetyMargin = 0.2,
  ) {
    this.ema = Number(initialEstimate);
    this.alpha = alpha;
    this.safetyMargin = safetyMargin;
  }

  /** Update the estimate with a new simulation gas measurement */
  update(gasUsed: bigint): void {
    const val = Number(gasUsed);
    if (val <= 0) return;
    if (this.sampleCount === 0) {
      // First sample: jump directly to observed value
      this.ema = val;
    } else {
      this.ema = this.alpha * val + (1 - this.alpha) * this.ema;
    }
    this.sampleCount++;
  }

  /** Get the current estimate with safety margin applied */
  get estimate(): bigint {
    return BigInt(Math.ceil(this.ema * (1 + this.safetyMargin)));
  }

  /** Raw EMA without safety margin (for logging) */
  get raw(): bigint {
    return BigInt(Math.ceil(this.ema));
  }

  /** Number of simulation samples incorporated */
  get samples(): number {
    return this.sampleCount;
  }
}

/** Find the WETH-equivalent token (18-decimal native wrapper) from the chain's pools */
function findWethToken(config: ChainConfig): TokenInfo | undefined {
  for (const pool of config.pools) {
    if (pool.asset0.symbol === "WETH") return pool.asset0;
    if (pool.asset1.symbol === "WETH") return pool.asset1;
  }
  return undefined;
}

/** Evaluate whether an order can be profitably filled via a specific EulerSwap pool */
export async function evaluateOrder(
  client: PublicClient,
  apiOrder: UniswapXApiOrder,
  minProfitBps: number,
  poolAddress: Address,
  gasEstimate: bigint,
  chainConfig: ChainConfig,
): Promise<QuoteResult> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const decoded = decodeV2DutchOrder(apiOrder.encodedOrder, chainConfig.reactorV2);

  // Derive timing constants from chain's block time
  const minRemainingSeconds = BigInt(chainConfig.gas.blockTimeSeconds * 3);
  const decayBufferSeconds = BigInt(chainConfig.gas.blockTimeSeconds * 2);

  // Skip orders that will expire before our tx can land.
  if (decoded.info.deadline <= now + minRemainingSeconds) {
    return emptyResult(apiOrder, decoded.input.token, decoded.outputs[0]?.token);
  }

  // Decay is evaluated at `now`. Dutch decay favors the filler over time (outputs
  // decrease, inputs increase), so `now` is conservative — the on-chain fill at
  // block.timestamp will be at least as favorable. The buffer is applied only to
  // the exclusivity check below: an order exclusive at `now` may be open by execution.
  const resolved = resolveAmounts(decoded, now);

  const inputToken = decoded.input.token;
  const inputAmount = resolved.inputAmount;

  // Guard: malformed orders with no outputs
  if (!decoded.outputs.length) {
    return emptyResult(apiOrder, inputToken);
  }

  // All outputs must be the same token (standard for UniswapX swaps).
  const outputToken = decoded.outputs[0].token;
  const allSameToken = decoded.outputs.every(
    (o) => o.token.toLowerCase() === outputToken.toLowerCase(),
  );
  if (!allSameToken) {
    return emptyResult(apiOrder, inputToken, outputToken);
  }
  let requiredOutput = resolved.outputAmounts.reduce((a, b) => a + b, 0n);

  // Check exclusivity and override penalty.
  const { exclusiveFiller, decayStartTime, exclusivityOverrideBps } =
    decoded.cosignerData;
  const executionTime = now + decayBufferSeconds;
  const inExclusivityWindow =
    exclusiveFiller !== "0x0000000000000000000000000000000000000000" &&
    executionTime <= decayStartTime;
  const strictExclusive = inExclusivityWindow && exclusivityOverrideBps === 0n;
  const exclusive = strictExclusive;

  // Apply exclusivity override penalty: outputs scale up by (10000 + overrideBps) / 10000
  if (inExclusivityWindow && !strictExclusive && exclusivityOverrideBps > 0n) {
    requiredOutput =
      (requiredOutput * (10000n + exclusivityOverrideBps) + 9999n) / 10000n;
  }

  // Check pool limits + get quote + get gas price
  const [limits, eulerSwapOutput, gasPrice] = await Promise.all([
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
    client.getGasPrice().catch(() => 10_000_000_000n), // fallback 10 gwei
  ]);

  const [limitIn] = limits;
  const withinLimits = inputAmount <= limitIn;

  // Compute gas cost in output token units
  const effectiveGasPrice = gasPrice + chainConfig.gas.defaultPriorityFee;
  const gasCostWei = gasEstimate * effectiveGasPrice;
  let gasCost: bigint;

  const wethToken = findWethToken(chainConfig);
  if (wethToken && outputToken.toLowerCase() === wethToken.address.toLowerCase()) {
    gasCost = gasCostWei; // already in WETH wei
  } else if (wethToken) {
    // Convert ETH gas cost to output token using pool price
    const ethPrice = await client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [wethToken.address, outputToken, 10n ** 18n, true],
      })
      .catch(() => 2000_000_000n) as bigint; // fallback ~$2000 USDC/ETH — only triggers when pool can't quote WETH→output (pool broken, order won't be profitable anyway)
    gasCost = (gasCostWei * ethPrice) / 10n ** 18n;
  } else {
    // No WETH token found — use raw wei as rough estimate
    gasCost = gasCostWei;
  }

  const grossProfit = eulerSwapOutput - requiredOutput;
  const netProfit = grossProfit - gasCost;
  const profitBps =
    requiredOutput > 0n
      ? Number((netProfit * 10000n) / requiredOutput)
      : 0;

  return {
    orderHash: apiOrder.orderHash,
    inputToken,
    outputToken,
    inputAmount,
    requiredOutput,
    eulerSwapOutput,
    grossProfit,
    gasCost,
    netProfit,
    profitBps,
    withinLimits,
    exclusive,
    profitable: !exclusive && withinLimits && netProfit > 0n && profitBps >= minProfitBps,
  };
}

/** Evaluate an order against multiple pools, return the best result */
export async function evaluateOrderAcrossPools(
  client: PublicClient,
  apiOrder: UniswapXApiOrder,
  minProfitBps: number,
  pools: PoolConfig[],
  gasEstimate: bigint,
  chainConfig: ChainConfig,
): Promise<{ quote: QuoteResult; pool: PoolConfig } | null> {
  const results = await Promise.all(
    pools.map(async (pool) => {
      const quote = await evaluateOrder(
        client,
        apiOrder,
        minProfitBps,
        pool.address,
        gasEstimate,
        chainConfig,
      );
      return { quote, pool };
    }),
  );

  // Pick the most profitable result
  let best: { quote: QuoteResult; pool: PoolConfig } | null = null;
  for (const r of results) {
    if (!r.quote.profitable) continue;
    if (!best || r.quote.netProfit > best.quote.netProfit) {
      best = r;
    }
  }

  return best;
}

/** Format amounts for human-readable logging */
export function formatQuote(q: QuoteResult, tokens: TokenInfo[]): string {
  const inSym = tokenSymbol(q.inputToken, tokens);
  const outSym = tokenSymbol(q.outputToken, tokens);
  const inAmt = formatTokenAmount(q.inputAmount, q.inputToken, tokens);
  const outReq = formatTokenAmount(q.requiredOutput, q.outputToken, tokens);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.outputToken, tokens);
  const gas = formatTokenAmount(q.gasCost, q.outputToken, tokens);
  const net = formatTokenAmount(
    q.netProfit > 0n ? q.netProfit : -q.netProfit,
    q.outputToken,
    tokens,
  );
  const sign = q.netProfit >= 0n ? "+" : "-";

  const flags = [
    q.exclusive ? "EXCLUSIVE" : null,
    !q.withinLimits ? "OVERLIMIT" : null,
    q.profitable ? "PROFITABLE" : null,
  ]
    .filter(Boolean)
    .join(",");

  return `${inSym}->${outSym} in=${inAmt} need=${outReq} es=${esOut} gas=${gas} ${sign}${net} (${q.profitBps}bps) [${flags || "skip"}]`;
}

function formatTokenAmount(
  amount: bigint,
  token: Address,
  tokens: TokenInfo[],
): string {
  const lower = token.toLowerCase();
  const info = tokens.find((t) => t.address.toLowerCase() === lower);
  const decimals = info?.decimals ?? 18;
  const value = Number(amount) / 10 ** decimals;
  return decimals <= 8 ? value.toFixed(2) : value.toFixed(6);
}

function emptyResult(
  apiOrder: UniswapXApiOrder,
  inputToken: Address,
  outputToken?: Address,
): QuoteResult {
  return {
    orderHash: apiOrder.orderHash,
    inputToken,
    outputToken: outputToken ?? ("0x0000000000000000000000000000000000000000" as Address),
    inputAmount: 0n,
    requiredOutput: 0n,
    eulerSwapOutput: 0n,
    grossProfit: 0n,
    gasCost: 0n,
    netProfit: 0n,
    profitBps: 0,
    withinLimits: false,
    exclusive: false,
    profitable: false,
  };
}
