import type { PublicClient, WalletClient, Address, Hash } from "viem";
import type { AgentConfig, AssetDecimals } from "./types.js";
import { eulerSwapAbi, quoterV2Abi, arbitrageurAbi } from "./abi.js";
import { fmtToken } from "./types.js";

// Mainnet addresses
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address;

// Uni V3 fee tiers to try (0.01%, 0.05%, 0.3%, 1%)
const UNI_FEE_TIERS = [100, 500, 3000, 10000] as const;

// Trade sizes to probe, as fraction of equilibrium reserves (WAD-scaled)
const PROBE_PCTS = [1n, 2n, 5n, 10n, 20n]; // percent

export interface ArbConfig {
  enabled: boolean;
  arbitrageurAddress: Address;
  minProfitUsd: number; // minimum profit in USD to execute
  maxTradeUsd: number; // max trade size in USD
}

export interface ArbOpportunity {
  direction: "A" | "B"; // A = buy asset1 from pool, B = buy asset0 from pool
  amountOut: bigint; // amount to take from pool
  amountRequired: bigint; // what pool needs back
  uniAmountOut: bigint; // what Uniswap gives
  uniFee: number; // Uni fee tier
  profit: bigint; // uniAmountOut - amountRequired (in input token units)
  profitUsd: number; // estimated USD value
}

/**
 * Scan for arb opportunities across both directions and multiple trade sizes.
 * Returns the best opportunity if profitable, null otherwise.
 */
export async function checkArbOpportunity(
  publicClient: PublicClient,
  config: AgentConfig,
  arbConfig: ArbConfig,
  asset0: Address,
  asset1: Address,
  decimals: AssetDecimals,
  ethPriceUsd: number,
): Promise<ArbOpportunity | null> {
  // Read current reserves + prices + live gas price
  const [reserves, dParams, gasPrice] = await Promise.all([
    publicClient.readContract({
      address: config.poolAddress,
      abi: eulerSwapAbi,
      functionName: "getReserves",
    }),
    publicClient.readContract({
      address: config.poolAddress,
      abi: eulerSwapAbi,
      functionName: "getDynamicParams",
    }),
    publicClient.getGasPrice(),
  ]);

  const eqR0 = dParams.equilibriumReserve0;
  const eqR1 = dParams.equilibriumReserve1;

  let best: ArbOpportunity | null = null;

  for (const pct of PROBE_PCTS) {
    // Direction B: buy asset0 from pool, sell on Uni for asset1
    const amount0 = (eqR0 * pct) / 100n;
    if (amount0 > 0n) {
      const opp = await tryDirection(
        publicClient,
        config.poolAddress,
        "B",
        amount0,
        0n,
        asset0,
        asset1,
        decimals,
        ethPriceUsd,
        arbConfig,
        gasPrice,
      );
      if (opp && (!best || opp.profitUsd > best.profitUsd)) {
        best = opp;
      }
    }

    // Direction A: buy asset1 from pool, sell on Uni for asset0
    const amount1 = (eqR1 * pct) / 100n;
    if (amount1 > 0n) {
      const opp = await tryDirection(
        publicClient,
        config.poolAddress,
        "A",
        0n,
        amount1,
        asset0,
        asset1,
        decimals,
        ethPriceUsd,
        arbConfig,
        gasPrice,
      );
      if (opp && (!best || opp.profitUsd > best.profitUsd)) {
        best = opp;
      }
    }
  }

  return best;
}

async function tryDirection(
  publicClient: PublicClient,
  pool: Address,
  direction: "A" | "B",
  amount0Out: bigint,
  amount1Out: bigint,
  asset0: Address,
  asset1: Address,
  decimals: AssetDecimals,
  ethPriceUsd: number,
  arbConfig: ArbConfig,
  gasPrice: bigint,
): Promise<ArbOpportunity | null> {
  const amountOut = direction === "B" ? amount0Out : amount1Out;

  // Step 1: What does the pool need? (exact output quote)
  let amountRequired: bigint;
  try {
    if (direction === "B") {
      // Buying asset0 → pool needs asset1
      amountRequired = await publicClient.readContract({
        address: pool,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [asset1, asset0, amountOut, false],
      });
    } else {
      // Buying asset1 → pool needs asset0
      amountRequired = await publicClient.readContract({
        address: pool,
        abi: eulerSwapAbi,
        functionName: "computeQuote",
        args: [asset0, asset1, amountOut, false],
      });
    }
  } catch {
    return null; // Pool can't fill this size (boundary hit, etc.)
  }

  if (amountRequired <= 0n) return null;

  // Step 2: What does Uniswap give us for the output tokens?
  // Direction B: sell asset0 on Uni → get asset1 (compare with amountRequired in asset1)
  // Direction A: sell asset1 on Uni → get asset0 (compare with amountRequired in asset0)
  const uniTokenIn = direction === "B" ? asset0 : asset1;
  const uniTokenOut = direction === "B" ? asset1 : asset0;
  const uniAmountIn = amountOut;

  let bestUniOut = 0n;
  let bestFee = 0;

  for (const fee of UNI_FEE_TIERS) {
    try {
      const result = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: uniTokenIn,
            tokenOut: uniTokenOut,
            amountIn: uniAmountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const uniOut = result.result[0];
      if (uniOut > bestUniOut) {
        bestUniOut = uniOut;
        bestFee = fee;
      }
    } catch {
      continue; // This fee tier doesn't have liquidity
    }
  }

  if (bestUniOut <= amountRequired) return null; // Not profitable

  const profit = bestUniOut - amountRequired;

  // Estimate profit in USD
  const profitDec = direction === "B" ? decimals.dec1 : decimals.dec0;
  const profitHuman = Number(profit) / 10 ** profitDec;
  // For USDC-like (6 dec) stablecoins: profitHuman ≈ USD value
  // For WETH (18 dec): multiply by ETH price
  const profitUsd = profitDec === 6 ? profitHuman : profitHuman * ethPriceUsd;

  // Estimate gas cost (~250k gas for flash-swap + Uni swap) using live gas price
  const gasCostEth = (250_000 * Number(gasPrice)) / 1e18;
  const gasCostUsd = gasCostEth * ethPriceUsd;

  const netProfitUsd = profitUsd - gasCostUsd;
  if (netProfitUsd < arbConfig.minProfitUsd) return null;

  // Check max trade size
  const tradeSizeDec = direction === "B" ? decimals.dec0 : decimals.dec1;
  const tradeSizeHuman = Number(amountOut) / 10 ** tradeSizeDec;
  const tradeSizeUsd = tradeSizeDec === 6 ? tradeSizeHuman : tradeSizeHuman * ethPriceUsd;
  if (tradeSizeUsd > arbConfig.maxTradeUsd) return null;

  return {
    direction,
    amountOut,
    amountRequired,
    uniAmountOut: bestUniOut,
    uniFee: bestFee,
    profit,
    profitUsd: netProfitUsd,
  };
}

/**
 * Execute an arb opportunity via the Arbitrageur contract.
 */
export async function executeArb(
  opp: ArbOpportunity,
  walletClient: WalletClient,
  publicClient: PublicClient,
  config: AgentConfig,
  arbConfig: ArbConfig,
): Promise<{ txHash: Hash; gasUsed: bigint; success: boolean }> {
  const account = walletClient.account;
  if (!account) throw new Error("Wallet client has no account");

  const block = await publicClient.getBlock();
  const deadline = block.timestamp + 120n; // 2 minute deadline

  const amount0Out = opp.direction === "B" ? opp.amountOut : 0n;
  const amount1Out = opp.direction === "A" ? opp.amountOut : 0n;

  const txHash = await walletClient.writeContract({
    address: arbConfig.arbitrageurAddress,
    abi: arbitrageurAbi,
    functionName: "execute",
    args: [
      config.poolAddress,
      amount0Out,
      amount1Out,
      opp.amountRequired,
      opp.uniFee,
      0n, // minProfit = 0 (the on-chain Uni swap enforces amountOutMinimum)
      deadline,
    ],
    account,
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 120_000,
  });

  return {
    txHash,
    gasUsed: receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n),
    success: receipt.status === "success",
  };
}

export function formatOpportunity(
  opp: ArbOpportunity,
  decimals: AssetDecimals,
): string {
  const profitDec = opp.direction === "B" ? decimals.dec1 : decimals.dec0;
  const profitToken = opp.direction === "B" ? "asset1" : "asset0";
  const outDec = opp.direction === "B" ? decimals.dec0 : decimals.dec1;
  return `Dir ${opp.direction}: take ${fmtToken(opp.amountOut, outDec)} → Uni fee ${opp.uniFee} → profit ${fmtToken(opp.profit, profitDec)} ${profitToken} ($${opp.profitUsd.toFixed(2)})`;
}
