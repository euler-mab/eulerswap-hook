import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  AgentConfig,
  PoolSnapshot,
  ExecutedAction,
  ClaudeReview,
  RuleResult,
} from "./types.js";
import { BPS } from "./types.js";

const JOURNAL_DIR = join(import.meta.dirname ?? ".", "..", "journal");

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
  return join(JOURNAL_DIR, `${yyyy}-${mm}-${dd}.md`);
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

export function snapshot(snap: PoolSnapshot): void {
  append(`## ${timestamp()} — Snapshot (block ${snap.blockNumber})`);
  append(`- Reserves: ${fmtWad(snap.reserve0)} / ${fmtWad(snap.reserve1)}`);
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

export function error(msg: string): void {
  append(`## ${timestamp()} — Error`);
  append(`- ${msg}`);
  append("");
}
