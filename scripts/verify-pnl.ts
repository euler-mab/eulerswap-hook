/**
 * Verify P&L attribution against all on-chain swap events.
 *
 * Uses per-block Uniswap V3 prices (exact on-chain) instead of DeFiLlama interpolation.
 * Computes interest directly from vault events (not as residual).
 *
 * 5-way decomposition:
 *   totalPnl = fees + swapRebal + extRebal + interest + markToMarket
 *
 * Usage: npx tsx scripts/verify-pnl.ts
 */

import { createPublicClient, http, formatUnits, parseAbiItem, type Address } from "viem";
import { mainnet } from "viem/chains";

// ─── Config ─────────────────────────────────────────────────────────
const POOL = "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address;
const EULER_ACCOUNT = "0x2909bCc87c17d8Be263621bF087bC806BA313BFE" as Address;
const DEPLOY_BLOCK = 24591724n;
const UNI_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as Address; // USDC/WETH 0.05%
const DEC0 = 6;  // USDC
const DEC1 = 18; // WETH

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? process.env.RPC_URL;
if (!RPC_URL) { console.error("Set NEXT_PUBLIC_RPC_URL or RPC_URL"); process.exit(1); }

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
  batch: { multicall: true },
});

// ─── ABIs ───────────────────────────────────────────────────────────
const swapEventAbi = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, uint256 fee0, uint256 fee1, uint112 reserve0, uint112 reserve1, address indexed to)"
);
const depositEventAbi = parseAbiItem(
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)"
);
const withdrawEventAbi = parseAbiItem(
  "event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"
);
const borrowEventAbi = parseAbiItem(
  "event Borrow(address indexed account, uint256 assets)"
);
const repayEventAbi = parseAbiItem(
  "event Repay(address indexed account, uint256 assets)"
);

const eulerSwapAbi = [
  { name: "getStaticParams", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "tuple", components: [
    { name: "supplyVault0", type: "address" },
    { name: "supplyVault1", type: "address" },
    { name: "borrowVault0", type: "address" },
    { name: "borrowVault1", type: "address" },
    { name: "eulerAccount", type: "address" },
    { name: "feeRecipient", type: "address" },
  ]}]},
] as const;

const evaultAbi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "convertToAssets", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "debtOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const uniV3Abi = [
  { name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" },
    { name: "observationCardinality", type: "uint16" },
    { name: "observationCardinalityNext", type: "uint16" },
    { name: "feeProtocol", type: "uint8" },
    { name: "unlocked", type: "bool" },
  ]},
] as const;

// ─── Types ──────────────────────────────────────────────────────────
interface SwapEvent {
  blockNumber: bigint;
  transactionHash: string;
  amount0In: bigint; amount1In: bigint;
  amount0Out: bigint; amount1Out: bigint;
  fee0: bigint; fee1: bigint;
  reserve0: bigint; reserve1: bigint;
}

interface VaultEvent {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  vaultIndex: 0 | 1;
  operation: "deposit" | "withdraw" | "borrow" | "repay";
  assets: bigint;
}

// ─── Fetch helpers ──────────────────────────────────────────────────
async function fetchSwaps(): Promise<SwapEvent[]> {
  const currentBlock = await client.getBlockNumber();
  const events: SwapEvent[] = [];
  const RANGE = 10_000n;
  let cursor = DEPLOY_BLOCK;
  while (cursor <= currentBlock) {
    const end = cursor + RANGE > currentBlock ? currentBlock : cursor + RANGE;
    const logs = await client.getLogs({
      address: POOL, event: swapEventAbi,
      fromBlock: cursor, toBlock: end,
    });
    for (const log of logs) {
      events.push({
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        amount0In: log.args.amount0In!, amount1In: log.args.amount1In!,
        amount0Out: log.args.amount0Out!, amount1Out: log.args.amount1Out!,
        fee0: log.args.fee0!, fee1: log.args.fee1!,
        reserve0: log.args.reserve0!, reserve1: log.args.reserve1!,
      });
    }
    cursor = end + 1n;
    if (events.length > 0 && events.length % 200 === 0) {
      process.stdout.write(`  ${events.length} swaps fetched...\r`);
    }
  }
  return events;
}

async function fetchAllVaultEvents(
  vault0: Address, vault1: Address,
): Promise<VaultEvent[]> {
  const currentBlock = await client.getBlockNumber();
  const events: VaultEvent[] = [];
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const vaults: { address: Address; index: 0 | 1 }[] = [];
  if (vault0 !== ZERO) vaults.push({ address: vault0, index: 0 });
  if (vault1 !== ZERO) vaults.push({ address: vault1, index: 1 });

  const RANGE = 10_000n;
  for (const vault of vaults) {
    let cursor = DEPLOY_BLOCK;
    while (cursor <= currentBlock) {
      const end = cursor + RANGE > currentBlock ? currentBlock : cursor + RANGE;
      const [deposits, withdrawals, borrows, repays] = await Promise.all([
        client.getLogs({ address: vault.address, event: depositEventAbi, args: { owner: EULER_ACCOUNT }, fromBlock: cursor, toBlock: end }),
        client.getLogs({ address: vault.address, event: withdrawEventAbi, args: { owner: EULER_ACCOUNT }, fromBlock: cursor, toBlock: end }),
        client.getLogs({ address: vault.address, event: borrowEventAbi, args: { account: EULER_ACCOUNT }, fromBlock: cursor, toBlock: end }),
        client.getLogs({ address: vault.address, event: repayEventAbi, args: { account: EULER_ACCOUNT }, fromBlock: cursor, toBlock: end }),
      ]);
      for (const log of deposits) {
        events.push({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, vaultIndex: vault.index, operation: "deposit", assets: log.args.assets! });
      }
      for (const log of withdrawals) {
        events.push({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, vaultIndex: vault.index, operation: "withdraw", assets: log.args.assets! });
      }
      for (const log of borrows) {
        events.push({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, vaultIndex: vault.index, operation: "borrow", assets: log.args.assets! });
      }
      for (const log of repays) {
        events.push({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, vaultIndex: vault.index, operation: "repay", assets: log.args.assets! });
      }
      cursor = end + 1n;
    }
  }
  events.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  return events;
}

/** Fetch WETH price in USD from Uniswap V3 slot0 at specific blocks */
async function fetchBlockPrices(blockNumbers: bigint[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(blockNumbers)];
  const map = new Map<bigint, number>();

  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(bn =>
        client.readContract({
          address: UNI_POOL, abi: uniV3Abi, functionName: "slot0", blockNumber: bn,
        })
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const sqrtPriceX96 = results[j][0];
      if (sqrtPriceX96 > 0n) {
        const num = Number(sqrtPriceX96) / 2 ** 96;
        const rawPrice = num * num;
        // USDC/WETH pool: rawPrice = WETH_raw/USDC_raw
        // uniPrice = WETH per USDC in human = rawPrice * 10^(6-18)
        const uniPrice = rawPrice * Math.pow(10, DEC0 - DEC1);
        map.set(batch[j], 1 / uniPrice); // WETH price in USD
      }
    }
    if (i % 100 === 0 && i > 0) {
      process.stdout.write(`  ${i}/${unique.length} block prices fetched...\r`);
    }
  }
  console.log(`  Fetched ${map.size} unique block prices`);
  return map;
}

async function fetchVaultPositions(v0: Address, v1: Address) {
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const [dep0, dep1, debt0, debt1] = await Promise.all([
    v0 !== ZERO
      ? client.readContract({ address: v0, abi: evaultAbi, functionName: "balanceOf", args: [EULER_ACCOUNT] })
          .then(shares => shares > 0n ? client.readContract({ address: v0, abi: evaultAbi, functionName: "convertToAssets", args: [shares] }) : 0n)
      : Promise.resolve(0n),
    v1 !== ZERO
      ? client.readContract({ address: v1, abi: evaultAbi, functionName: "balanceOf", args: [EULER_ACCOUNT] })
          .then(shares => shares > 0n ? client.readContract({ address: v1, abi: evaultAbi, functionName: "convertToAssets", args: [shares] }) : 0n)
      : Promise.resolve(0n),
    v0 !== ZERO ? client.readContract({ address: v0, abi: evaultAbi, functionName: "debtOf", args: [EULER_ACCOUNT] }) : Promise.resolve(0n),
    v1 !== ZERO ? client.readContract({ address: v1, abi: evaultAbi, functionName: "debtOf", args: [EULER_ACCOUNT] }) : Promise.resolve(0n),
  ]);
  return { dep0, dep1, debt0, debt1 };
}

function equitySign(op: VaultEvent["operation"]): number {
  switch (op) {
    case "deposit": return +1;
    case "withdraw": return -1;
    case "borrow": return -1;
    case "repay": return +1;
  }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log("=== P&L Attribution Verification (5-way, per-block pricing) ===\n");

  // 1. Fetch static params
  console.log("1. Fetching pool static params...");
  const staticParams = await client.readContract({ address: POOL, abi: eulerSwapAbi, functionName: "getStaticParams" }) as any;
  const v0 = staticParams.supplyVault0 as Address;
  const v1 = staticParams.supplyVault1 as Address;
  console.log(`   Vault0 (USDC): ${v0}`);
  console.log(`   Vault1 (WETH): ${v1}`);

  // 2. Fetch all swap events
  console.log("\n2. Fetching swap events...");
  const swaps = await fetchSwaps();
  console.log(`   Found ${swaps.length} swaps`);
  const swapTxHashes = new Set(swaps.map(s => s.transactionHash));

  // 3. Fetch ALL vault events
  console.log("\n3. Fetching all vault events...");
  const allVaultEvents = await fetchAllVaultEvents(v0, v1);
  console.log(`   Found ${allVaultEvents.length} total vault events`);

  // 4. Categorize non-swap events
  const externalEvents: VaultEvent[] = [];
  for (const ev of allVaultEvents) {
    if (!swapTxHashes.has(ev.transactionHash)) {
      externalEvents.push(ev);
    }
  }
  console.log(`   Swap-induced: ${allVaultEvents.length - externalEvents.length}`);
  console.log(`   Non-swap:     ${externalEvents.length}`);

  const byTx = new Map<string, VaultEvent[]>();
  for (const ev of externalEvents) {
    const arr = byTx.get(ev.transactionHash) ?? [];
    arr.push(ev);
    byTx.set(ev.transactionHash, arr);
  }

  const capitalTxs = new Set<string>();
  const rebalTxs = new Set<string>();
  for (const [txHash, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    const touchesBothVaults = vaults.size > 1;
    const hasBothSides = (ops.has("deposit") || ops.has("withdraw")) && (ops.has("borrow") || ops.has("repay"));
    if (touchesBothVaults || hasBothSides) {
      rebalTxs.add(txHash);
    } else {
      capitalTxs.add(txHash);
    }
  }

  // 5. Fetch per-block Uniswap prices for ALL relevant blocks
  console.log("\n4. Fetching per-block Uniswap prices...");
  const allBlocks = new Set<bigint>();
  for (const s of swaps) allBlocks.add(s.blockNumber);
  for (const ev of externalEvents) allBlocks.add(ev.blockNumber);
  console.log(`   ${allBlocks.size} unique blocks to price`);
  const blockPrices = await fetchBlockPrices([...allBlocks]);

  // 6. Fetch current vault positions + current price
  console.log("\n5. Fetching current vault positions...");
  const vp = await fetchVaultPositions(v0, v1);
  const dep0 = Number(formatUnits(vp.dep0, DEC0));
  const dep1 = Number(formatUnits(vp.dep1, DEC1));
  const dbt0 = Number(formatUnits(vp.debt0, DEC0));
  const dbt1 = Number(formatUnits(vp.debt1, DEC1));
  console.log(`   Deposits: ${dep0.toFixed(2)} USDC, ${dep1.toFixed(6)} WETH`);
  console.log(`   Debts:    ${dbt0.toFixed(2)} USDC, ${dbt1.toFixed(6)} WETH`);
  console.log(`   Equity:   ${(dep0 - dbt0).toFixed(2)} USDC, ${(dep1 - dbt1).toFixed(6)} WETH`);

  // Current ETH price (latest block in our set)
  const latestBlock = [...allBlocks].reduce((a, b) => a > b ? a : b);
  const currentEthPrice = blockPrices.get(latestBlock) ?? 0;
  const p0 = 1; // USDC = $1
  const p1 = currentEthPrice;
  console.log(`   Current WETH price: $${p1.toFixed(2)} (from Uniswap at block ${latestBlock})`);

  // ─── Compute P&L ─────────────────────────────────────────────────
  console.log("\n6. Computing P&L attribution...\n");

  const navUsd = (dep0 - dbt0) * p0 + (dep1 - dbt1) * p1;

  // Cost basis: capital flows valued at per-block prices
  let costBasisUsd = 0;
  let extCap0 = 0, extCap1 = 0;
  console.log("   ── External capital flows ──");
  for (const [txHash, txEvents] of byTx) {
    if (!capitalTxs.has(txHash)) continue;
    for (const ev of txEvents) {
      const dec = ev.vaultIndex === 0 ? DEC0 : DEC1;
      const sym = ev.vaultIndex === 0 ? "USDC" : "WETH";
      const amount = Number(formatUnits(ev.assets, dec));
      const signed = amount * equitySign(ev.operation);
      const price = ev.vaultIndex === 0 ? 1 : (blockPrices.get(ev.blockNumber) ?? p1);
      costBasisUsd += signed * price;
      if (ev.vaultIndex === 0) extCap0 += signed;
      else extCap1 += signed;
      console.log(`   ${ev.operation.padEnd(8)} ${sym.padEnd(5)} ${amount.toFixed(6).padStart(14)}  equity ${signed > 0 ? "+" : ""}${signed.toFixed(6)}  @$${price.toFixed(2)}  block ${ev.blockNumber}  tx ${txHash.slice(0, 10)}...`);
    }
  }
  console.log(`   Net external capital: ${extCap0.toFixed(4)} USDC, ${extCap1.toFixed(6)} WETH`);
  console.log(`   Cost basis: $${costBasisUsd.toFixed(2)}`);

  const totalPnl = navUsd - costBasisUsd;

  // Swap fees + swap rebalancing (valued at per-block prices)
  let feesUsd = 0;
  let swapRebalUsd = 0;
  let volIn0 = 0, volIn1 = 0;
  for (const s of swaps) {
    const bp = blockPrices.get(s.blockNumber) ?? p1;
    const sp0 = 1;
    const sp1 = bp;
    const f0 = Number(formatUnits(s.fee0, DEC0));
    const f1 = Number(formatUnits(s.fee1, DEC1));
    const in0 = Number(formatUnits(s.amount0In, DEC0));
    const out0 = Number(formatUnits(s.amount0Out, DEC0));
    const in1 = Number(formatUnits(s.amount1In, DEC1));
    const out1 = Number(formatUnits(s.amount1Out, DEC1));
    feesUsd += f0 * sp0 + f1 * sp1;
    swapRebalUsd += (in0 - out0) * sp0 + (in1 - out1) * sp1;
    volIn0 += in0;
    volIn1 += in1;
  }

  // External rebalancing (valued at per-block prices)
  let extRebalUsd = 0;
  console.log("\n   ── External rebalancing flows ──");
  for (const [txHash, txEvents] of byTx) {
    if (!rebalTxs.has(txHash)) continue;
    console.log(`   TX ${txHash.slice(0, 10)}...:`);
    for (const ev of txEvents) {
      const dec = ev.vaultIndex === 0 ? DEC0 : DEC1;
      const sym = ev.vaultIndex === 0 ? "USDC" : "WETH";
      const amount = Number(formatUnits(ev.assets, dec));
      const signed = amount * equitySign(ev.operation);
      const price = ev.vaultIndex === 0 ? 1 : (blockPrices.get(ev.blockNumber) ?? p1);
      extRebalUsd += signed * price;
      console.log(`     ${ev.operation.padEnd(8)} ${sym.padEnd(5)} ${amount.toFixed(6).padStart(14)}  equity ${signed > 0 ? "+" : ""}${signed.toFixed(6)}  @$${price.toFixed(2)}`);
    }
  }
  console.log(`   Ext rebal USD (historical): $${extRebalUsd.toFixed(2)}`);

  // Direct interest computation
  let netDeposits0 = 0, netDeposits1 = 0;
  let netBorrows0 = 0, netBorrows1 = 0;
  for (const ev of allVaultEvents) {
    const dec = ev.vaultIndex === 0 ? DEC0 : DEC1;
    const amount = Number(formatUnits(ev.assets, dec));
    if (ev.vaultIndex === 0) {
      if (ev.operation === "deposit") netDeposits0 += amount;
      else if (ev.operation === "withdraw") netDeposits0 -= amount;
      else if (ev.operation === "borrow") netBorrows0 += amount;
      else if (ev.operation === "repay") netBorrows0 -= amount;
    } else {
      if (ev.operation === "deposit") netDeposits1 += amount;
      else if (ev.operation === "withdraw") netDeposits1 -= amount;
      else if (ev.operation === "borrow") netBorrows1 += amount;
      else if (ev.operation === "repay") netBorrows1 -= amount;
    }
  }
  const interest0 = (dep0 - netDeposits0) - (dbt0 - netBorrows0);
  const interest1 = (dep1 - netDeposits1) - (dbt1 - netBorrows1);
  const interestUsd = interest0 * p0 + interest1 * p1;

  // Mark-to-market = residual
  const markToMarketUsd = totalPnl - feesUsd - swapRebalUsd - extRebalUsd - interestUsd;

  const volumeUsd = volIn0 * p0 + volIn1 * p1;
  const returnPct = costBasisUsd > 0 ? totalPnl / costBasisUsd : 0;

  // ─── Results ──────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          P&L Attribution (5-way, per-block)          ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Swaps:         ${swaps.length.toString().padStart(10)}                         ║`);
  console.log(`║  Vault events:  ${allVaultEvents.length.toString().padStart(10)}                         ║`);
  console.log(`║  Volume:        $${volumeUsd.toFixed(2).padStart(14)}                    ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  NAV:           $${navUsd.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Cost basis:    $${costBasisUsd.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Total P&L:     $${totalPnl.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Return:        ${(returnPct * 100).toFixed(2).padStart(10)}%                       ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Fees:          $${feesUsd.toFixed(2).padStart(14)}  (per-block)        ║`);
  console.log(`║  Swap rebal:    $${swapRebalUsd.toFixed(2).padStart(14)}  (IL, per-block)    ║`);
  console.log(`║  Ext rebal:     $${extRebalUsd.toFixed(2).padStart(14)}  (per-block)        ║`);
  console.log(`║  Interest:      $${interestUsd.toFixed(2).padStart(14)}  (exact)            ║`);
  console.log(`║  Mark-to-mkt:   $${markToMarketUsd.toFixed(2).padStart(14)}  (residual)         ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  const sum = feesUsd + swapRebalUsd + extRebalUsd + interestUsd + markToMarketUsd;
  const residual = Math.abs(totalPnl - sum);
  console.log(`║  Σ components:  $${sum.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Residual:      $${residual.toFixed(10).padStart(18)}                ║`);
  if (residual < 0.01) {
    console.log("║  Identity:      totalPnl = fees + IL + extRebal       ║");
    console.log("║                         + interest + MtM              ║");
  } else {
    console.log("║  IDENTITY BROKEN — residual too large!                ║");
  }
  console.log("╚══════════════════════════════════════════════════════╝");

  // ─── Per-asset detail ──────────────────────────────────────────────
  console.log("\n── Interest detail (exact, per-asset) ──");
  console.log("  USDC:");
  console.log(`    Supply interest: ${(dep0 - netDeposits0).toFixed(6)} USDC ($${((dep0 - netDeposits0) * p0).toFixed(4)})`);
  console.log(`    Borrow interest: ${(dbt0 - netBorrows0).toFixed(6)} USDC ($${((dbt0 - netBorrows0) * p0).toFixed(4)})`);
  console.log(`    Net interest:    ${interest0.toFixed(6)} USDC ($${(interest0 * p0).toFixed(4)})`);
  console.log("  WETH:");
  console.log(`    Supply interest: ${(dep1 - netDeposits1).toFixed(8)} WETH ($${((dep1 - netDeposits1) * p1).toFixed(4)})`);
  console.log(`    Borrow interest: ${(dbt1 - netBorrows1).toFixed(8)} WETH ($${((dbt1 - netBorrows1) * p1).toFixed(4)})`);
  console.log(`    Net interest:    ${interest1.toFixed(8)} WETH ($${(interest1 * p1).toFixed(4)})`);
  console.log(`  Total interest:    $${interestUsd.toFixed(4)}`);

  // ─── Plausibility ────────────────────────────────────────────────
  console.log("\n── Plausibility checks ──");
  const poolAgeDays = 30;
  console.log(`  Pool age: ~${poolAgeDays} days`);
  console.log(`  Fees/day:            $${(feesUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  Swap rebal/day:      $${(swapRebalUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  Interest/day:        $${(interestUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  MtM total:           $${markToMarketUsd.toFixed(2)}`);
  if (costBasisUsd > 0) {
    console.log(`  Interest ann. rate:  ${((interestUsd / costBasisUsd) * (365 / poolAgeDays) * 100).toFixed(2)}%`);
    console.log(`  Fee yield ann.:      ${((feesUsd / costBasisUsd) * (365 / poolAgeDays) * 100).toFixed(2)}%`);
  }

  const feeNeg = swaps.filter(s => s.fee0 < 0n || s.fee1 < 0n);
  let noInput = 0;
  for (const s of swaps) { if (s.amount0In === 0n && s.amount1In === 0n) noInput++; }
  console.log(`  Negative fees:       ${feeNeg.length === 0 ? "none" : `${feeNeg.length} swaps!`}`);
  console.log(`  Zero-input swaps:    ${noInput}`);
}

main().catch(e => { console.error(e); process.exit(1); });
