import type { PublicClient } from "viem";
import type { AgentConfig, PoolSnapshot, HookStats, HookFeeParams } from "./types.js";
import { eulerSwapAbi, hookAbi } from "./abi.js";
import { WAD } from "./types.js";

export async function getPoolSnapshot(
  client: PublicClient,
  config: AgentConfig
): Promise<PoolSnapshot> {
  // Batch read on-chain state
  const [reserves, dynamicParams, block] = await Promise.all([
    client.readContract({
      address: config.poolAddress,
      abi: eulerSwapAbi,
      functionName: "getReserves",
    }),
    client.readContract({
      address: config.poolAddress,
      abi: eulerSwapAbi,
      functionName: "getDynamicParams",
    }),
    client.getBlock(),
  ]);

  const [reserve0, reserve1] = reserves;
  const dParams = dynamicParams;

  // Marginal price = reserve1 / reserve0 (WAD-scaled)
  const marginalPrice =
    reserve0 > 0n ? (reserve1 * WAD) / reserve0 : 0n;

  // Oracle price: priceX / priceY (these are the pool's curve price params)
  // For the actual oracle price, we'd need to call the hook's internal oracle
  // For now, use priceX/priceY as proxy (they reflect the configured oracle price)
  const oraclePrice =
    dParams.priceY > 0n ? (dParams.priceX * WAD) / dParams.priceY : 0n;

  // Mismatch
  let mismatch = 0n;
  if (oraclePrice > 0n) {
    if (oraclePrice > marginalPrice) {
      mismatch = ((oraclePrice - marginalPrice) * WAD) / oraclePrice;
    } else {
      mismatch = ((marginalPrice - oraclePrice) * WAD) / oraclePrice;
    }
  }

  return {
    timestamp: Number(block.timestamp),
    blockNumber: block.number,
    reserve0,
    reserve1,
    equilibriumReserve0: dParams.equilibriumReserve0,
    equilibriumReserve1: dParams.equilibriumReserve1,
    priceX: dParams.priceX,
    priceY: dParams.priceY,
    concentrationX: dParams.concentrationX,
    concentrationY: dParams.concentrationY,
    fee0: dParams.fee0,
    fee1: dParams.fee1,
    oraclePrice,
    marginalPrice,
    mismatch,
  };
}

export async function getHookStats(
  client: PublicClient,
  config: AgentConfig
): Promise<HookStats> {
  const result = await client.readContract({
    address: config.hookAddress,
    abi: hookAbi,
    functionName: "getTradeStats",
  });

  return {
    tradeCount: result[0],
    cumulativeVolume0: result[1],
    cumulativeVolume1: result[2],
    lastTradeAsset0In: result[3],
    lastTradeSize: result[4],
    lastTradeBlock: result[5],
  };
}

export async function getHookFeeParams(
  client: PublicClient,
  config: AgentConfig
): Promise<HookFeeParams> {
  const result = await client.readContract({
    address: config.hookAddress,
    abi: hookAbi,
    functionName: "getFeeParams",
  });

  return {
    baseFee: result[0],
    maxFee: result[1],
    minFee: result[2],
    mismatchScale: result[3],
    paused: result[4],
  };
}
