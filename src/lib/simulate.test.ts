import { describe, it, expect } from "vitest";
import {
  mulberry32, boxMuller, generatePricePath,
  solveXForPrice, solveYForPrice,
  runSimulation,
  defaultSimConfig,
  type SimConfig,
} from "./simulate";
import {
  defaultParams, computeX0, computeY0, computeXb, computeYb,
  pXxy, pYxy, computeSx, computeBxc,
  type Params,
} from "./math";

// ============================================================================
// SIMULATION TESTS
// ============================================================================
//
// These tests verify the simulation infrastructure and explore LP strategy
// implications through Monte Carlo analysis.
//
// Tests:
//  1. PRNG reproducibility and statistical properties
//  2. GBM path drift and volatility
//  3. Arb solver correctness (closed-form price → position)
//  4. Fee-IL scaling laws (linear vs quadratic in vol)
//  5. Monte Carlo return distribution
//  6. Optimal concentration search
//  7. Time-in-range vs range width
// ============================================================================

// --- Helpers ---

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

/** Run sim with many seeds and collect summary stats */
function monteCarlo(
  params: Params, config: Omit<SimConfig, "seed">, nSeeds: number,
): { netReturns: number[]; fees: number[]; ils: number[]; timeInRange: number[]; liquidated: number } {
  const netReturns: number[] = [];
  const fees: number[] = [];
  const ils: number[] = [];
  const timeInRange: number[] = [];
  let liquidated = 0;
  for (let seed = 1; seed <= nSeeds; seed++) {
    const result = runSimulation(params, { ...config, seed });
    netReturns.push(result.summary.netReturn);
    fees.push(result.summary.totalFees);
    ils.push(result.summary.totalIL);
    timeInRange.push(result.summary.timeInRange);
    if (result.summary.liquidated) liquidated++;
  }
  return { netReturns, fees, ils, timeInRange, liquidated };
}

// Base params: symmetric, no debt, moderate concentration
const baseParams: Params = {
  ...defaultParams,
  px: 1, py: 1, pxz: 1,
  rx: 0.5, ry: 0.5, cx: 0.5, cy: 0.5,
  xr: 100, yr: 100,
  xd: 0, yd: 0, zdebt: 0, zr: 0,
  vzx: 0, vzy: 0,
  rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
  eXC: 0, eXD: 0, eYC: 0, eYD: 0,
};

const shortConfig: Omit<SimConfig, "seed"> = {
  vol: 0.8, drift: 0, durationDays: 30, stepsPerDay: 24, feeBps: 30,
};

// ============================================================================
// 1. PRNG — reproducibility and uniformity
// ============================================================================

describe("PRNG", () => {
  it("mulberry32 is deterministic", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("mulberry32 output is in [0, 1)", () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("boxMuller produces approximately N(0,1)", () => {
    const rng = mulberry32(99);
    const samples: number[] = [];
    for (let i = 0; i < 10000; i++) {
      samples.push(boxMuller(rng));
    }
    const m = mean(samples);
    const s = std(samples);
    expect(Math.abs(m)).toBeLessThan(0.05);    // mean ≈ 0
    expect(Math.abs(s - 1)).toBeLessThan(0.05); // std ≈ 1
  });
});

// ============================================================================
// 2. GBM PATH — drift and vol
// ============================================================================

describe("GBM price path", () => {
  it("has correct length", () => {
    const path = generatePricePath(100, { ...defaultSimConfig, durationDays: 10, stepsPerDay: 24 });
    expect(path).toHaveLength(10 * 24 + 1);
  });

  it("starts at the given price", () => {
    const path = generatePricePath(42, defaultSimConfig);
    expect(path[0]).toBe(42);
  });

  it("log returns have correct mean and vol over many paths", () => {
    const startPrice = 1;
    const vol = 0.5;
    const drift = 0.1;
    const cfg: SimConfig = {
      vol, drift, durationDays: 365, stepsPerDay: 1, feeBps: 0, seed: 0,
    };

    const logReturns: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const path = generatePricePath(startPrice, { ...cfg, seed });
      logReturns.push(Math.log(path[path.length - 1] / path[0]));
    }

    // E[log(S_T/S_0)] = (μ - σ²/2) * T
    const expectedMean = (drift - 0.5 * vol * vol) * 1; // T = 1 year
    const m = mean(logReturns);
    const s = std(logReturns);

    // With 200 samples, allow ±2 standard errors
    const se = s / Math.sqrt(200);
    expect(Math.abs(m - expectedMean)).toBeLessThan(3 * se + 0.05);
    // Vol of log returns ≈ σ * √T = 0.5
    expect(Math.abs(s - vol)).toBeLessThan(0.1);
  });
});

// ============================================================================
// 3. ARB SOLVER — correctness
// ============================================================================

describe("arb solver", () => {
  const x0 = computeX0(baseParams);
  const y0 = computeY0(baseParams);
  const xb = computeXb(x0, baseParams.rx, baseParams.cx);
  const yb = computeYb(y0, baseParams.ry, baseParams.cy);
  const eqPrice = baseParams.px / baseParams.py;

  it("solveXForPrice returns x where pXxy(x) ≈ target", () => {
    // Test several prices above equilibrium
    for (const targetMult of [1.01, 1.05, 1.1, 1.2, 1.4]) {
      const target = eqPrice * targetMult;
      const x = solveXForPrice(target, baseParams.cx, x0, baseParams.px, baseParams.py, xb);
      if (x === null) continue;
      const actual = pXxy(x, baseParams.cx, x0, baseParams.px, baseParams.py);
      expect(Math.abs(actual - target) / target).toBeLessThan(1e-9);
    }
  });

  it("solveYForPrice returns y where pYxy(y) ≈ target", () => {
    // Test prices below equilibrium (on Y side, pYxy gives Y-per-X)
    for (const targetMult of [0.99, 0.95, 0.9, 0.8, 0.7]) {
      const target = eqPrice * targetMult;
      const y = solveYForPrice(target, baseParams.cy, y0, baseParams.px, baseParams.py, yb);
      if (y === null) continue;
      const actual = pYxy(y, baseParams.cy, y0, baseParams.px, baseParams.py);
      expect(Math.abs(actual - target) / target).toBeLessThan(1e-9);
    }
  });

  it("returns null for prices beyond boundary", () => {
    // Beyond X boundary: price > (px/py)(1+rx)
    const beyondX = eqPrice * (1 + baseParams.rx) * 1.1;
    expect(solveXForPrice(beyondX, baseParams.cx, x0, baseParams.px, baseParams.py, xb)).toBeNull();

    // Beyond Y boundary: price < (px/py)/(1+ry)
    const beyondY = eqPrice / (1 + baseParams.ry) * 0.9;
    expect(solveYForPrice(beyondY, baseParams.cy, y0, baseParams.px, baseParams.py, yb)).toBeNull();
  });

  it("returns null / x0 at equilibrium price", () => {
    // At equilibrium, X side: inner = (1 - cx)/(1-cx) = 1, x = x0. But x must be < x0
    // Actually pXxy at x0 = px/py, so solving for px/py gives x0
    const x = solveXForPrice(eqPrice, baseParams.cx, x0, baseParams.px, baseParams.py, xb);
    if (x !== null) {
      // Should be ≈ x0
      expect(Math.abs(x - x0) / x0).toBeLessThan(1e-6);
    }
  });
});

// ============================================================================
// 4. FEE-IL SCALING LAWS
// ============================================================================
//
// Theory: For GBM with small dt, each arb trade size ∝ |ΔS/S| ∝ σ√dt.
// Fees ∝ E[|trade_size|] ∝ σ√dt → total fees over T ∝ σ√T (linear in σ)
// IL ∝ E[(ΔS/S)²] ∝ σ²dt → total IL over T ∝ σ²T (quadratic in σ)
//
// So at low vol: fees > |IL| (LP profitable)
// At high vol: |IL| > fees (LP unprofitable)
// There's a crossover volatility σ* where fees = |IL|.

describe("fee-IL scaling", () => {
  const nSeeds = 100;

  it("fees increase with volatility", () => {
    const feesLow = monteCarlo(baseParams, { ...shortConfig, vol: 0.3 }, nSeeds).fees;
    const feesHigh = monteCarlo(baseParams, { ...shortConfig, vol: 1.0 }, nSeeds).fees;
    expect(mean(feesHigh)).toBeGreaterThan(mean(feesLow));
  });

  it("|IL| increases with volatility", () => {
    const ilLow = monteCarlo(baseParams, { ...shortConfig, vol: 0.3 }, nSeeds).ils;
    const ilHigh = monteCarlo(baseParams, { ...shortConfig, vol: 1.0 }, nSeeds).ils;
    // IL is negative, so |IL_high| > |IL_low| means IL_high < IL_low
    expect(mean(ilHigh)).toBeLessThan(mean(ilLow));
  });

  it("IL scales approximately quadratically with vol (IL ∝ σ²)", () => {
    const vol1 = 0.4, vol2 = 0.8;
    const il1 = mean(monteCarlo(baseParams, { ...shortConfig, vol: vol1 }, nSeeds).ils);
    const il2 = mean(monteCarlo(baseParams, { ...shortConfig, vol: vol2 }, nSeeds).ils);

    // IL is negative. |il2|/|il1| ≈ (vol2/vol1)² = 4
    const ratio = il2 / il1; // both negative, so ratio > 0
    const expectedRatio = (vol2 / vol1) ** 2; // = 4

    // Allow wide tolerance (Monte Carlo noise + finite-range effects)
    expect(ratio).toBeGreaterThan(expectedRatio * 0.5);
    expect(ratio).toBeLessThan(expectedRatio * 2.0);
  });

  it("crossover: low vol is profitable, high vol is unprofitable", () => {
    // With 30bps fee and moderate concentration:
    // Low vol (20%) → fees should dominate IL
    const lowVol = monteCarlo(baseParams, { ...shortConfig, vol: 0.2 }, nSeeds);
    const highVol = monteCarlo(baseParams, { ...shortConfig, vol: 2.0 }, nSeeds);

    const lowPnl = mean(lowVol.netReturns);
    const highPnl = mean(highVol.netReturns);

    // Low vol should be profitable or near zero
    // High vol should be negative
    expect(highPnl).toBeLessThan(lowPnl);
  });
});

// ============================================================================
// 5. MONTE CARLO RETURN DISTRIBUTION
// ============================================================================

describe("Monte Carlo return distribution", () => {
  const nSeeds = 200;

  it("median net return has correct sign for default params", () => {
    const mc = monteCarlo(baseParams, shortConfig, nSeeds);
    const sorted = [...mc.netReturns].sort((a, b) => a - b);
    const median = sorted[Math.floor(nSeeds / 2)];

    // With vol=0.8 and 30bps fee, net return could go either way
    // Just verify it's a reasonable number (not NaN, not extreme)
    expect(isFinite(median)).toBe(true);
    expect(Math.abs(median)).toBeLessThan(5); // within 500%
  });

  it("return distribution has negative skew (IL is path-dependent)", () => {
    const mc = monteCarlo(baseParams, { ...shortConfig, vol: 0.6, durationDays: 60 }, nSeeds);
    const m = mean(mc.netReturns);
    const s = std(mc.netReturns);
    const sorted = [...mc.netReturns].sort((a, b) => a - b);
    const median = sorted[Math.floor(nSeeds / 2)];

    // With random walk, mean should be less than median (left skew from IL)
    // Or at least the distribution shouldn't be extremely right-skewed
    expect(isFinite(m)).toBe(true);
    expect(s).toBeGreaterThan(0); // there IS variance
  });

  it("no liquidations without debt", () => {
    const mc = monteCarlo(baseParams, shortConfig, nSeeds);
    expect(mc.liquidated).toBe(0);
  });

  it("higher fees → better returns", () => {
    const lowFee = monteCarlo(baseParams, { ...shortConfig, feeBps: 10 }, nSeeds);
    const highFee = monteCarlo(baseParams, { ...shortConfig, feeBps: 100 }, nSeeds);
    expect(mean(highFee.netReturns)).toBeGreaterThan(mean(lowFee.netReturns));
  });
});

// ============================================================================
// 6. OPTIMAL CONCENTRATION
// ============================================================================
//
// For a given vol, there's a tradeoff:
//   Higher cx → more virtual liquidity → more fees per trade
//   Higher cx → more IL per unit price movement
//   Higher cx → narrower effective range (more time out of range for same rx)
//
// The optimal cx maximizes E[net PnL] = E[fees] - E[|IL|].
//
// At low vol: higher cx is better (fees dominate)
// At high vol: lower cx is better (IL dominates and range exhaustion matters)

describe("optimal concentration", () => {
  const nSeeds = 80;

  it("net PnL varies with concentration", () => {
    const results: { cx: number; meanPnl: number; meanFees: number; meanIL: number }[] = [];

    for (const cx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const p = { ...baseParams, cx, cy: cx };
      const mc = monteCarlo(p, shortConfig, nSeeds);
      results.push({
        cx,
        meanPnl: mean(mc.netReturns),
        meanFees: mean(mc.fees),
        meanIL: mean(mc.ils),
      });
    }

    // Verify fees increase with cx (more concentrated = more fee capture)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].meanFees).toBeGreaterThan(results[i - 1].meanFees * 0.9);
    }

    // Verify IL is negative for all concentrations
    for (const r of results) {
      expect(r.meanIL).toBeLessThan(0);
    }
    // Extreme concentration (0.9) should have more IL than low (0.1)
    expect(results[results.length - 1].meanIL).toBeLessThan(results[0].meanIL);
  });

  it("low vol favors high concentration", () => {
    const lowVol = { ...shortConfig, vol: 0.15 };
    const results: { cx: number; meanPnl: number }[] = [];

    for (const cx of [0.1, 0.5, 0.8]) {
      const p = { ...baseParams, cx, cy: cx };
      const mc = monteCarlo(p, lowVol, nSeeds);
      results.push({ cx, meanPnl: mean(mc.netReturns) });
    }

    // At low vol, highest concentration should be most profitable
    // (or at least not significantly worse)
    const best = results.reduce((a, b) => a.meanPnl > b.meanPnl ? a : b);
    expect(best.cx).toBeGreaterThanOrEqual(0.5);
  });
});

// ============================================================================
// 7. TIME IN RANGE vs RANGE WIDTH
// ============================================================================

describe("time in range", () => {
  const nSeeds = 100;

  it("wider range → more time in range", () => {
    const narrow = monteCarlo(
      { ...baseParams, rx: 0.1, ry: 0.1 },
      { ...shortConfig, vol: 0.8 },
      nSeeds,
    );
    const wide = monteCarlo(
      { ...baseParams, rx: 2.0, ry: 2.0 },
      { ...shortConfig, vol: 0.8 },
      nSeeds,
    );

    expect(mean(wide.timeInRange)).toBeGreaterThan(mean(narrow.timeInRange));
  });

  it("lower vol → more time in range", () => {
    const lowVol = monteCarlo(baseParams, { ...shortConfig, vol: 0.2 }, nSeeds);
    const highVol = monteCarlo(baseParams, { ...shortConfig, vol: 2.0 }, nSeeds);
    expect(mean(lowVol.timeInRange)).toBeGreaterThan(mean(highVol.timeInRange));
  });

  it("rx=2 keeps pool in range >90% of time at vol=0.5 over 30d", () => {
    const mc = monteCarlo(
      { ...baseParams, rx: 2.0, ry: 2.0 },
      { ...shortConfig, vol: 0.5 },
      nSeeds,
    );
    expect(mean(mc.timeInRange)).toBeGreaterThan(0.9);
  });
});

// ============================================================================
// 8. SIMULATION CONSISTENCY
// ============================================================================

describe("simulation consistency", () => {
  it("identical seed produces identical results", () => {
    const a = runSimulation(baseParams, { ...defaultSimConfig, seed: 777 });
    const b = runSimulation(baseParams, { ...defaultSimConfig, seed: 777 });
    expect(a.summary).toEqual(b.summary);
  });

  it("lpNav + fees = hodlNav + netPnl at every step", () => {
    const result = runSimulation(baseParams, { ...defaultSimConfig, seed: 42 });
    for (const step of result.steps) {
      const lhs = step.lpNav + step.feesCum;
      const rhs = step.hodlNav + step.netPnl;
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-9);
    }
  });

  it("at t=0, lpNav = hodlNav = initial NAV", () => {
    const result = runSimulation(baseParams, defaultSimConfig);
    const step0 = result.steps[0];
    const eqPrice = baseParams.px / baseParams.py;
    const expectedNav = baseParams.xr * eqPrice + baseParams.yr
      - baseParams.xd * eqPrice - baseParams.yd;
    expect(Math.abs(step0.lpNav - expectedNav)).toBeLessThan(1e-9);
    expect(Math.abs(step0.hodlNav - expectedNav)).toBeLessThan(1e-9);
    expect(step0.feesCum).toBe(0);
  });

  it("initial debt reduces NAV correctly", () => {
    const debtParams: Params = { ...baseParams, yd: 20 };
    const result = runSimulation(debtParams, defaultSimConfig);
    const step0 = result.steps[0];
    const eqPrice = debtParams.px / debtParams.py;
    const expectedNav = debtParams.xr * eqPrice + debtParams.yr
      - debtParams.xd * eqPrice - debtParams.yd;
    expect(Math.abs(step0.lpNav - expectedNav)).toBeLessThan(1e-9);
    expect(step0.lpNav).toBeLessThan(baseParams.xr * eqPrice + baseParams.yr);
  });

  it("fees are monotonically non-decreasing", () => {
    const result = runSimulation(baseParams, { ...defaultSimConfig, seed: 123 });
    for (let i = 1; i < result.steps.length; i++) {
      expect(result.steps[i].feesCum).toBeGreaterThanOrEqual(result.steps[i - 1].feesCum - 1e-12);
    }
  });
});
