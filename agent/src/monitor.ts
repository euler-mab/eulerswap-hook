import type { PublicClient, Address } from "viem";
import type { AgentConfig, PoolSnapshot, HookFeeParams, VaultDebtInfo, RegistryInfo } from "./types.js";
import { eulerSwapAbi, evaultAbi, priceOracleAbi, hookAbi, registryAbi } from "./abi.js";
import { WAD } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const RAY = 10n ** 27n;
const SECONDS_PER_DAY = 86400n;

/**
 * Compute the true marginal price from the EulerSwap curve.
 *
 * The curve (for c=0) is a hyperbola in two branches meeting at (x0, y0):
 *   Branch 1 (x ≤ x0, y ≥ y0): y = y0 + px·x0·(x0−x) / (py·x)
 *     → |dy/dx| = px·x0² / (py·x²)
 *   Branch 2 (x > x0, y < y0): x = x0 + py·y0·(y0−y) / (px·y)
 *     → |dy/dx| = px·y² / (py·y0²)
 *
 * For c > 0 the b-term in CurveLib.f changes (b = c·x + (1−c)·x0) which
 * modifies the derivative. The general formula:
 *   Branch 1: |dy/dx| = px·x0 / (py·x) · [cx·(2·x0 − x)/x + (1−cx)·x0/x]
 *     simplifying: px·x0·(cx·x + (1−cx)·x0 + cx·(x0−x)) / (py·x²)
 *     = px·x0·(2·cx·x0 − 2·cx·x + x0 + cx·x − cx·x0 + cx·x) / ...
 *     Actually for c=0 this reduces to px·x0²/(py·x²) ✓
 *   For simplicity and correctness, we compute the numerical derivative:
 *     |dy/dx| ≈ (f(x−δ) − f(x+δ)) / (2δ)  using the curve equations.
 *
 * Returns the result WAD-scaled (raw asset1 per raw asset0 × 1e18).
 */
function computeMarginalPrice(
  reserve0: bigint, reserve1: bigint,
  px: bigint, py: bigint,
  x0: bigint, y0: bigint,
  cx: bigint, cy: bigint,
): bigint {
  if (reserve0 === 0n || py === 0n) return 0n;

  // Branch 1: reserve0 ≤ x0 (current reserves below equilibrium for asset0)
  // Branch 2: reserve0 > x0
  if (reserve0 <= x0) {
    // |dy/dx| = px·x0² / (py·x²) for c=0
    // For c>0: derivative of y = y0 + px·(x0−x)·b / (1e18·x·py)
    //   where b = cx·x + (1e18−cx)·x0
    //   dy/dx = px / (1e18·py) · d/dx[(x0−x)·b / x]
    //   = px / (1e18·py) · [−b/x + (x0−x)·cx/x − (x0−x)·b/x²]
    //   = px / (1e18·py·x²) · [−b·x + cx·x·(x0−x) − (x0−x)·b]
    //   = px / (1e18·py·x²) · [−b·x0 + cx·x·(x0−x)]
    //   ... complex. Use simplified c=0 form + cx correction.
    if (cx === 0n) {
      // |dy/dx| = px·x0² / (py·x²), WAD-scaled
      return (px * x0 * x0 * WAD) / (py * reserve0 * reserve0);
    }
    // General c>0: numerical derivative
    const delta = reserve0 / 10000n > 0n ? reserve0 / 10000n : 1n;
    const xLo = reserve0 > delta ? reserve0 - delta : 1n;
    const xHi = reserve0 + delta > x0 ? x0 : reserve0 + delta;
    const yLo = curveF(xLo, px, py, x0, y0, cx);
    const yHi = curveF(xHi, px, py, x0, y0, cx);
    if (yLo <= yHi || xHi <= xLo) return px * WAD / py; // fallback to eq price
    return ((yLo - yHi) * WAD) / (xHi - xLo);
  } else {
    // Branch 2: reserve0 > x0 → we're on the inverse branch
    // |dy/dx| = px·y² / (py·y0²) for c=0
    if (cy === 0n) {
      return (px * reserve1 * reserve1 * WAD) / (py * y0 * y0);
    }
    // General c>0: numerical derivative via inverse branch
    const delta = reserve1 / 10000n > 0n ? reserve1 / 10000n : 1n;
    const yLo = reserve1 > delta ? reserve1 - delta : 1n;
    const yHi = reserve1 + delta > y0 ? y0 : reserve1 + delta;
    const xLo = curveF(yLo, py, px, y0, x0, cy);
    const xHi = curveF(yHi, py, px, y0, x0, cy);
    if (xLo <= xHi || yHi <= yLo) return px * WAD / py;
    return ((yHi - yLo) * WAD) / (xLo - xHi);
  }
}

/** Replicates CurveLib.f for c=0: y = y0 + px·x0·(x0−x) / (py·x) */
function curveF(x: bigint, px: bigint, py: bigint, x0: bigint, y0: bigint, c: bigint): bigint {
  if (x >= x0) return y0;
  if (c === 0n) {
    // v = px * (x0 - x) * x0 / (x * py)  [integer division, rounds down]
    return y0 + (px * (x0 - x) * x0) / (x * py);
  }
  // General: v = px * (x0 - x) * (c * x + (WAD - c) * x0) / (WAD * x * py)
  const a = px * (x0 - x);
  const b = c * x + (WAD - c) * x0;
  const d = WAD * x * py;
  return y0 + (a * b) / d;
}

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
export async function getVaultMeta(client: PublicClient, config: AgentConfig) {
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

  // Marginal price from the EulerSwap curve (NOT the reserve ratio).
  // The curve has two branches meeting at equilibrium (x0, y0):
  //   Branch 1 (x ≤ x0): |dy/dx| = px × x0² / (py × x²)
  //   Branch 2 (x > x0):  |dy/dx| = px × y² / (py × y0²)
  // where x = reserve0 (USDC raw), y = reserve1 (WETH raw).
  // For c > 0, the formula includes concentration terms — see CurveLib.f().
  const marginalPrice = computeMarginalPrice(
    reserve0, reserve1,
    dParams.priceX, dParams.priceY,
    dParams.equilibriumReserve0, dParams.equilibriumReserve1,
    dParams.concentrationX, dParams.concentrationY,
  );

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
    minReserve0: dParams.minReserve0,
    minReserve1: dParams.minReserve1,
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

export async function getVaultDebtInfo(
  client: PublicClient,
  config: AgentConfig
): Promise<VaultDebtInfo> {
  const meta = await getVaultMeta(client, config);
  const hasBorrow0 = meta.borrowVault0 !== ZERO_ADDRESS;
  const hasBorrow1 = meta.borrowVault1 !== ZERO_ADDRESS;

  // Read debt/utilization for borrow vaults + rates/utilization for supply vaults
  const [
    debt0, debt1, borrowRate0, borrowRate1,
    totalBorrows0, totalAssets0, totalBorrows1, totalAssets1,
    shares0, shares1,
    supplyRate0, supplyRate1,
    supplyTotalBorrows0, supplyTotalAssets0, supplyTotalBorrows1, supplyTotalAssets1,
  ] = await Promise.all([
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
    // Supply vault rates and utilization (for computing deposit yield)
    client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "interestRate" }),
    client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "interestRate" }),
    client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "totalBorrows" }),
    client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "totalAssets" }),
    client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "totalBorrows" }),
    client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "totalAssets" }),
  ]);

  const [deposit0, deposit1, ltvRaw0, ltvRaw1] = await Promise.all([
    client.readContract({ address: meta.supplyVault0, abi: evaultAbi, functionName: "convertToAssets", args: [shares0 as bigint] }),
    client.readContract({ address: meta.supplyVault1, abi: evaultAbi, functionName: "convertToAssets", args: [shares1 as bigint] }),
    // Cross-vault LTV: how much can borrow from vault0 using vault1 as collateral (and vice versa)
    hasBorrow0
      ? client.readContract({ address: meta.borrowVault0, abi: evaultAbi, functionName: "LTVBorrow", args: [meta.supplyVault1] }).catch(() => 0)
      : Promise.resolve(0),
    hasBorrow1
      ? client.readContract({ address: meta.borrowVault1, abi: evaultAbi, functionName: "LTVBorrow", args: [meta.supplyVault0] }).catch(() => 0)
      : Promise.resolve(0),
  ]);

  const utilization0 = (totalAssets0 as bigint) > 0n
    ? (totalBorrows0 as bigint) * WAD / (totalAssets0 as bigint)
    : 0n;
  const utilization1 = (totalAssets1 as bigint) > 0n
    ? (totalBorrows1 as bigint) * WAD / (totalAssets1 as bigint)
    : 0n;

  // Supply vault utilization (deposit yield ≈ borrowRate × utilization)
  const supplyUtil0 = (supplyTotalAssets0 as bigint) > 0n
    ? (supplyTotalBorrows0 as bigint) * WAD / (supplyTotalAssets0 as bigint)
    : 0n;
  const supplyUtil1 = (supplyTotalAssets1 as bigint) > 0n
    ? (supplyTotalBorrows1 as bigint) * WAD / (supplyTotalAssets1 as bigint)
    : 0n;

  // Daily interest cost: debt × rate × 86400 / 1e27
  const dailyCost0 = (debt0 as bigint) * (borrowRate0 as bigint) * SECONDS_PER_DAY / RAY;
  const dailyCost1 = (debt1 as bigint) * (borrowRate1 as bigint) * SECONDS_PER_DAY / RAY;

  // Daily supply yield: deposit × supplyRate × utilization × 86400 / (1e27 × 1e18)
  const dailyYield0 = (deposit0 as bigint) * (supplyRate0 as bigint) * supplyUtil0 * SECONDS_PER_DAY / (RAY * WAD);
  const dailyYield1 = (deposit1 as bigint) * (supplyRate1 as bigint) * supplyUtil1 * SECONDS_PER_DAY / (RAY * WAD);

  const ltv0 = Number(ltvRaw0);
  const ltv1 = Number(ltvRaw1);
  const maxLeverage0 = ltv0 > 0 && ltv0 < 10000 ? 1 / (1 - ltv0 / 10000) : 0;
  const maxLeverage1 = ltv1 > 0 && ltv1 < 10000 ? 1 / (1 - ltv1 / 10000) : 0;
  const isBooster = meta.supplyVault0 === meta.borrowVault0 && meta.supplyVault1 === meta.borrowVault1;

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
    supplyRate0: supplyRate0 as bigint,
    supplyRate1: supplyRate1 as bigint,
    supplyUtilization0: supplyUtil0,
    supplyUtilization1: supplyUtil1,
    dailyYield0,
    dailyYield1,
    ltv0,
    ltv1,
    maxLeverage0,
    maxLeverage1,
    isBooster,
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
    gasThreshold: result[2],
    captureRate: result[3],
  };
}

export async function getRegistryInfo(
  client: PublicClient,
  config: AgentConfig
): Promise<RegistryInfo> {
  if (!config.registryAddress) {
    return { registered: false, validityBond: 0n, totalPoolsInRegistry: 0n };
  }

  const [bond, totalPools] = await Promise.all([
    client.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "validityBond",
      args: [config.poolAddress],
    }),
    client.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "poolsLength",
    }),
  ]);

  return {
    registered: (bond as bigint) > 0n,
    validityBond: bond as bigint,
    totalPoolsInRegistry: totalPools as bigint,
  };
}
