/**
 * Validation: test retail routing correctness.
 *
 * 1. Two identical xy=k pools should split retail 50/50
 * 2. A pool with lower fee should capture all retail
 * 3. xy=k with retail should have positive edge (retail pays fees)
 * 4. Each EulerSwap strategy tested 1v1 against ref venue
 */

import {
  eulerSwapStrategy, xyKStrategy,
  DEFAULT_EULER_PARAMS,
} from "../src/lib/sim-strategy";
import {
  oracleFeeHook, continuousRecenterHook, compositeHook,
  type OracleFeeConfig,
} from "../src/lib/sim-hooks";
import {
  runSimulation, DEFAULT_SIM_CONFIG,
  type EngineConfig, type SimConfig,
} from "../src/lib/sim-engine";
import { DEFAULT_RETAIL } from "../src/lib/sim-retail";

const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, durationDays: 30 };
const startPrice = 1 / 1986;
const initialValue = 1_000_000;

function fmt(n: number): string { return n.toFixed(0).padStart(9); }
function pct(n: number): string { return (n * 100).toFixed(1).padStart(6) + "%"; }

// ─── Test 1: Two identical xy=k pools ────────────────────────────────

console.log("=== Test 1: Two identical xy=k 30bps pools ===");
console.log("Expected: similar retail split (not exact 50/50 — ties broken by first-wins, then reserves diverge)");
{
  const a = xyKStrategy(0.003);
  const b = xyKStrategy(0.003);
  a.name = "xy=k-A";
  b.name = "xy=k-B";

  const res = runSimulation({
    strategies: [a, b],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail: { ...DEFAULT_RETAIL, arrivalRate: 10 },
    refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
    defaultFee: 0.003,
  });

  for (const r of res.strategies) {
    console.log(`  ${r.name}: NAV=$${fmt(r.finalNAV)}, RetailVol=$${fmt(r.retailVolume)}, Capture=${pct(r.retailCaptureRate)}, RetailFee=$${fmt(r.retailFeeRevenue)}, Edge=$${fmt(r.edge)}`);
  }
  console.log(`  HODL=$${fmt(res.hodlNAV)}`);
}

// ─── Test 2: Low-fee pool vs high-fee pool ──────────────────────────

console.log("\n=== Test 2: xy=k 5bps vs xy=k 30bps ===");
console.log("Expected: 5bps pool captures more retail (not all — displaced 30bps pool offers better quote on one side)");
{
  const lo = xyKStrategy(0.0005);
  const hi = xyKStrategy(0.003);
  lo.name = "xy=k-5bps";
  hi.name = "xy=k-30bps";

  const res = runSimulation({
    strategies: [lo, hi],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail: { ...DEFAULT_RETAIL, arrivalRate: 10 },
    refVenue: { depthUSDC: 50_000_000, fee: 0.003 },  // high-fee ref
    defaultFee: 0.003,
  });

  for (const r of res.strategies) {
    console.log(`  ${r.name}: NAV=$${fmt(r.finalNAV)}, RetailVol=$${fmt(r.retailVolume)}, Capture=${pct(r.retailCaptureRate)}, RetailFee=$${fmt(r.retailFeeRevenue)}`);
  }
}

// ─── Test 3: xy=k with retail should profit from retail ──────────────

console.log("\n=== Test 3: xy=k 30bps — arb-only vs with retail ===");
console.log("Expected: retail adds fee revenue, NAV improves");
{
  const noRetail = xyKStrategy(0.003);
  noRetail.name = "arb-only";
  const withRetail = xyKStrategy(0.003);
  withRetail.name = "with-retail";

  const resNone = runSimulation({
    strategies: [noRetail],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail: null,
    refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
    defaultFee: 0.003,
  });

  const resRetail = runSimulation({
    strategies: [withRetail],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail: { ...DEFAULT_RETAIL, arrivalRate: 10 },
    refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
    defaultFee: 0.003,
  });

  const rn = resNone.strategies[0];
  const rr = resRetail.strategies[0];
  console.log(`  No retail: NAV=$${fmt(rn.finalNAV)}, ArbFee=$${fmt(rn.arbFeeRevenue)}, Edge=$${fmt(rn.edge)}`);
  console.log(`  10/hr:     NAV=$${fmt(rr.finalNAV)}, ArbFee=$${fmt(rr.arbFeeRevenue)}, RetailFee=$${fmt(rr.retailFeeRevenue)}, Edge=$${fmt(rr.edge)}, RetailVol=$${fmt(rr.retailVolume)}`);
  console.log(`  NAV delta from retail: $${fmt(rr.finalNAV - rn.finalNAV)}`);
}

// ─── Test 4: EulerSwap strategies 1v1 against ref ───────────────────

const oracleConfig: OracleFeeConfig = {
  baseFee: 0.0005,
  maxFee: 0.05,
  captureRate: 0.5,
  attractRate: 0.003,
  externalFee: 0.0005,
};

console.log("\n=== Test 4: Individual strategies vs ref venue (10 retail/hr) ===");
console.log("Each strategy runs alone against $50M ref at 5bps.");

const strategies = [
  { name: "A: xy=k 30bps", make: () => xyKStrategy(0.003) },
  { name: "B: ES oracle-only", make: () => eulerSwapStrategy({
    name: "ES-oracle",
    baseParams: { ...DEFAULT_EULER_PARAMS, vyx: 0, vxy: 0 },
    rx: 10,
    hook: oracleFeeHook(oracleConfig),
  })},
  { name: "C: ES leveraged oracle", make: () => eulerSwapStrategy({
    name: "ES-lev-oracle",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: oracleFeeHook(oracleConfig),
  })},
  { name: "D: ES lev + recenter", make: () => eulerSwapStrategy({
    name: "ES-lev-rctr",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: compositeHook(
      oracleFeeHook(oracleConfig),
      continuousRecenterHook({ rx: 10 }),
    ),
  })},
];

const retailRates = [0, 3, 10, 50];

console.log(`\n${"Strategy".padEnd(24)} ${"Rate".padStart(5)} ${"NAV".padStart(10)} ${"vsHODL".padStart(9)} ${"ArbFee".padStart(9)} ${"RetFee".padStart(9)} ${"Edge".padStart(9)} ${"RetCap%".padStart(8)} ${"Rctr".padStart(5)}`);
console.log("─".repeat(100));

for (const strat of strategies) {
  for (const rate of retailRates) {
    const s = strat.make();
    s.name = strat.name;
    const retail = rate > 0 ? { ...DEFAULT_RETAIL, arrivalRate: rate } : null;

    const res = runSimulation({
      strategies: [s],
      initialValueUSDC: initialValue,
      startPrice,
      sim,
      retail,
      refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
      defaultFee: 0.003,
    });

    const r = res.strategies[0];
    const vsHodl = r.finalNAV - res.hodlNAV;
    const label = rate === 0 ? "arb" : `${rate}/hr`;
    console.log(`${strat.name.padEnd(24)} ${label.padStart(5)} $${fmt(r.finalNAV)} $${fmt(vsHodl)} $${fmt(r.arbFeeRevenue)} $${fmt(r.retailFeeRevenue)} $${fmt(r.edge)} ${pct(r.retailCaptureRate)} ${String(r.totalRecenters).padStart(5)}`);
  }
  console.log("─".repeat(100));
}
