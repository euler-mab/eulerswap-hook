import { type Address, type PublicClient, formatUnits, parseAbiItem } from "viem";
import { eulerSwapAbi, evaultAbi, erc20Abi, hookAbi } from "./abi";
import { TOKEN_META, type PoolConfig } from "./config";
import type { PoolState, SwapEvent, VaultFlow } from "./types";

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
    // 8: hook live fee for asset0-in
    hasHook
      ? client.readContract({ address: hookAddr, abi: hookAbi, functionName: "getFee", args: [true, reserves[0], reserves[1], false] })
      : Promise.resolve(null),
    // 9: hook live fee for asset1-in
    hasHook
      ? client.readContract({ address: hookAddr, abi: hookAbi, functionName: "getFee", args: [false, reserves[0], reserves[1], false] })
      : Promise.resolve(null),
    // 10: block timestamp
    client.getBlock({ blockNumber: blockNumber }).then(b => b.timestamp),
    // 11: getLimits(asset0 → asset1)
    client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getLimits", args: [asset0, asset1] }),
    // 12: getLimits(asset1 → asset0)
    client.readContract({ address: pool.address, abi: eulerSwapAbi, functionName: "getLimits", args: [asset1, asset0] }),
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
  const liveFee0In = val(results[8], null) as bigint | null;
  const liveFee1In = val(results[9], null) as bigint | null;
  const blockTimestamp = val(results[10], 0n) as bigint;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const limits0to1 = val(results[11], null) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const limits1to0 = val(results[12], null) as any;

  // Compute marginal price using EulerSwap curve.
  // On-chain priceX/priceY are (USD_price / 10^decimals) * 1e18, so normalise to
  // human USD prices: px_human = priceX / 10^(18 - decimals)
  const r0 = Number(formatUnits(reserves[0], meta0.decimals));
  const r1 = Number(formatUnits(reserves[1], meta1.decimals));
  const x0 = Number(formatUnits(dynamicParams.equilibriumReserve0, meta0.decimals));
  const y0 = Number(formatUnits(dynamicParams.equilibriumReserve1, meta1.decimals));
  const cx = Number(dynamicParams.concentrationX) / 1e18;
  const cy = Number(dynamicParams.concentrationY) / 1e18;
  const px = Number(dynamicParams.priceX) / Math.pow(10, 18 - meta0.decimals);
  const py = Number(dynamicParams.priceY) / Math.pow(10, 18 - meta1.decimals);
  const equilibriumPrice = py > 0 ? px / py : 0; // Y per X at equilibrium
  let marginalPrice = equilibriumPrice;
  if (px > 0 && py > 0) {
    if (r0 > 0 && r0 < x0) {
      // X side: X being sold → price above equilibrium
      // pXxy = (px/py)(cx + (1-cx)(x0/x)²)
      const ratio = x0 / r0;
      marginalPrice = (px / py) * (cx + (1 - cx) * ratio * ratio);
    } else if (r1 > 0 && r1 < y0) {
      // Y side: Y being sold → price below equilibrium
      // pYxy = (px/py) / (cy + (1-cy)(y0/y)²)
      const ratio = y0 / r1;
      marginalPrice = (px / py) / (cy + (1 - cy) * ratio * ratio);
    }
  }

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
    marginalPrice, equilibriumPrice, isInstalled: installed,
    // Hook
    hookBaseFee: feeParams ? feeParams[0] : undefined,
    hookMaxFee: feeParams ? feeParams[1] : undefined,
    hookMismatchScale: feeParams ? feeParams[2] : undefined,
    hookLiveFee0In: liveFee0In ?? undefined,
    hookLiveFee1In: liveFee1In ?? undefined,
    // Wallet
    agentEthBalance, agentToken0Balance, agentToken1Balance,
    // Vault positions
    vaultDeposit0, vaultDeposit1, vaultDebt0, vaultDebt1,
    // Trade limits
    limit0In: limits0to1 ? (limits0to1[0] as bigint) : 0n,
    limit1Out: limits0to1 ? (limits0to1[1] as bigint) : 0n,
    limit1In: limits1to0 ? (limits1to0[0] as bigint) : 0n,
    limit0Out: limits1to0 ? (limits1to0[1] as bigint) : 0n,
    // Meta
    fetchedAt: Date.now(), blockNumber, blockTimestamp: Number(blockTimestamp),
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

/** ERC4626 event ABIs for getLogs */
const depositEventAbi = parseAbiItem(
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
);
const withdrawEventAbi = parseAbiItem(
  "event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"
);

/**
 * Fetch external capital flows (deposits/withdrawals) for a pool's euler account.
 * Scans ERC4626 Deposit/Withdraw events on both supply vaults, then filters out
 * any events that occur in the same transaction as a Swap (those are pool operations).
 */
export async function fetchVaultFlows(
  client: PublicClient,
  pool: PoolConfig,
  supplyVault0: Address,
  supplyVault1: Address,
  eulerAccount: Address,
  swapTxHashes: Set<string>,
  fromBlock: bigint,
  toBlock: bigint,
  maxBlockRange = 10_000n,
): Promise<VaultFlow[]> {
  const flows: VaultFlow[] = [];

  const vaults: { address: Address; index: 0 | 1 }[] = [];
  if (supplyVault0 !== ZERO) vaults.push({ address: supplyVault0, index: 0 });
  if (supplyVault1 !== ZERO) vaults.push({ address: supplyVault1, index: 1 });

  for (const vault of vaults) {
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = cursor + maxBlockRange > toBlock ? toBlock : cursor + maxBlockRange;

      const [deposits, withdrawals] = await Promise.all([
        client.getLogs({
          address: vault.address,
          event: depositEventAbi,
          args: { owner: eulerAccount },
          fromBlock: cursor,
          toBlock: end,
        }),
        client.getLogs({
          address: vault.address,
          event: withdrawEventAbi,
          args: { owner: eulerAccount },
          fromBlock: cursor,
          toBlock: end,
        }),
      ]);

      for (const log of deposits) {
        if (swapTxHashes.has(log.transactionHash)) continue; // swap-induced
        flows.push({
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          vaultIndex: vault.index,
          direction: "deposit",
          assets: log.args.assets!,
        });
      }

      for (const log of withdrawals) {
        if (swapTxHashes.has(log.transactionHash)) continue; // swap-induced
        flows.push({
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          vaultIndex: vault.index,
          direction: "withdraw",
          assets: log.args.assets!,
        });
      }

      cursor = end + 1n;
    }
  }

  // Sort by block number
  flows.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  return flows;
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
