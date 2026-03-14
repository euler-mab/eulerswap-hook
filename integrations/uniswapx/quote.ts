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
 * Evaluate whether an order can be profitably filled via EulerSwap.
 * Reads computeQuote and getLimits from the pool.
 */
/** Default gas estimate for callback fill path.
 * Starts at 250k (conservative). Updated at runtime via GasEstimator
 * which tracks actual simulation results with an EMA. */
const DEFAULT_GAS_ESTIMATE = 250_000n;
const DEFAULT_PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei
/** Buffer added to current time when resolving decay.
 * Accounts for the delay between evaluation and on-chain execution.
 * 2 blocks (24s) is conservative for Flashbots bundles targeting block+1/+2. */
const DECAY_BUFFER_SECONDS = 24n;
/** Minimum remaining lifetime for an order to be worth evaluating.
 * Orders expiring within this window will likely expire before our tx lands. */
const MIN_REMAINING_SECONDS = 30n;

/**
 * Adaptive gas estimator using exponential moving average (EMA).
 * Feeds simulation gas results back into profitability evaluation.
 *
 * - Starts with a conservative default (250k)
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
    initialEstimate: bigint = DEFAULT_GAS_ESTIMATE,
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

export async function evaluateOrder(
  client: PublicClient,
  apiOrder: UniswapXApiOrder,
  minProfitBps: number,
  poolAddress: Address = ADDRESSES.pool,
  gasEstimate: bigint = DEFAULT_GAS_ESTIMATE,
): Promise<QuoteResult> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const decoded = decodeV2DutchOrder(apiOrder.encodedOrder);

  // Skip orders that will expire before our tx can land.
  // Checked before RPC calls to avoid wasting gas estimation on doomed orders.
  if (decoded.info.deadline <= now + MIN_REMAINING_SECONDS) {
    return {
      orderHash: apiOrder.orderHash,
      inputToken: decoded.input.token,
      outputToken: decoded.outputs[0]?.token ?? ("0x0000000000000000000000000000000000000000" as Address),
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

  // Decay is evaluated at `now`. Dutch decay favors the filler over time (outputs
  // decrease, inputs increase), so `now` is conservative — the on-chain fill at
  // block.timestamp will be at least as favorable. The buffer is applied only to
  // the exclusivity check below: an order exclusive at `now` may be open by execution.
  const resolved = resolveAmounts(decoded, now);

  const inputToken = decoded.input.token;
  const inputAmount = resolved.inputAmount;

  // Guard: malformed orders with no outputs
  if (!decoded.outputs.length) {
    return {
      orderHash: apiOrder.orderHash,
      inputToken,
      outputToken: "0x0000000000000000000000000000000000000000" as Address,
      inputAmount,
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
      gasCost: 0n,
      netProfit: 0n,
      profitBps: 0,
      withinLimits: false,
      exclusive: false,
      profitable: false,
    };
  }
  let requiredOutput = resolved.outputAmounts.reduce((a, b) => a + b, 0n);

  // Check exclusivity and override penalty.
  // Use now + buffer for exclusivity: if the order exits exclusivity within the
  // buffer window, we can still fill it (our tx lands after exclusivity ends).
  const { exclusiveFiller, decayStartTime, exclusivityOverrideBps } =
    decoded.cosignerData;
  const executionTime = now + DECAY_BUFFER_SECONDS;
  const inExclusivityWindow =
    exclusiveFiller !== "0x0000000000000000000000000000000000000000" &&
    executionTime <= decayStartTime;
  // exclusivityOverrideBps = 0 means strict exclusivity (unfillable by non-exclusive)
  const strictExclusive = inExclusivityWindow && exclusivityOverrideBps === 0n;
  const exclusive = strictExclusive;

  // Apply exclusivity override penalty: outputs scale up by (10000 + overrideBps) / 10000
  // This matches ExclusivityLib.sol: output.amount.mulDivUp(BPS + overrideBps, BPS)
  if (inExclusivityWindow && !strictExclusive && exclusivityOverrideBps > 0n) {
    requiredOutput =
      (requiredOutput * (10000n + exclusivityOverrideBps) + 9999n) / 10000n; // round up
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
  const effectiveGasPrice = gasPrice + DEFAULT_PRIORITY_FEE;
  const gasCostWei = gasEstimate * effectiveGasPrice;
  let gasCost: bigint;
  if (outputToken.toLowerCase() === ADDRESSES.weth.toLowerCase()) {
    gasCost = gasCostWei; // already in WETH wei
  } else {
    // Convert ETH gas cost to USDC using pool price
    const ethPriceUsdc = await client
      .readContract({
        address: poolAddress,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [ADDRESSES.weth, ADDRESSES.usdc, 10n ** 18n, true],
      })
      .catch(() => 2000_000_000n) as bigint; // fallback ~$2000
    gasCost = (gasCostWei * ethPriceUsdc) / 10n ** 18n;
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

/** Format amounts for human-readable logging */
export function formatQuote(q: QuoteResult): string {
  const inSym = tokenSymbol(q.inputToken);
  const outSym = tokenSymbol(q.outputToken);
  const inAmt = formatTokenAmount(q.inputAmount, q.inputToken);
  const outReq = formatTokenAmount(q.requiredOutput, q.outputToken);
  const esOut = formatTokenAmount(q.eulerSwapOutput, q.outputToken);
  const gas = formatTokenAmount(q.gasCost, q.outputToken);
  const net = formatTokenAmount(
    q.netProfit > 0n ? q.netProfit : -q.netProfit,
    q.outputToken,
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
