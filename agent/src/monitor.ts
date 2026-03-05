import type { PublicClient, Address } from "viem";
import type { AgentConfig, PoolSnapshot, HookStats, HookFeeParams, VaultDebtInfo } from "./types.js";
import { eulerSwapAbi, evaultAbi, priceOracleAbi, hookAbi } from "./abi.js";
import { WAD } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const RAY = 10n ** 27n;
const SECONDS_PER_DAY = 86400n;

// Cached vault metadata (immutable, only needs one read)
let cachedVaultMeta: {
  supplyVault0: Address;
  supplyVault1: Address;
  borrowVault0: Address;
  borrowVault1: Address;
  eulerAccount: Address;
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
    supplyVault1: staticParams.supplyVault1 as Address,
    borrowVault0: staticParams.borrowVault0 as Address,
    borrowVault1: staticParams.borrowVault1 as Address,
    eulerAccount: staticParams.eulerAccount as Address,
    asset0: asset0 as Address,
    asset1: asset1 as Address,
    oracleAddr: oracleAddr as Address,
    unitOfAccount: unitOfAccount as Address,
  };
  return cachedVaultMeta;
}

/**
 * Read oracle prices for both assets and the combined ratio.
 *
 * Oracle chain: pool.getStaticParams() → supplyVault0 → vault.oracle() → IPriceOracle.
 * The oracle's getQuote(WAD, asset, unitOfAccount) returns the value of 1e18 raw units
 * of the asset in the unit of account (e.g. USD). Results:
 *   price0 = getQuote(WAD, asset0, uoa)  — e.g. 1e30 for USDC ($1e12 worth of 1e18 raw USDC)
 *   price1 = getQuote(WAD, asset1, uoa)  — e.g. 2500e18 for WETH ($2500 per 1 WETH)
 *   oraclePrice = (price0 * WAD) / price1 — matches LPAgentHook._getOraclePrice()
 *
 * The individual prices are needed for reconfiguring the pool's priceX/priceY curve
 * parameters: priceX = price0 / WAD, priceY = price1 / WAD.
 */
async function readOraclePrices(
  client: PublicClient,
  config: AgentConfig
): Promise<{ oraclePrice: bigint; price0: bigint; price1: bigint }> {
  const meta = await getVaultMeta(client, config);
  if (meta.oracleAddr === "0x0000000000000000000000000000000000000000") {
    return { oraclePrice: 0n, price0: 0n, price1: 0n };
  }

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

  const oraclePrice = price1 === 0n ? 0n : (price0 * WAD) / price1;
  return { oraclePrice, price0, price1 };
}

export async function getPoolSnapshot(
  client: PublicClient,
  config: AgentConfig
): Promise<PoolSnapshot> {
  // Batch read on-chain state + real oracle price
  const [reserves, dynamicParams, block, oraclePrices] = await Promise.all([
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
    readOraclePrices(client, config),
  ]);
  const { oraclePrice, price0: oraclePrice0, price1: oraclePrice1 } = oraclePrices;

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
    oraclePrice0,
    oraclePrice1,
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

export async function getVaultDebtInfo(
  client: PublicClient,
  config: AgentConfig
): Promise<VaultDebtInfo> {
  const meta = await getVaultMeta(client, config);
  const hasBorrow0 = meta.borrowVault0 !== ZERO_ADDRESS;
  const hasBorrow1 = meta.borrowVault1 !== ZERO_ADDRESS;

  // Read debt and utilization for each borrow vault (skip if no borrow vault)
  const [debt0, debt1, borrowRate0, borrowRate1, totalBorrows0, totalAssets0, totalBorrows1, totalAssets1, shares0, shares1] =
    await Promise.all([
      hasBorrow0
        ? client.readContract({ address: meta.borrowVault0, abi: evaultAbi, functionName: "debtOf", args: [meta.eulerAccount] })
        : Promise.resolve(0n),
      hasBorrow1
        ? client.readContract({ address: meta.borrowVault1, abi: evaultAbi, functionName: "debtOf", args: [meta.eulerAccount] })
        : Promise.resolve(0n),
      hasBorrow0
        ? client.readContract({ address: meta.borrowVault0, abi: evaultAbi, functionName: "interestRate" })
        : Promise.resolve(0n),
      hasBorrow1
        ? client.readContract({ address: meta.borrowVault1, abi: evaultAbi, functionName: "interestRate" })
        : Promise.resolve(0n),
      hasBorrow0
        ? client.readContract({ address: meta.borrowVault0, abi: evaultAbi, functionName: "totalBorrows" })
        : Promise.resolve(0n),
      hasBorrow0
        ? client.readContract({ address: meta.borrowVault0, abi: evaultAbi, functionName: "totalAssets" })
        : Promise.resolve(1n),
      hasBorrow1
        ? client.readContract({ address: meta.borrowVault1, abi: evaultAbi, functionName: "totalBorrows" })
        : Promise.resolve(0n),
      hasBorrow1
        ? client.readContract({ address: meta.borrowVault1, abi: evaultAbi, functionName: "totalAssets" })
        : Promise.resolve(1n),
      // Pool's supply vault deposits (shares → assets)
      client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "balanceOf", args: [meta.eulerAccount] }),
      client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "balanceOf", args: [meta.eulerAccount] }),
    ]);

  const [deposit0, deposit1] = await Promise.all([
    client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "convertToAssets", args: [shares0 as bigint] }),
    client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "convertToAssets", args: [shares1 as bigint] }),
  ]);

  const utilization0 = (totalAssets0 as bigint) > 0n
    ? (totalBorrows0 as bigint) * WAD / (totalAssets0 as bigint)
    : 0n;
  const utilization1 = (totalAssets1 as bigint) > 0n
    ? (totalBorrows1 as bigint) * WAD / (totalAssets1 as bigint)
    : 0n;

  // Daily interest cost: debt × rate × 86400 / 1e27
  const dailyCost0 = (debt0 as bigint) * (borrowRate0 as bigint) * SECONDS_PER_DAY / RAY;
  const dailyCost1 = (debt1 as bigint) * (borrowRate1 as bigint) * SECONDS_PER_DAY / RAY;

  return {
    debt0: debt0 as bigint,
    debt1: debt1 as bigint,
    deposit0: deposit0 as bigint,
    deposit1: deposit1 as bigint,
    utilization0,
    utilization1,
    borrowRate0: borrowRate0 as bigint,
    borrowRate1: borrowRate1 as bigint,
    dailyCost0,
    dailyCost1,
    hasBorrowVault0: hasBorrow0,
    hasBorrowVault1: hasBorrow1,
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
