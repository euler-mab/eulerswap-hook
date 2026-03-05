import { type Address, type PublicClient, formatUnits, parseAbiItem } from "viem";
import { eulerSwapAbi, evaultAbi, erc20Abi, hookAbi } from "./abi";
import { TOKEN_META, type PoolConfig } from "./config";
import type { PoolState, SwapEvent } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function tokenMeta(addr: Address) {
  return TOKEN_META[addr.toLowerCase()] ?? { symbol: "???", decimals: 18, color: "#888" };
}

/** Fetch current on-chain state for a pool using multicall batching */
export async function fetchPoolState(
  client: PublicClient,
  pool: PoolConfig,
): Promise<PoolState> {
  // Step 1: core pool reads (batched via multicall)
  const [reserves, dynamicParams, staticParams, assets, installed, blockNumber] =
    await Promise.all([
      client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getReserves" }),
      client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getDynamicParams" }),
      client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getStaticParams" }),
      client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getAssets" }),
      client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "isInstalled" }),
      client.getBlockNumber(),
    ]);

  const asset0 = assets[0] as Address;
  const asset1 = assets[1] as Address;
  const meta0 = tokenMeta(asset0);
  const meta1 = tokenMeta(asset1);

  const sv0 = staticParams.supplyVault0 as Address;
  const sv1 = staticParams.supplyVault1 as Address;
  const bv0 = staticParams.borrowVault0 as Address;
  const bv1 = staticParams.borrowVault1 as Address;
  const hookAddr = pool.hook ?? (dynamicParams.swapHook as Address);
  const hasHook = hookAddr !== ZERO;

  // Step 2: wallet balances, vault positions, hook state (all in parallel)
  const results = await Promise.allSettled([
    // 0: agent ETH balance
    client.getBalance({ address: pool.agentEoa }),
    // 1: agent token0 balance
    client.readContract({ address: asset0, abi: erc20Abi, functionName: "balanceOf", args: [pool.agentEoa] }),
    // 2: agent token1 balance
    client.readContract({ address: asset1, abi: erc20Abi, functionName: "balanceOf", args: [pool.agentEoa] }),
    // 3: vault0 deposit (shares → assets)
    sv0 !== ZERO
      ? client.readContract({ address: sv0, abi: evaultAbi, functionName: "balanceOf", args: [pool.eulerAccount] })
          .then(shares => shares > 0n
            ? client.readContract({ address: sv0, abi: evaultAbi, functionName: "convertToAssets", args: [shares] })
            : 0n)
      : Promise.resolve(0n),
    // 4: vault1 deposit (shares → assets)
    sv1 !== ZERO
      ? client.readContract({ address: sv1, abi: evaultAbi, functionName: "balanceOf", args: [pool.eulerAccount] })
          .then(shares => shares > 0n
            ? client.readContract({ address: sv1, abi: evaultAbi, functionName: "convertToAssets", args: [shares] })
            : 0n)
      : Promise.resolve(0n),
    // 5: vault0 debt
    bv0 !== ZERO
      ? client.readContract({ address: bv0, abi: evaultAbi, functionName: "debtOf", args: [pool.eulerAccount] })
      : Promise.resolve(0n),
    // 6: vault1 debt
    bv1 !== ZERO
      ? client.readContract({ address: bv1, abi: evaultAbi, functionName: "debtOf", args: [pool.eulerAccount] })
      : Promise.resolve(0n),
    // 7: hook fee params
    hasHook
      ? client.readContract({ address: hookAddr, abi: hookAbi, functionName: "getFeeParams" })
      : Promise.resolve(null),
    // 8: hook trade stats
    hasHook
      ? client.readContract({ address: hookAddr, abi: hookAbi, functionName: "getTradeStats" })
      : Promise.resolve(null),
    // 9: hook oracle price
    hasHook
      ? client.readContract({ address: hookAddr, abi: hookAbi, functionName: "oraclePrice" })
      : Promise.resolve(null),
  ]);

  const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === "fulfilled" ? r.value : fallback;

  const agentEthBalance = val(results[0], 0n) as bigint;
  const agentToken0Balance = val(results[1], 0n) as bigint;
  const agentToken1Balance = val(results[2], 0n) as bigint;
  const vaultDeposit0 = val(results[3], 0n) as bigint;
  const vaultDeposit1 = val(results[4], 0n) as bigint;
  const vaultDebt0 = val(results[5], 0n) as bigint;
  const vaultDebt1 = val(results[6], 0n) as bigint;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feeParams = val(results[7], null) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradeStats = val(results[8], null) as any;
  const oraclePrice = val(results[9], null) as bigint | null;

  // Compute marginal price from reserves
  const r0 = Number(formatUnits(reserves[0], meta0.decimals));
  const r1 = Number(formatUnits(reserves[1], meta1.decimals));
  const marginalPrice = r0 > 0 ? r1 / r0 : 0;

  return {
    reserve0: reserves[0], reserve1: reserves[1], status: Number(reserves[2]),
    asset0, asset1,
    asset0Symbol: meta0.symbol, asset1Symbol: meta1.symbol,
    asset0Decimals: meta0.decimals, asset1Decimals: meta1.decimals,
    equilibriumReserve0: dynamicParams.equilibriumReserve0,
    equilibriumReserve1: dynamicParams.equilibriumReserve1,
    minReserve0: dynamicParams.minReserve0,
    minReserve1: dynamicParams.minReserve1,
    priceX: dynamicParams.priceX, priceY: dynamicParams.priceY,
    concentrationX: dynamicParams.concentrationX,
    concentrationY: dynamicParams.concentrationY,
    fee0: dynamicParams.fee0, fee1: dynamicParams.fee1,
    expiration: Number(dynamicParams.expiration),
    swapHook: dynamicParams.swapHook as Address,
    supplyVault0: sv0, supplyVault1: sv1,
    borrowVault0: bv0, borrowVault1: bv1,
    eulerAccount: staticParams.eulerAccount as Address,
    feeRecipient: staticParams.feeRecipient as Address,
    marginalPrice, isInstalled: installed,
    // Hook
    hookPaused: feeParams ? feeParams[4] : undefined,
    hookBaseFee: feeParams ? feeParams[0] : undefined,
    hookMaxFee: feeParams ? feeParams[1] : undefined,
    hookMinFee: feeParams ? feeParams[2] : undefined,
    hookMismatchScale: feeParams ? feeParams[3] : undefined,
    hookTradeCount: tradeStats ? tradeStats[0] : undefined,
    hookVolume0: tradeStats ? tradeStats[1] : undefined,
    hookVolume1: tradeStats ? tradeStats[2] : undefined,
    hookLastBlock: tradeStats ? tradeStats[5] : undefined,
    hookOraclePrice: oraclePrice ?? undefined,
    // Wallet
    agentEthBalance, agentToken0Balance, agentToken1Balance,
    // Vault positions
    vaultDeposit0, vaultDeposit1, vaultDebt0, vaultDebt1,
    // Meta
    fetchedAt: Date.now(), blockNumber,
  };
}

/** Swap event ABI for getLogs — defined via parseAbiItem for proper type inference */
const swapEventAbi = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, uint256 fee0, uint256 fee1, uint112 reserve0, uint112 reserve1, address indexed to)"
);

/** Fetch Swap events in paginated block ranges */
export async function fetchSwapEvents(
  client: PublicClient,
  poolAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  maxBlockRange = 10_000n,
): Promise<SwapEvent[]> {
  const events: SwapEvent[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + maxBlockRange > toBlock ? toBlock : cursor + maxBlockRange;
    const logs = await client.getLogs({
      address: poolAddress,
      event: swapEventAbi,
      fromBlock: cursor,
      toBlock: end,
    });
    for (const log of logs) {
      events.push({
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        sender: log.args.sender!,
        to: log.args.to!,
        amount0In: log.args.amount0In!,
        amount1In: log.args.amount1In!,
        amount0Out: log.args.amount0Out!,
        amount1Out: log.args.amount1Out!,
        fee0: log.args.fee0!,
        fee1: log.args.fee1!,
        reserve0: log.args.reserve0!,
        reserve1: log.args.reserve1!,
      });
    }
    cursor = end + 1n;
  }
  return events;
}

/** Fetch block timestamps for a set of block numbers (deduplicated) */
export async function fetchBlockTimestamps(
  client: PublicClient,
  blockNumbers: bigint[],
): Promise<Map<bigint, number>> {
  const unique = [...new Set(blockNumbers)];
  const map = new Map<bigint, number>();
  // Batch in groups of 20 to avoid overwhelming the RPC
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const blocks = await Promise.all(
      batch.map(bn => client.getBlock({ blockNumber: bn })),
    );
    for (const block of blocks) {
      map.set(block.number, Number(block.timestamp));
    }
  }
  return map;
}
