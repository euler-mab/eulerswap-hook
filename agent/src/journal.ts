import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  AgentConfig,
  PoolSnapshot,
  ExecutedAction,
  ClaudeReview,
  RuleResult,
  AssetDecimals,
  VaultDebtInfo,
  RegistryInfo,
} from "./types.js";
import { BPS, fmtToken } from "./types.js";

const JOURNAL_DIR = join(import.meta.dirname ?? ".", "..", "journal");

// Pool address prefix for journal files — set on startup to namespace
// different pools (fork vs mainnet, multiple pools) into separate files.
let poolPrefix = "";

export function setPool(poolAddress: string): void {
  poolPrefix = poolAddress.slice(0, 6).toLowerCase(); // e.g. "0x4311"
}

function ensureDir(): void {
  if (!existsSync(JOURNAL_DIR)) {
    mkdirSync(JOURNAL_DIR, { recursive: true });
  }
}

function todayFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const suffix = poolPrefix ? `-${poolPrefix}` : "";
  return join(JOURNAL_DIR, `${yyyy}-${mm}-${dd}${suffix}.md`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function append(line: string): void {
  ensureDir();
  const file = todayFile();
  if (!existsSync(file)) {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(file, `# LP Agent Journal — ${date}\n\n`);
  }
  appendFileSync(file, line + "\n");
}

const fmtWad = (v: bigint) => (Number(v) / 1e18).toFixed(4);
const fmtBps = (v: bigint) => (Number(v) / Number(BPS)).toFixed(1);
const fmtEth = (v: bigint) => (Number(v) / 1e18).toFixed(6);

export function startup(config: AgentConfig): void {
  append(`## ${timestamp()} — Startup`);
  append(`- Pool: \`${config.poolAddress}\``);
  append(`- Hook: \`${config.hookAddress}\``);
  append(`- Poll interval: ${config.pollInterval}s`);
  append(`- Claude review interval: ${config.claudeReviewInterval}s`);
  append(`- Daily gas budget: ${fmtEth(config.dailyGasBudget)} ETH`);
  append("");
}

export function snapshot(snap: PoolSnapshot, decimals?: AssetDecimals): void {
  const r0 = decimals ? fmtToken(snap.reserve0, decimals.dec0) : fmtWad(snap.reserve0);
  const r1 = decimals ? fmtToken(snap.reserve1, decimals.dec1) : fmtWad(snap.reserve1);
  append(`## ${timestamp()} — Snapshot (block ${snap.blockNumber})`);
  append(`- Reserves: ${r0} / ${r1}`);
  append(`- Oracle: ${fmtWad(snap.oraclePrice)}, Marginal: ${fmtWad(snap.marginalPrice)}`);
  append(`- Mismatch: ${fmtBps(snap.mismatch)} bps`);
  append(`- Concentration: X=${fmtWad(snap.concentrationX)}, Y=${fmtWad(snap.concentrationY)}`);
  append("");
}

export function ruleResults(results: RuleResult[]): void {
  const triggered = results.filter((r) => r.triggered);
  if (triggered.length === 0) return;

  append(`## ${timestamp()} — Rules Triggered`);
  for (const r of triggered) {
    append(`- **${r.name}**: ${r.reason}`);
    if (r.action) {
      append(`  - Action: ${r.action.type} — ${r.action.reason}`);
    }
  }
  append("");
}

export function action(executed: ExecutedAction): void {
  append(`## ${timestamp()} — Action: ${executed.type}`);
  append(`- Reason: ${executed.reason}`);
  append(`- Tx: \`${executed.txHash}\``);
  append(`- Gas: ${fmtEth(executed.gasUsed)} ETH`);
  append(`- Status: ${executed.success ? "OK" : "FAILED"}`);
  append("");
}

export function claudeReview(review: ClaudeReview): void {
  append(`## ${timestamp()} — Claude Review`);
  if (review.marketAnalysis) {
    append(`**Market**: ${review.marketAnalysis}`);
  }
  if (review.recommendations.length > 0) {
    append(`**Recommendations**:`);
    for (const rec of review.recommendations) {
      append(`- ${rec.type} (confidence ${(rec.confidence * 100).toFixed(0)}%): ${rec.reasoning}`);
    }
  } else {
    append(`**Recommendations**: None — current params look good.`);
  }
  if (review.strategyNotes) {
    append(`**Notes**: ${review.strategyNotes}`);
  }
  append("");
}

export function vaultInfo(vaultDebt: VaultDebtInfo, decimals?: AssetDecimals): void {
  const fmtR0 = (v: bigint) => decimals ? fmtToken(v, decimals.dec0) : fmtWad(v);
  const fmtR1 = (v: bigint) => decimals ? fmtToken(v, decimals.dec1) : fmtWad(v);
  append(`## ${timestamp()} — Vault Info`);
  append(`- Type: ${vaultDebt.isBooster ? "booster" : "standard"}`);
  append(`- Deposits: ${fmtR0(vaultDebt.deposit0)} / ${fmtR1(vaultDebt.deposit1)}`);
  append(`- Debt: ${fmtR0(vaultDebt.debt0)} / ${fmtR1(vaultDebt.debt1)}`);
  append(`- Cross-vault LTV: asset0=${(vaultDebt.ltv0 / 100).toFixed(1)}%, asset1=${(vaultDebt.ltv1 / 100).toFixed(1)}%`);
  append(`- Max leverage: asset0=${vaultDebt.maxLeverage0.toFixed(2)}x, asset1=${vaultDebt.maxLeverage1.toFixed(2)}x`);
  append("");
}

export function arbResult(result: {
  direction: string;
  profit: string;
  profitUsd: number;
  txHash?: string;
  success: boolean;
  gasUsed?: string;
  reason?: string;
}): void {
  append(`## ${timestamp()} — Arb ${result.success ? "Executed" : "Failed"}`);
  append(`- Direction: ${result.direction}`);
  if (result.success) {
    append(`- Profit: ${result.profit} ($${result.profitUsd.toFixed(2)})`);
    append(`- Tx: \`${result.txHash}\``);
    append(`- Gas: ${result.gasUsed} ETH`);
  } else {
    append(`- Reason: ${result.reason}`);
  }
  append("");
}

export function registryStatus(info: RegistryInfo): void {
  append(`## ${timestamp()} — Registry`);
  append(`- Registered: ${info.registered}`);
  append(`- Validity bond: ${fmtEth(info.validityBond)} ETH`);
  append(`- Total pools in registry: ${info.totalPoolsInRegistry.toString()}`);
  append("");
}

export function registryAlert(msg: string): void {
  append(`## ${timestamp()} — REGISTRY ALERT`);
  append(`- ${msg}`);
  append("");
}

export function error(msg: string): void {
  append(`## ${timestamp()} — Error`);
  append(`- ${msg}`);
  append("");
}
