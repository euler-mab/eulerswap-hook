/**
 * Yield Basis Releverage vs EulerSwap Auction — Monte Carlo comparison.
 *
 * Both mechanisms solve the same problem: rebalancing a leveraged LP position
 * without external swaps. They differ in HOW:
 *
 *   YB:         Leveraged xy=k curve, recenter after every swap.
 *               Fixed fee (70 bps). Discrete IL ≈ σ²T/4.
 *
 *   EulerSwap:  Concentrated curve + oracle-reactive fees + fee-decay auction.
 *               Variable fee. Recenters when exposure decreases or auction triggers.
 *
 * Runs N seeds head-to-head with P&L decomposition:
 *   ΔNAV = NetFees + Edge − InterestPaid + DirectionalPnL
 *
 * Usage: npx tsx scripts/yb-comparison.ts
 */

import { PAIRS } from "../src/lib/sim-pairs";
import {
  eulerSwapStrategy, xyKStrategy, yieldBasisReleverageStrategy,
  DEFAULT_EULER_PARAMS,
} from "../src/lib/sim-strategy";
import type { Params } from "../src/lib/math";
import {
  oracleFeeHook, continuousRecenterHook, auctionBackstopHook,
  compositeHook, staticFeeHook,
} from "../src/lib/sim-hooks";
import { DEFAULT_RETAIL } from "../src/lib/sim-retail";
import {
  runSimulation,
  DEFAULT_SIM_CONFIG,
  type EngineConfig, type StrategyResult,
} from "../src/lib/sim-engine";

// ─── Config ──────────────────────────────────────────────────────────

const pair = PAIRS["WETH/USDC"];
const equity = 1_000_000;
const baseSim = { ...DEFAULT_SIM_CONFIG, vol: 0.60, durationDays: 30, stepsPerDay: 24 };
const refVenue = { depthUSDC: 100_000_000, fee: pair.uniswapFeeTier };
const retail = { ...DEFAULT_RETAIL };
const N_SEEDS = 50;
const RX = 0.05;

const oracleCfg = {
  baseFee: 0.0005, maxFee: 0.05,
  captureRate: 0.5, attractRate: 0.003,
  externalFee: pair.uniswapFeeTier,
};

function fullHook(rx: number, surcharge = 0.005) {
  return compositeHook(
    oracleFeeHook(oracleCfg),
    continuousRecenterHook({ rx, surchargeInitial: surcharge, surchargeDecayPerStep: 0.02 }),
    auctionBackstopHook({
      triggerExposureRatio: 0.70, shiftMagnitude: 0.0108,
      decayBpsPerMinute: 21.5, clearThreshold: 0.001,
      minAuctionMinutes: 1, baseFee: 0.0005, refFee: pair.uniswapFeeTier, rx,
    }),
  );
}

// ─── Strategy factories (fresh hook state per seed) ─────────────────

interface StrategyFactory {
  name: string;
  make: () => ReturnType<typeof xyKStrategy>;
}

const strategies: StrategyFactory[] = [
  // Normalizer: standard xy=k
  { name: 'xy=k 30bps',
    make: () => xyKStrategy(0.003, 'xy=k 30bps') },

  // YB releverage variants
  { name: 'YB L=2 70bps',
    make: () => yieldBasisReleverageStrategy({ leverage: 2, fee: 0.007, borrowRateAnnual: 0.05, name: 'YB L=2 70bps' }) },
  { name: 'YB L=2 30bps',
    make: () => yieldBasisReleverageStrategy({ leverage: 2, fee: 0.003, borrowRateAnnual: 0.05, name: 'YB L=2 30bps' }) },
  { name: 'YB L=2 5bps',
    make: () => yieldBasisReleverageStrategy({ leverage: 2, fee: 0.0005, borrowRateAnnual: 0.05, name: 'YB L=2 5bps' }) },

  // EulerSwap variants
  { name: 'ES oracle+recenter',
    make: () => eulerSwapStrategy({
      baseParams: DEFAULT_EULER_PARAMS, rx: RX,
      hook: compositeHook(
        oracleFeeHook(oracleCfg),
        continuousRecenterHook({ rx: RX, surchargeInitial: 0.005, surchargeDecayPerStep: 0.02 }),
      ),
      name: 'ES oracle+rctr',
    }) },
  { name: 'ES full stack',
    make: () => eulerSwapStrategy({
      baseParams: DEFAULT_EULER_PARAMS, rx: RX,
      hook: fullHook(RX),
      name: 'ES full stack',
    }) },
  { name: 'ES static 30bps',
    make: () => eulerSwapStrategy({
      baseParams: DEFAULT_EULER_PARAMS, rx: RX,
      hook: staticFeeHook(0.003),
      name: 'ES static 30bps',
    }) },
];

// ─── Accumulator ─────────────────────────────────────────────────────

interface Accum {
  deltaNAV: number[];
  netFees: number[];
  edge: number[];
  arbFee: number[];
  retFee: number[];
  aucCost: number[];
  interest: number[];
  dirPnL: number[];
  avgExp: number[];
  minH: number[];
  recenters: number[];
  auctions: number[];
  retCapture: number[];
  liquidated: number;
}

function newAccum(): Accum {
  return {
    deltaNAV: [], netFees: [], edge: [], arbFee: [], retFee: [],
    aucCost: [], interest: [], dirPnL: [], avgExp: [], minH: [],
    recenters: [], auctions: [], retCapture: [], liquidated: 0,
  };
}

function push(a: Accum, r: StrategyResult) {
  a.deltaNAV.push(r.finalNAV - r.initialNAV);
  a.netFees.push(r.netFees);
  a.edge.push(r.edge);
  a.arbFee.push(r.arbFeeRevenue);
  a.retFee.push(r.retailFeeRevenue);
  a.aucCost.push(r.auctionCost);
  a.interest.push(r.interestPaid);
  a.dirPnL.push(r.directionalPnL);
  a.avgExp.push(r.avgExposurePct);
  a.minH.push(r.minHealth);
  a.recenters.push(r.totalRecenters);
  a.auctions.push(r.totalAuctions);
  a.retCapture.push(r.retailCaptureRate);
  if (r.liquidated) a.liquidated++;
}

function mean(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
}

// ─── Run ─────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
console.log(`  Yield Basis vs EulerSwap — Monte Carlo Comparison (${N_SEEDS} seeds)`);
console.log(`  WETH/USDC | Vol: ${(baseSim.vol * 100).toFixed(0)}% | ${baseSim.durationDays}d | $${(equity / 1e6).toFixed(0)}M equity`);
console.log(`  Decomposition: ΔNAV = NetFees + Edge − Interest + DirectionalPnL`);
console.log('══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');

const accums: Map<string, Accum> = new Map();
for (const sf of strategies) accums.set(sf.name, newAccum());

for (let seed = 1; seed <= N_SEEDS; seed++) {
  if (seed % 10 === 0) process.stderr.write(`  seed ${seed}/${N_SEEDS}\n`);
  const sim = { ...baseSim, seed };

  for (const sf of strategies) {
    const strat = sf.make();
    const result = runSimulation({
      strategies: [strat],
      initialValueUSDC: equity,
      startPrice: 1 / pair.price,
      sim,
      retail,
      refVenue,
      defaultFee: 0.003,
      borrowRateAnnual: 0.05,
    });
    push(accums.get(sf.name)!, result.strategies[0]);
  }
}

// ─── Output ──────────────────────────────────────────────────────────

function fmtUSD(v: number): string {
  if (Math.abs(v) < 1) return v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
  return v >= 0 ? `$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
}

console.log('\n  ── Mean values across seeds ──\n');
console.log(
  '  ' +
  'Strategy'.padEnd(20) +
  'ΔNAV'.padStart(10) +
  'NetFees'.padStart(10) +
  'Edge'.padStart(10) +
  'ArbFee'.padStart(10) +
  'RetFee'.padStart(9) +
  'AucCst'.padStart(9) +
  'Intst'.padStart(8) +
  'DirPnL'.padStart(10) +
  'AvgE%'.padStart(7) +
  'RetC%'.padStart(7) +
  'Rctr'.padStart(6) +
  'Liq'.padStart(5)
);
console.log('  ' + '─'.repeat(131));

for (const sf of strategies) {
  const a = accums.get(sf.name)!;
  console.log(
    '  ' +
    sf.name.padEnd(20) +
    fmtUSD(mean(a.deltaNAV)).padStart(10) +
    fmtUSD(mean(a.netFees)).padStart(10) +
    fmtUSD(mean(a.edge)).padStart(10) +
    fmtUSD(mean(a.arbFee)).padStart(10) +
    fmtUSD(mean(a.retFee)).padStart(9) +
    fmtUSD(mean(a.aucCost)).padStart(9) +
    fmtUSD(mean(a.interest)).padStart(8) +
    fmtUSD(mean(a.dirPnL)).padStart(10) +
    `${(mean(a.avgExp) * 100).toFixed(0)}%`.padStart(7) +
    `${(mean(a.retCapture) * 100).toFixed(0)}%`.padStart(7) +
    `${mean(a.recenters).toFixed(0)}`.padStart(6) +
    `${a.liquidated}`.padStart(5)
  );
}

console.log('\n  ── Standard deviation ──\n');
console.log(
  '  ' +
  'Strategy'.padEnd(20) +
  'ΔNAV'.padStart(10) +
  'NetFees'.padStart(10) +
  'Edge'.padStart(10) +
  'DirPnL'.padStart(10) +
  'DirPnL/ΔNAV'.padStart(13)
);
console.log('  ' + '─'.repeat(73));

for (const sf of strategies) {
  const a = accums.get(sf.name)!;
  const navStd = std(a.deltaNAV);
  const dirStd = std(a.dirPnL);
  const ratio = navStd > 0 ? (dirStd / navStd * 100).toFixed(0) + '%' : '—';
  console.log(
    '  ' +
    sf.name.padEnd(20) +
    fmtUSD(navStd).padStart(10) +
    fmtUSD(std(a.netFees)).padStart(10) +
    fmtUSD(std(a.edge)).padStart(10) +
    fmtUSD(dirStd).padStart(10) +
    ratio.padStart(13)
  );
}

console.log('\n  ── Percentiles ──\n');
console.log(
  '  ' +
  'Strategy'.padEnd(20) +
  'ΔNAV p5'.padStart(10) +
  'ΔNAV p25'.padStart(10) +
  'ΔNAV p50'.padStart(10) +
  'ΔNAV p75'.padStart(10) +
  'ΔNAV p95'.padStart(10) +
  '  │' +
  'DirP p5'.padStart(10) +
  'DirP p50'.padStart(10) +
  'DirP p95'.padStart(10)
);
console.log('  ' + '─'.repeat(110));

for (const sf of strategies) {
  const a = accums.get(sf.name)!;
  console.log(
    '  ' +
    sf.name.padEnd(20) +
    fmtUSD(pct(a.deltaNAV, 0.05)).padStart(10) +
    fmtUSD(pct(a.deltaNAV, 0.25)).padStart(10) +
    fmtUSD(pct(a.deltaNAV, 0.50)).padStart(10) +
    fmtUSD(pct(a.deltaNAV, 0.75)).padStart(10) +
    fmtUSD(pct(a.deltaNAV, 0.95)).padStart(10) +
    '  │' +
    fmtUSD(pct(a.dirPnL, 0.05)).padStart(10) +
    fmtUSD(pct(a.dirPnL, 0.50)).padStart(10) +
    fmtUSD(pct(a.dirPnL, 0.95)).padStart(10)
  );
}

// ─── Key insights ────────────────────────────────────────────────────

console.log('\n  ── Key Comparisons ──\n');

const ybAcc = accums.get('YB L=2 70bps')!;
const esAcc = accums.get('ES full stack')!;
const xykAcc = accums.get('xy=k 30bps')!;

const ybNetFee = mean(ybAcc.netFees);
const esNetFee = mean(esAcc.netFees);
const xykNetFee = mean(xykAcc.netFees);

const ybEdge = mean(ybAcc.edge);
const esEdge = mean(esAcc.edge);
const xykEdge = mean(xykAcc.edge);

console.log(`  Fee revenue advantage:`);
console.log(`    YB vs xy=k:      ${fmtUSD(ybNetFee - xykNetFee)} (${((ybNetFee/xykNetFee - 1)*100).toFixed(0)}%)`);
console.log(`    ES vs xy=k:      ${fmtUSD(esNetFee - xykNetFee)} (${((esNetFee/xykNetFee - 1)*100).toFixed(0)}%)`);
console.log(`    YB vs ES:        ${fmtUSD(ybNetFee - esNetFee)}`);
console.log();
console.log(`  LVR (negative edge, mean):`);
console.log(`    YB:              ${fmtUSD(ybEdge)}`);
console.log(`    ES full stack:   ${fmtUSD(esEdge)}`);
console.log(`    xy=k:            ${fmtUSD(xykEdge)}`);
console.log();

// Theoretical IL check for YB
// Discrete IL for L=2 ≈ L × σ²T/8 × NAV = 2 × 0.36 × (30/365) × 1M / 8
const theoreticalIL = 2 * baseSim.vol ** 2 * (baseSim.durationDays / 365) * equity / 8;
const actualYBEdge = Math.abs(mean(ybAcc.edge));
console.log(`  Discrete IL check (YB):`);
console.log(`    Theoretical (Lσ²T/8):  ${fmtUSD(theoreticalIL)}`);
console.log(`    Actual mean |edge|:    ${fmtUSD(actualYBEdge)}`);

// ─── Decomposition sanity check ──────────────────────────────────────

console.log('\n  ── Sanity check (residual should be ~$0) ──\n');
for (const sf of strategies) {
  const a = accums.get(sf.name)!;
  const residuals = a.deltaNAV.map((dv, i) =>
    dv - a.netFees[i] - a.edge[i] + a.interest[i] - a.dirPnL[i]
  );
  const maxResidual = Math.max(...residuals.map(Math.abs));
  console.log(`  ${sf.name.padEnd(20)} max residual: ${fmtUSD(maxResidual)} ${maxResidual < 1 ? '✓' : '✗'}`);
}
