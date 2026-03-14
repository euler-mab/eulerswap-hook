/**
 * Verify P&L attribution against all on-chain swap events.
 *
 * Scans ALL vault events (Deposit, Withdraw, Borrow, Repay) on both vaults,
 * categorizes each as swap-induced, external capital, or external rebalancing,
 * then computes a proper 4-way P&L decomposition:
 *
 *   totalPnl = fees + swapRebal + extRebal + interest
 *
 * Usage: npx tsx scripts/verify-pnl.ts
 */

import { createPublicClient, http, formatUnits, parseAbiItem, type Address } from "viem";
import { mainnet } from "viem/chains";

// ─── Config ─────────────────────────────────────────────────────────
const POOL = "0x4311031739918Aba578C3C667DA3028A12Ce28A8" as Address;
const EULER_ACCOUNT = "0x2909bCc87c17d8Be263621bF087bC806BA313BFE" as Address;
const DEPLOY_BLOCK = 24591724n;
const ASSET0 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; // USDC
const ASSET1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address; // WETH
const DEC0 = 6;
const DEC1 = 18;

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

// ─── Types ──────────────────────────────────────────────────────────
interface SwapEvent {
  blockNumber: bigint;
  transactionHash: string;
  amount0In: bigint; amount1In: bigint;
  amount0Out: bigint; amount1Out: bigint;
  fee0: bigint; fee1: bigint;
  reserve0: bigint; reserve1: bigint;
}

/** A single vault event — covers all 4 operations on either vault */
interface VaultEvent {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  vaultIndex: 0 | 1;
  /** deposit/withdraw = supply side, borrow/repay = debt side */
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

/** Fetch ALL vault events (Deposit, Withdraw, Borrow, Repay) on both vaults for eulerAccount */
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

async function fetchCurrentPrices(): Promise<{ p0: number; p1: number }> {
  const coins = [`ethereum:${ASSET0}`, `ethereum:${ASSET1}`].join(",");
  const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`);
  if (!res.ok) throw new Error(`DeFiLlama error: ${res.status}`);
  const data = await res.json();
  const p0 = data.coins[`ethereum:${ASSET0}`]?.price;
  const p1 = data.coins[`ethereum:${ASSET1}`]?.price;
  if (!p0 || !p1) throw new Error("Missing DeFiLlama prices");
  return { p0, p1 };
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

/**
 * Compute equity effect of a vault event.
 * Equity = deposits - debts, so:
 *   deposit  → equity increases (+)
 *   withdraw → equity decreases (-)
 *   borrow   → equity decreases (debt goes up → -)
 *   repay    → equity increases (debt goes down → +)
 */
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
  console.log("=== P&L Attribution Verification ===\n");

  // 1. Fetch static params
  console.log("1. Fetching pool static params...");
  const staticParams = await client.readContract({ address: POOL, abi: eulerSwapAbi, functionName: "getStaticParams" }) as any;
  const v0 = staticParams.supplyVault0 as Address; // = borrowVault0
  const v1 = staticParams.supplyVault1 as Address; // = borrowVault1
  console.log(`   Vault0 (USDC): ${v0}`);
  console.log(`   Vault1 (WETH): ${v1}`);

  // 2. Fetch all swap events
  console.log("\n2. Fetching swap events...");
  const swaps = await fetchSwaps();
  console.log(`   Found ${swaps.length} swaps`);
  const swapTxHashes = new Set(swaps.map(s => s.transactionHash));

  // 3. Fetch ALL vault events (4 ops × 2 vaults)
  console.log("\n3. Fetching all vault events (Deposit/Withdraw/Borrow/Repay on both vaults)...");
  const allVaultEvents = await fetchAllVaultEvents(v0, v1);
  console.log(`   Found ${allVaultEvents.length} total vault events`);

  // 4. Categorize events
  const swapEvents: VaultEvent[] = [];
  const externalEvents: VaultEvent[] = [];

  for (const ev of allVaultEvents) {
    if (swapTxHashes.has(ev.transactionHash)) {
      swapEvents.push(ev);
    } else {
      externalEvents.push(ev);
    }
  }
  console.log(`   Swap-induced: ${swapEvents.length}`);
  console.log(`   Non-swap:     ${externalEvents.length}`);

  // Group non-swap events by tx to identify external capital vs external rebalancing
  const byTx = new Map<string, VaultEvent[]>();
  for (const ev of externalEvents) {
    const arr = byTx.get(ev.transactionHash) ?? [];
    arr.push(ev);
    byTx.set(ev.transactionHash, arr);
  }

  // Heuristic: a tx that only touches one side (all deposits or all supply ops on one asset)
  // is external capital. A tx with mixed operations across assets is rebalancing.
  const capitalTxs = new Set<string>();
  const rebalTxs = new Set<string>();

  for (const [txHash, txEvents] of byTx) {
    const vaults = new Set(txEvents.map(e => e.vaultIndex));
    const ops = new Set(txEvents.map(e => e.operation));
    // External rebalancing: touches both vaults, or has both supply + debt ops
    const touchesBothVaults = vaults.size > 1;
    const hasBothSides = (ops.has("deposit") || ops.has("withdraw")) && (ops.has("borrow") || ops.has("repay"));
    if (touchesBothVaults || hasBothSides) {
      rebalTxs.add(txHash);
    } else {
      capitalTxs.add(txHash);
    }
  }

  // Compute net equity effects per category
  let extCap0 = 0, extCap1 = 0;
  let extRebal0 = 0, extRebal1 = 0;

  console.log("\n   ── External capital flows ──");
  for (const [txHash, txEvents] of byTx) {
    if (!capitalTxs.has(txHash)) continue;
    for (const ev of txEvents) {
      const dec = ev.vaultIndex === 0 ? DEC0 : DEC1;
      const sym = ev.vaultIndex === 0 ? "USDC" : "WETH";
      const amount = Number(formatUnits(ev.assets, dec));
      const signed = amount * equitySign(ev.operation);
      if (ev.vaultIndex === 0) extCap0 += signed;
      else extCap1 += signed;
      console.log(`   ${ev.operation.padEnd(8)} ${sym.padEnd(5)} ${amount.toFixed(6).padStart(14)}  equity ${signed > 0 ? "+" : ""}${signed.toFixed(6)}  block ${ev.blockNumber}  tx ${txHash.slice(0, 10)}...`);
    }
  }
  console.log(`   Net external capital: ${extCap0.toFixed(4)} USDC, ${extCap1.toFixed(6)} WETH`);

  console.log("\n   ── External rebalancing flows ──");
  for (const [txHash, txEvents] of byTx) {
    if (!rebalTxs.has(txHash)) continue;
    console.log(`   TX ${txHash.slice(0, 10)}...:`);
    for (const ev of txEvents) {
      const dec = ev.vaultIndex === 0 ? DEC0 : DEC1;
      const sym = ev.vaultIndex === 0 ? "USDC" : "WETH";
      const amount = Number(formatUnits(ev.assets, dec));
      const signed = amount * equitySign(ev.operation);
      if (ev.vaultIndex === 0) extRebal0 += signed;
      else extRebal1 += signed;
      console.log(`     ${ev.operation.padEnd(8)} ${sym.padEnd(5)} ${amount.toFixed(6).padStart(14)}  equity ${signed > 0 ? "+" : ""}${signed.toFixed(6)}`);
    }
  }
  console.log(`   Net external rebal: ${extRebal0.toFixed(4)} USDC, ${extRebal1.toFixed(6)} WETH`);

  // 5. Fetch current prices
  console.log("\n4. Fetching current USD prices...");
  const { p0, p1 } = await fetchCurrentPrices();
  console.log(`   USDC: $${p0.toFixed(4)}, WETH: $${p1.toFixed(2)}`);

  // 6. Fetch current vault positions
  console.log("\n5. Fetching current vault positions...");
  const vp = await fetchVaultPositions(v0, v1);
  const dep0 = Number(formatUnits(vp.dep0, DEC0));
  const dep1 = Number(formatUnits(vp.dep1, DEC1));
  const dbt0 = Number(formatUnits(vp.debt0, DEC0));
  const dbt1 = Number(formatUnits(vp.debt1, DEC1));
  console.log(`   Deposits: ${dep0.toFixed(2)} USDC, ${dep1.toFixed(6)} WETH`);
  console.log(`   Debts:    ${dbt0.toFixed(2)} USDC, ${dbt1.toFixed(6)} WETH`);
  console.log(`   Equity:   ${(dep0 - dbt0).toFixed(2)} USDC, ${(dep1 - dbt1).toFixed(6)} WETH`);

  // 7. Compute P&L attribution
  console.log("\n6. Computing P&L attribution...\n");

  const navUsd = (dep0 - dbt0) * p0 + (dep1 - dbt1) * p1;
  const netInvestedUsd = extCap0 * p0 + extCap1 * p1;
  const totalPnl = navUsd - netInvestedUsd;

  // Swap fees + swap rebalancing
  let totalFee0 = 0, totalFee1 = 0;
  let swapRebal0 = 0, swapRebal1 = 0;
  let volIn0 = 0, volIn1 = 0;

  for (const s of swaps) {
    const f0 = Number(formatUnits(s.fee0, DEC0));
    const f1 = Number(formatUnits(s.fee1, DEC1));
    const in0 = Number(formatUnits(s.amount0In, DEC0));
    const out0 = Number(formatUnits(s.amount0Out, DEC0));
    const in1 = Number(formatUnits(s.amount1In, DEC1));
    const out1 = Number(formatUnits(s.amount1Out, DEC1));
    totalFee0 += f0;
    totalFee1 += f1;
    swapRebal0 += (in0 - out0);
    swapRebal1 += (in1 - out1);
    volIn0 += in0;
    volIn1 += in1;
  }

  const feesUsd = totalFee0 * p0 + totalFee1 * p1;
  const swapRebalUsd = swapRebal0 * p0 + swapRebal1 * p1;
  const extRebalUsd = extRebal0 * p0 + extRebal1 * p1;
  const volumeUsd = volIn0 * p0 + volIn1 * p1;

  // Interest = residual after accounting for fees, swap rebal, and external rebal
  const interestUsd = totalPnl - feesUsd - swapRebalUsd - extRebalUsd;

  const returnPct = netInvestedUsd > 0 ? totalPnl / netInvestedUsd : 0;

  // ─── Results ──────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          P&L Attribution (4-way)                     ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Swaps:         ${swaps.length.toString().padStart(10)}                         ║`);
  console.log(`║  Vault events:  ${allVaultEvents.length.toString().padStart(10)}                         ║`);
  console.log(`║  Volume:        $${volumeUsd.toFixed(2).padStart(14)}                    ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  NAV:           $${navUsd.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Net Invested:  $${netInvestedUsd.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Total P&L:     $${totalPnl.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Return:        ${(returnPct * 100).toFixed(2).padStart(10)}%                       ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Fees:          $${feesUsd.toFixed(2).padStart(14)}  (swap fees)        ║`);
  console.log(`║  Swap rebal:    $${swapRebalUsd.toFixed(2).padStart(14)}  (IL from swaps)    ║`);
  console.log(`║  Ext rebal:     $${extRebalUsd.toFixed(2).padStart(14)}  (DEX rebal cost)   ║`);
  console.log(`║  Interest:      $${interestUsd.toFixed(2).padStart(14)}  (residual)         ║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  const sum = feesUsd + swapRebalUsd + extRebalUsd + interestUsd;
  const residual = Math.abs(totalPnl - sum);
  console.log(`║  Σ components:  $${sum.toFixed(2).padStart(14)}                    ║`);
  console.log(`║  Residual:      $${residual.toFixed(10).padStart(18)}                ║`);
  if (residual < 0.01) {
    console.log("║  Identity:      totalPnl = fees + swapRebal           ║");
    console.log("║                         + extRebal + interest         ║");
  } else {
    console.log("║  IDENTITY BROKEN — residual too large!                ║");
  }
  console.log("╚══════════════════════════════════════════════════════╝");

  // ─── Per-asset verification ───────────────────────────────────────
  console.log("\n── Per-asset accounting ──");
  // equity_now = extCap + swapRebal + fees + extRebal + interest_per_asset
  // → interest_per_asset = equity_now - extCap - swapRebal - fees - extRebal
  const eq0 = dep0 - dbt0;
  const eq1 = dep1 - dbt1;
  const interest0 = eq0 - extCap0 - swapRebal0 - totalFee0 - extRebal0;
  const interest1 = eq1 - extCap1 - swapRebal1 - totalFee1 - extRebal1;

  console.log("  USDC:");
  console.log(`    Equity now:     ${eq0.toFixed(4)}`);
  console.log(`    Ext capital:    ${extCap0.toFixed(4)}`);
  console.log(`    Swap rebal:     ${swapRebal0.toFixed(4)}`);
  console.log(`    Fees:           ${totalFee0.toFixed(4)}`);
  console.log(`    Ext rebal:      ${extRebal0.toFixed(4)}`);
  console.log(`    Implied int:    ${interest0.toFixed(4)} ($${(interest0 * p0).toFixed(2)})`);

  console.log("  WETH:");
  console.log(`    Equity now:     ${eq1.toFixed(6)}`);
  console.log(`    Ext capital:    ${extCap1.toFixed(6)}`);
  console.log(`    Swap rebal:     ${swapRebal1.toFixed(6)}`);
  console.log(`    Fees:           ${totalFee1.toFixed(6)}`);
  console.log(`    Ext rebal:      ${extRebal1.toFixed(6)}`);
  console.log(`    Implied int:    ${interest1.toFixed(6)} ($${(interest1 * p1).toFixed(2)})`);

  const interestFromAssets = interest0 * p0 + interest1 * p1;
  const intCheck = Math.abs(interestUsd - interestFromAssets);
  console.log(`\n  Interest cross-check: residual=$${interestUsd.toFixed(2)}, per-asset=$${interestFromAssets.toFixed(2)}, diff=$${intCheck.toFixed(6)} ${intCheck < 0.01 ? "OK" : "MISMATCH"}`);

  // ─── Plausibility ────────────────────────────────────────────────
  console.log("\n── Plausibility checks ──");
  const poolAgeDays = 30; // approximate
  console.log(`  Pool age: ~${poolAgeDays} days`);
  console.log(`  Fees/day:            $${(feesUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  Swap rebal/day:      $${(swapRebalUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  Interest/day:        $${(interestUsd / poolAgeDays).toFixed(2)}`);
  console.log(`  Interest ann. rate:  ${((interestUsd / netInvestedUsd) * (365 / poolAgeDays) * 100).toFixed(2)}%`);
  console.log(`  Fee yield ann.:      ${((feesUsd / netInvestedUsd) * (365 / poolAgeDays) * 100).toFixed(2)}%`);

  // Sanity: fees non-negative, no bidirectional swaps
  const feeNeg = swaps.filter(s => s.fee0 < 0n || s.fee1 < 0n);
  let noInput = 0;
  for (const s of swaps) { if (s.amount0In === 0n && s.amount1In === 0n) noInput++; }
  console.log(`  Negative fees:       ${feeNeg.length === 0 ? "none" : `${feeNeg.length} swaps!`}`);
  console.log(`  Zero-input swaps:    ${noInput}`);
}

main().catch(e => { console.error(e); process.exit(1); });
