import type { PublicClient, Address } from "viem";
import type { AgentConfig, PoolSnapshot, HookStats, HookFeeParams } from "./types.js";
import { eulerSwapAbi, evaultAbi, priceOracleAbi, hookAbi } from "./abi.js";
import { WAD } from "./types.js";

// Cached vault metadata (immutable, only needs one read)
let cachedVaultMeta: {
  supplyVault0: Address;
  asset0: Address;
  asset1: Address;
  oracleAddr: Address;
  unitOfAccount: Address;
} | null = null;

/** Read and cache immutable vault/oracle addresses from pool's static params */
async function getVaultMeta(client: PublicClient, config: AgentConfig) {
  if (cachedVaultMeta) return cachedVaultMeta;

  const staticParams = await client.readContract({
    address: config.poolAddress,
    abi: eulerSwapAbi,
    functionName: "getStaticParams",
  });

  const [oracleAddr, unitOfAccount, asset0, asset1] = await Promise.all([
    client.readContract({
      address: staticParams.supplyVault0 as Address,
      abi: evaultAbi,
      functionName: "oracle",
    }),
    client.readContract({
      address: staticParams.supplyVault0 as Address,
      abi: evaultAbi,
      functionName: "unitOfAccount",
    }),
    client.readContract({
      address: staticParams.supplyVault0 as Address,
      abi: evaultAbi,
      functionName: "asset",
    }),
    client.readContract({
      address: staticParams.supplyVault1 as Address,
      abi: evaultAbi,
      functionName: "asset",
    }),
  ]);

  cachedVaultMeta = {
    supplyVault0: staticParams.supplyVault0 as Address,
    asset0: asset0 as Address,
    asset1: asset1 as Address,
    oracleAddr: oracleAddr as Address,
    unitOfAccount: unitOfAccount as Address,
  };
  return cachedVaultMeta;
}

/** Read the real oracle price: asset1 per 1 WAD of asset0.
 *  Matches LPAgentHook._getOraclePrice() exactly. */
async function readOraclePrice(
  client: PublicClient,
  config: AgentConfig
): Promise<bigint> {
  const meta = await getVaultMeta(client, config);
  if (meta.oracleAddr === "0x0000000000000000000000000000000000000000") return 0n;

  const [price0, price1] = await Promise.all([
    client.readContract({
      address: meta.oracleAddr,
      abi: priceOracleAbi,
      functionName: "getQuote",
      args: [WAD, meta.asset0, meta.unitOfAccount],
    }),
    client.readContract({
      address: meta.oracleAddr,
      abi: priceOracleAbi,
      functionName: "getQuote",
      args: [WAD, meta.asset1, meta.unitOfAccount],
    }),
  ]);

  if (price1 === 0n) return 0n;
  return (price0 * WAD) / price1;
}

export async function getPoolSnapshot(
  client: PublicClient,
  config: AgentConfig
): Promise<PoolSnapshot> {
  // Batch read on-chain state + real oracle price
  const [reserves, dynamicParams, block, oraclePrice] = await Promise.all([
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
    readOraclePrice(client, config),
  ]);

  const [reserve0, reserve1] = reserves;
  const dParams = dynamicParams;

  // Marginal price = reserve1 / reserve0 (WAD-scaled)
  const marginalPrice =
    reserve0 > 0n ? (reserve1 * WAD) / reserve0 : 0n;

  // Mismatch: |oracle - marginal| / oracle
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
