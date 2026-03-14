/**
 * Diagnostic: trace D4 (no recenter) vs D5 (continuous recenter) step by step.
 * Goal: understand why D5 collects ~10x less arb fees than D4.
 */

import { mulberry32, generatePricePath } from "../src/lib/simulate";
import {
  eulerSwapStrategy,
  DEFAULT_EULER_PARAMS,
  vaultStateAt,
  computeNAV,
  computeExposure,
} from "../src/lib/sim-strategy";
import {
  oracleFeeHook,
  continuousRecenterHook,
  compositeHook,
  type OracleFeeConfig,
} from "../src/lib/sim-hooks";
import { runSimulation, DEFAULT_SIM_CONFIG, type EngineConfig } from "../src/lib/sim-engine";

const oracleConfig: OracleFeeConfig = {
  baseFee: 0.0005,
  maxFee: 0.05,
  captureRate: 0.5,
  attractRate: 0.003,
  externalFee: 0.0005,
};

// D4: oracle fee only
const d4 = eulerSwapStrategy({
  name: "D4-noRecenter",
  baseParams: DEFAULT_EULER_PARAMS,
  rx: 10,
  hook: oracleFeeHook(oracleConfig),
});

// D5: oracle fee + continuous recenter
const d5 = eulerSwapStrategy({
  name: "D5-recenter",
  baseParams: DEFAULT_EULER_PARAMS,
  rx: 10,
  hook: compositeHook(
    oracleFeeHook(oracleConfig),
    continuousRecenterHook({ rx: 10 }),
  ),
});

// Run both with short duration for tracing
const sim = { ...DEFAULT_SIM_CONFIG, durationDays: 30 };
const startPrice = 1 / 1986;
const initialValue = 1_000_000;

// First, run the full simulation to confirm the fee gap
const fullResult = runSimulation({
  strategies: [d4, d5],
  initialValueUSDC: initialValue,
  startPrice,
  sim,
  retail: null,
  refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
  defaultFee: 0.003,
});

console.log("\n=== Full 30-day results ===");
for (const r of fullResult.strategies) {
  console.log(`${r.name}: NAV=$${r.finalNAV.toFixed(0)}, ArbFees=$${r.arbFeeRevenue.toFixed(0)}, Edge=$${r.edge.toFixed(0)}, Recenters=${r.totalRecenters}`);
}

// Now manually step through to trace per-step behavior
console.log("\n=== Step-by-step trace (first 30 steps) ===");

const pricePath = generatePricePath(startPrice, { ...sim, feeBps: 0 });

// Re-init strategies
const s4 = d4.init(initialValue, 0, 1 / startPrice);
const s5 = d5.init(initialValue, 0, 1 / startPrice);

// We need separate hook instances since they have internal state
const hook4 = oracleFeeHook(oracleConfig);
const hook5 = compositeHook(
  oracleFeeHook(oracleConfig),
  continuousRecenterHook({ rx: 10 }),
);

console.log(`\nStep | Price   | D4-x0      | D4-pEquil   | D4-offset% | D4-fee%  | D4-feeUSD | D5-x0      | D5-pEquil   | D5-offset% | D5-fee%  | D5-feeUSD | D5-rctr`);
console.log(`-----|---------|------------|-------------|------------|----------|-----------|------------|-------------|------------|----------|-----------|-------`);

let d4TotalFees = 0;
let d5TotalFees = 0;

for (let i = 1; i <= 50; i++) {
  const extPrice = pricePath[i];
  const ethPrice = 1 / extPrice;

  // D4: compute fee and arb
  const d4Offset = Math.abs(extPrice - s4.pEquil) / s4.pEquil;
  const d4FeeCtx = {
    asset0IsInput: extPrice < s4.pEquil,
    state: s4,
    extPrice,
    ethPrice,
    isArb: true,
    isExposureReducing: false,
    priceOffset: d4Offset,
    exposureFrac: 0,
  };
  const d4Fee = hook4.getFee!(d4FeeCtx) ?? 0.003;
  const d4Gamma = 1 - d4Fee;

  // Arb D4
  let d4FeeUSD = 0;
  const d4PreX = s4.curX;
  const d4PreY = s4.curY;
  let d4Arbed = false;

  if (d4Gamma > 0) {
    let targetPrice: number;
    let shouldArb = false;
    if (extPrice > s4.pEquil) {
      targetPrice = d4Gamma * extPrice;
      shouldArb = targetPrice > s4.pEquil;
    } else {
      targetPrice = extPrice / d4Gamma;
      shouldArb = targetPrice < s4.pEquil;
    }

    if (shouldArb) {
      const target = d4.curve.solveForPrice(s4, targetPrice!);
      if (target) {
        s4.curX = target.x;
        s4.curY = target.y;
        d4Arbed = true;

        // Fee revenue
        const feeMultiplier = (1 - d4Gamma) / d4Gamma;
        if (extPrice > s4.pEquil) {
          const dyNet = Math.max(s4.curY - d4PreY, 0);
          d4FeeUSD = dyNet * feeMultiplier * ethPrice;
          if (s4.vault) s4.vault.yr += dyNet * feeMultiplier;
        } else {
          const dxNet = Math.max(s4.curX - d4PreX, 0);
          d4FeeUSD = dxNet * feeMultiplier;
          if (s4.vault) s4.vault.xr += dxNet * feeMultiplier;
        }
      }
    }
  }
  d4TotalFees += d4FeeUSD;

  // D5: compute fee and arb
  const d5Offset = Math.abs(extPrice - s5.pEquil) / s5.pEquil;
  const d5FeeCtx = {
    asset0IsInput: extPrice < s5.pEquil,
    state: s5,
    extPrice,
    ethPrice,
    isArb: true,
    isExposureReducing: false,
    priceOffset: d5Offset,
    exposureFrac: 0,
  };
  const d5Fee = hook5.getFee!(d5FeeCtx) ?? 0.003;
  const d5Gamma = 1 - d5Fee;

  // Arb D5
  let d5FeeUSD = 0;
  const d5PreX = s5.curX;
  const d5PreY = s5.curY;
  let d5Rctr = false;

  if (d5Gamma > 0) {
    let targetPrice: number;
    let shouldArb = false;
    if (extPrice > s5.pEquil) {
      targetPrice = d5Gamma * extPrice;
      shouldArb = targetPrice > s5.pEquil;
    } else {
      targetPrice = extPrice / d5Gamma;
      shouldArb = targetPrice < s5.pEquil;
    }

    if (shouldArb) {
      const target = d5.curve.solveForPrice(s5, targetPrice!);
      if (target) {
        s5.curX = target.x;
        s5.curY = target.y;

        // Fee revenue
        const feeMultiplier = (1 - d5Gamma) / d5Gamma;
        if (extPrice > s5.pEquil) {
          const dyNet = Math.max(s5.curY - d5PreY, 0);
          d5FeeUSD = dyNet * feeMultiplier * ethPrice;
          if (s5.vault) s5.vault.yr += dyNet * feeMultiplier;
        } else {
          const dxNet = Math.max(s5.curX - d5PreX, 0);
          d5FeeUSD = dxNet * feeMultiplier;
          if (s5.vault) s5.vault.xr += dxNet * feeMultiplier;
        }

        // afterSwap for recenter
        const accum = { totalRecenters: 0, totalAuctions: 0, auctionCost: 0 };
        const afterCtx = {
          state: s5,
          preX: d5PreX, preY: d5PreY,
          fee: d5Fee,
          extPrice, ethPrice,
          isArb: true,
          accum,
          reconfiguredState: undefined as any,
        };
        hook5.afterSwap!(afterCtx);
        if (afterCtx.reconfiguredState) {
          Object.assign(s5, afterCtx.reconfiguredState);
          d5Rctr = true;
        }
      }
    }
  }
  d5TotalFees += d5FeeUSD;

  if (i <= 50) {
    console.log(
      `${String(i).padStart(4)} | ${ethPrice.toFixed(0).padStart(7)} | ${s4.x0.toFixed(0).padStart(10)} | ${(1/s4.pEquil).toFixed(1).padStart(11)} | ${(d4Offset*100).toFixed(3).padStart(10)}% | ${(d4Fee*100).toFixed(3).padStart(7)}% | ${d4FeeUSD.toFixed(0).padStart(9)} | ${s5.x0.toFixed(0).padStart(10)} | ${(1/s5.pEquil).toFixed(1).padStart(11)} | ${(d5Offset*100).toFixed(3).padStart(10)}% | ${(d5Fee*100).toFixed(3).padStart(7)}% | ${d5FeeUSD.toFixed(0).padStart(9)} | ${d5Rctr ? 'Y' : ' '}`
    );
  }
}

console.log(`\nCumulative fees after 50 steps:`);
console.log(`  D4: $${d4TotalFees.toFixed(0)}`);
console.log(`  D5: $${d5TotalFees.toFixed(0)}`);

// Also trace NAV and pool depth
console.log(`\nFinal state after 50 steps:`);
const v4 = s4.vault ? vaultStateAt(s4.curX, s4.curY, s4.x0, s4.y0, s4.vault) : null;
const v5 = s5.vault ? vaultStateAt(s5.curX, s5.curY, s5.x0, s5.y0, s5.vault) : null;
if (v4) console.log(`  D4 vault: xr=${v4.xr.toFixed(0)}, yr=${v4.yr.toFixed(4)}, xd=${v4.xd.toFixed(0)}, yd=${v4.yd.toFixed(4)}, NAV=$${computeNAV(v4, 1/pricePath[50]).toFixed(0)}`);
if (v5) console.log(`  D5 vault: xr=${v5.xr.toFixed(0)}, yr=${v5.yr.toFixed(4)}, xd=${v5.xd.toFixed(0)}, yd=${v5.yd.toFixed(4)}, NAV=$${computeNAV(v5, 1/pricePath[50]).toFixed(0)}`);
console.log(`  D4 x0=${s4.x0.toFixed(0)}, pEquil=${(1/s4.pEquil).toFixed(1)}`);
console.log(`  D5 x0=${s5.x0.toFixed(0)}, pEquil=${(1/s5.pEquil).toFixed(1)}`);

// Now run a MUCH cleaner test: trace cumulative edge and fees per step for full 30 days
// using the engine's own simulation (matching results above)
console.log("\n=== Cumulative Edge Analysis (Full 30d) ===");

// Re-init for cleaner full run
const d4b = eulerSwapStrategy({
  name: "D4",
  baseParams: DEFAULT_EULER_PARAMS,
  rx: 10,
  hook: oracleFeeHook(oracleConfig),
});
const d5b = eulerSwapStrategy({
  name: "D5",
  baseParams: DEFAULT_EULER_PARAMS,
  rx: 10,
  hook: compositeHook(
    oracleFeeHook(oracleConfig),
    continuousRecenterHook({ rx: 10 }),
  ),
});

// Also test: what if D5 just uses static fee (30bps) + recenter?
const d5static = eulerSwapStrategy({
  name: "D5-static",
  baseParams: DEFAULT_EULER_PARAMS,
  rx: 10,
  hook: compositeHook(
    { getFee() { return 0.003; } },  // static 30bps
    continuousRecenterHook({ rx: 10 }),
  ),
});

// And: oracle fee with LESS frequent recentering (only when exposure > 5% of NAV)?
// For now, just compare with the 3 strategies
const result2 = runSimulation({
  strategies: [d4b, d5b, d5static],
  initialValueUSDC: initialValue,
  startPrice,
  sim,
  retail: null,
  refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
  defaultFee: 0.003,
});

console.log("\nFull 30-day comparison:");
console.log("                    NAV       ArbFees     Edge      Net(Fee+Edge)  Rctr");
for (const r of result2.strategies) {
  const nav = r.finalNAV;
  const net = r.arbFeeRevenue + r.edge;
  console.log(`  ${r.name.padEnd(16)} $${nav.toFixed(0).padStart(8)}  $${r.arbFeeRevenue.toFixed(0).padStart(8)}  $${r.edge.toFixed(0).padStart(8)}  $${net.toFixed(0).padStart(8)}      ${r.totalRecenters}`);
}
console.log(`  HODL             $${result2.hodlNAV.toFixed(0).padStart(8)}`);

// Key ratio: fee capture rate = |arbFeeRevenue / edge|
for (const r of result2.strategies) {
  const captureRate = Math.abs(r.arbFeeRevenue / r.edge) * 100;
  console.log(`  ${r.name}: fee capture = ${captureRate.toFixed(1)}% of edge`);
}

// The critical insight: what is the theoretical LVR for each strategy?
// σ²T/8 × V where V is the VIRTUAL reserve value
// D4 virtual x0 stays fixed at ~1.92M. But arb trades shrink as offset builds.
// D5 virtual x0 is similar but pool stays centered → full depth exposed each step.
//
// For xy=k (c=0), LVR per step = σ²/8 × V × dt
// where dt = 1/stepsPerDay, σ² = annVol²
// V = 2*x0 (virtual pool value at equilibrium)
//
// D4: pool is NOT at equil after step 1, so the effective trading depth declines
// D5: pool IS at equil every step → full depth every step

const annVol = 0.60;
const sigma2dt = (annVol * annVol) / 365 / 24;  // per hourly step
const V = 2 * 1917241;  // ~3.83M virtual pool value
const theoreticalLVRPerStep = sigma2dt * V / 8;
const totalSteps = 30 * 24;
console.log(`\nTheoretical LVR analysis:`);
console.log(`  σ²·dt = ${sigma2dt.toFixed(8)}`);
console.log(`  V (virtual pool) = $${V.toFixed(0)}`);
console.log(`  LVR/step = $${theoreticalLVRPerStep.toFixed(2)}`);
console.log(`  Total LVR (${totalSteps} steps) = $${(theoreticalLVRPerStep * totalSteps).toFixed(0)}`);
console.log(`  D4 actual edge = $${Math.abs(result2.strategies[0].edge).toFixed(0)}`);
console.log(`  D5 actual edge = $${Math.abs(result2.strategies[1].edge).toFixed(0)}`);
console.log(`\n  D4 edge is ${(Math.abs(result2.strategies[0].edge) / (theoreticalLVRPerStep * totalSteps) * 100).toFixed(1)}% of theoretical LVR`);
console.log(`  D5 edge is ${(Math.abs(result2.strategies[1].edge) / (theoreticalLVRPerStep * totalSteps) * 100).toFixed(1)}% of theoretical LVR`);

// ─── Part 3: With Retail Flow ────────────────────────────────────────
// The hypothesis: recentering's value is on the retail side. A centered
// pool offers tighter spreads and attracts more routed volume.

import { DEFAULT_RETAIL } from "../src/lib/sim-retail";

console.log("\n" + "═".repeat(80));
console.log("=== WITH RETAIL FLOW ===");
console.log("═".repeat(80));

// Sweep retail arrival rates to find the crossover point
const retailRates = [1, 3, 5, 10, 20, 50];

for (const rate of retailRates) {
  const retail = { ...DEFAULT_RETAIL, arrivalRate: rate };

  // Fresh strategy instances per run (hooks have internal state)
  const d4r = eulerSwapStrategy({
    name: "D4-noRctr",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: oracleFeeHook(oracleConfig),
  });
  const d5r = eulerSwapStrategy({
    name: "D5-rctr",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: compositeHook(
      oracleFeeHook(oracleConfig),
      continuousRecenterHook({ rx: 10 }),
    ),
  });

  const res = runSimulation({
    strategies: [d4r, d5r],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail,
    refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
    defaultFee: 0.003,
  });

  const [r4, r5] = res.strategies;
  const net4 = r4.arbFeeRevenue + r4.retailFeeRevenue + r4.edge;
  const net5 = r5.arbFeeRevenue + r5.retailFeeRevenue + r5.edge;
  const winner = net5 > net4 ? "D5" : "D4";

  console.log(`\nRetail rate=${rate}/hr (${rate * 24}/day), mean=$5K:`);
  console.log(`  ${"".padEnd(12)} ArbFee   RetailFee  Edge      Net       RetailVol  RetailCap%  Rctr`);
  console.log(`  D4-noRctr  $${r4.arbFeeRevenue.toFixed(0).padStart(7)}  $${r4.retailFeeRevenue.toFixed(0).padStart(8)}  $${r4.edge.toFixed(0).padStart(8)}  $${net4.toFixed(0).padStart(8)}  $${r4.retailVolume.toFixed(0).padStart(9)}  ${(r4.retailCaptureRate * 100).toFixed(1).padStart(6)}%     ${r4.totalRecenters}`);
  console.log(`  D5-rctr    $${r5.arbFeeRevenue.toFixed(0).padStart(7)}  $${r5.retailFeeRevenue.toFixed(0).padStart(8)}  $${r5.edge.toFixed(0).padStart(8)}  $${net5.toFixed(0).padStart(8)}  $${r5.retailVolume.toFixed(0).padStart(9)}  ${(r5.retailCaptureRate * 100).toFixed(1).padStart(6)}%     ${r5.totalRecenters}`);
  console.log(`  Winner: ${winner} (Δ=$${Math.abs(net5 - net4).toFixed(0)})`);
}

// Summarize: what's the total fee revenue picture?
console.log("\n=== Summary: Total Fees (Arb + Retail) vs Edge ===");
console.log("The D4 arb fees grow with retail because retail creates displacement that arbs recapture.");
console.log("The oracle fee on the arb side captures most of this recapture value.");
console.log("\nBut is this real alpha? Or is it just charging retail indirectly via the arb cycle?");
console.log("To answer: compare NAV vs HODL (captures everything including exposure P&L).");

for (const rate of retailRates) {
  const retail = { ...DEFAULT_RETAIL, arrivalRate: rate };

  const d4r = eulerSwapStrategy({
    name: "D4",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: oracleFeeHook(oracleConfig),
  });
  const d5r = eulerSwapStrategy({
    name: "D5",
    baseParams: DEFAULT_EULER_PARAMS,
    rx: 10,
    hook: compositeHook(
      oracleFeeHook(oracleConfig),
      continuousRecenterHook({ rx: 10 }),
    ),
  });

  const res = runSimulation({
    strategies: [d4r, d5r],
    initialValueUSDC: initialValue,
    startPrice,
    sim,
    retail,
    refVenue: { depthUSDC: 50_000_000, fee: 0.0005 },
    defaultFee: 0.003,
  });

  const [r4, r5] = res.strategies;
  const d4vsHodl = r4.finalNAV - res.hodlNAV;
  const d5vsHodl = r5.finalNAV - res.hodlNAV;
  console.log(`  rate=${String(rate).padStart(2)}/hr: D4 vs HODL = $${d4vsHodl.toFixed(0).padStart(8)}, D5 vs HODL = $${d5vsHodl.toFixed(0).padStart(8)}, D4 NAV=$${r4.finalNAV.toFixed(0)}, D5 NAV=$${r5.finalNAV.toFixed(0)}`);
}
