/**
 * Tests for the Yield Basis comparison simulation.
 *
 * Verifies:
 *   1. Ideal releverage has IL ≈ 0 (compounding leverage)
 *   2. Discrete releverage has small residual IL (simple leverage)
 *   3. Both releverage strategies earn more fees than static
 *   4. Fee-IL economics at different volatilities
 *   5. Borrowing cost impact
 *   6. Dynamic fee behavior
 *   7. Monte Carlo: ideal consistently beats static on IL
 */
import { describe, it, expect } from "vitest";
import {
  runComparison,
  defaultComparisonConfig,
  type ComparisonConfig,
} from "./yieldBasisSim";
import { defaultParams, type Params } from "./math";

// ─── Helpers ───────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Base params: symmetric, no debt, no LLTVs (so static has no leverage boost). */
const baseParams: Params = {
  ...defaultParams,
  vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
  px: 1, py: 1, pxz: 1,
  rx: 0.5, ry: 0.5, cx: 0.5, cy: 0.5,
  xr: 100, yr: 100,
  xd: 0, yd: 0, zdebt: 0, zr: 0,
  rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
  eXC: 0, eXD: 0, eYC: 0, eYD: 0,
};

const shortConfig: ComparisonConfig = {
  vol: 0.8, drift: 0, durationDays: 30, stepsPerDay: 24,
  feeBps: 30, seed: 42, borrowRateAnnual: 0.05,
  dynamicFee: false, feeMaxBps: 500, feeDecaySeconds: 60,
};

// ============================================================================
// 1. IDEAL RELEVERAGE: IL ≈ 0
// ============================================================================

describe("Ideal releverage IL elimination", () => {
  it("ideal equity tracks HODL-X exactly", () => {
    const result = runComparison(baseParams, shortConfig);
    const final = result.steps[result.steps.length - 1];

    const relError = Math.abs(final.idealEquity - final.hodlX) / final.hodlX;
    expect(relError).toBeLessThan(1e-10);
  });

  it("ideal IL is zero across multiple seeds", () => {
    for (const seed of [1, 42, 100, 999, 54321]) {
      const result = runComparison(baseParams, { ...shortConfig, seed });
      const { idealIL, idealFees } = result.summary;

      const relIL = Math.abs(idealIL) / (baseParams.xr + baseParams.yr);
      expect(relIL).toBeLessThan(1e-10);
      expect(idealFees).toBeGreaterThan(0);
    }
  });

  it("ideal IL is zero for high volatility", () => {
    const result = runComparison(baseParams, { ...shortConfig, vol: 2.0, seed: 77 });
    const relIL = Math.abs(result.summary.idealIL) / (baseParams.xr + baseParams.yr);
    expect(relIL).toBeLessThan(1e-10);
  });

  it("ideal IL is zero for drifting prices", () => {
    const result = runComparison(baseParams, { ...shortConfig, drift: 0.5, seed: 11 });
    const relIL = Math.abs(result.summary.idealIL) / (baseParams.xr + baseParams.yr);
    expect(relIL).toBeLessThan(1e-10);
  });
});

// ============================================================================
// 2. DISCRETE RELEVERAGE: SMALL RESIDUAL IL
// ============================================================================

describe("Discrete releverage residual IL", () => {
  it("discrete IL is much smaller than static cx=0 IL (Monte Carlo)", () => {
    const nSeeds = 50;
    const E0 = baseParams.xr + baseParams.yr; // = 200

    const staticILs: number[] = [];
    const discILs: number[] = [];

    for (let seed = 1; seed <= nSeeds; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed });
      // statics[0] is cx=0
      staticILs.push(res.summary.statics[0].il / E0);
      discILs.push(res.summary.discIL / E0);
    }

    expect(mean(staticILs)).toBeLessThan(0);
    expect(mean(discILs)).toBeLessThan(0);
    expect(Math.abs(mean(discILs))).toBeLessThan(Math.abs(mean(staticILs)) * 0.3);
  });

  it("discrete IL scales with σ²T (residual ≈ σ²T/4)", () => {
    const nSeeds = 50;

    const ilLow: number[] = [];
    const ilHigh: number[] = [];
    for (let seed = 1; seed <= nSeeds; seed++) {
      const resLow = runComparison(baseParams, { ...shortConfig, vol: 0.4, seed });
      const resHigh = runComparison(baseParams, { ...shortConfig, vol: 0.8, seed });
      ilLow.push(resLow.summary.discIL);
      ilHigh.push(resHigh.summary.discIL);
    }

    const meanILLow = mean(ilLow);
    const meanILHigh = mean(ilHigh);

    expect(meanILLow).toBeLessThan(0);
    expect(meanILHigh).toBeLessThan(0);

    const ratio = meanILHigh / meanILLow;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(8);
  });

  it("discrete equity = equity × (2√r − 1) per step", () => {
    const result = runComparison(baseParams, { ...shortConfig, durationDays: 1, stepsPerDay: 1, seed: 42 });

    expect(result.steps).toHaveLength(2);

    const p0 = result.steps[0].extPrice;
    const p1 = result.steps[1].extPrice;
    const r = p1 / p0;
    const sqrtR = Math.sqrt(r);

    const E0 = result.steps[0].discEquity;
    const E1 = result.steps[1].discEquity;

    const expected = E0 * (2 * sqrtR - 1);
    expect(E1).toBeCloseTo(expected, 8);
  });
});

// ============================================================================
// 3. FEE COMPARISON
// ============================================================================

describe("Fee comparison", () => {
  it("releverage earns more fees than static cx=0 (re-centering + L=2)", () => {
    const nSeeds = 50;
    const s0Fees: number[] = [];
    const discFees: number[] = [];
    const idealFees: number[] = [];

    for (let seed = 1; seed <= nSeeds; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed });
      s0Fees.push(res.summary.statics[0].fees);
      discFees.push(res.summary.discFees);
      idealFees.push(res.summary.idealFees);
    }

    expect(mean(discFees)).toBeGreaterThan(mean(s0Fees));
    expect(mean(idealFees)).toBeGreaterThan(mean(s0Fees));
  });

  it("ideal and discrete fees are similar (equity divergence is small)", () => {
    const result = runComparison(baseParams, shortConfig);
    const { discFees, idealFees } = result.summary;

    const ratio = idealFees / discFees;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("fees increase with concentration (smaller rx = higher bXC)", () => {
    const wide = runComparison({ ...baseParams, rx: 1.0, ry: 1.0 }, shortConfig);
    const narrow = runComparison({ ...baseParams, rx: 0.1, ry: 0.1 }, shortConfig);

    expect(narrow.summary.idealFees).toBeGreaterThan(wide.summary.idealFees);
  });
});

// ============================================================================
// 4. BORROWING COST IMPACT
// ============================================================================

describe("Borrowing cost", () => {
  it("debt cost is proportional to borrow rate", () => {
    const low = runComparison(baseParams, { ...shortConfig, borrowRateAnnual: 0.02 });
    const high = runComparison(baseParams, { ...shortConfig, borrowRateAnnual: 0.10 });

    const ratio = high.summary.idealDebtCost / low.summary.idealDebtCost;
    expect(ratio).toBeCloseTo(5.0, 0);
  });

  it("zero borrow rate means ideal total = equity + fees", () => {
    const result = runComparison(baseParams, { ...shortConfig, borrowRateAnnual: 0 });
    const final = result.steps[result.steps.length - 1];

    expect(final.idealDebt).toBe(0);
    expect(final.idealTotal).toBeCloseTo(final.idealEquity + final.idealFees, 8);
  });

  it("high borrow rate can make releverage unprofitable", () => {
    const result = runComparison(baseParams, { ...shortConfig, borrowRateAnnual: 1.0 });

    expect(result.summary.idealDebtCost).toBeGreaterThan(result.summary.idealFees * 0.3);
  });
});

// ============================================================================
// 5. ECONOMIC SCENARIOS
// ============================================================================

describe("Economic scenarios", () => {
  it("three static strategies are present with correct cx values", () => {
    const result = runComparison(baseParams, shortConfig);
    expect(result.summary.statics).toHaveLength(3);
    expect(result.summary.statics[0].cx).toBe(0);
    expect(result.summary.statics[1].cx).toBe(0.5);
    expect(result.summary.statics[2].cx).toBe(0.9);
  });

  it("HODL lines are consistent", () => {
    const result = runComparison(baseParams, shortConfig);

    for (const step of result.steps) {
      const expectedHodl = baseParams.xr * step.extPrice + baseParams.yr;
      expect(step.hodl).toBeCloseTo(expectedHodl, 8);

      const E0 = baseParams.xr * (baseParams.px / baseParams.py) + baseParams.yr;
      const expectedHodlX = E0 * step.extPrice / (baseParams.px / baseParams.py);
      expect(step.hodlX).toBeCloseTo(expectedHodlX, 8);
    }
  });

  it("at t=0 all strategies start equal", () => {
    const result = runComparison(baseParams, shortConfig);
    const step0 = result.steps[0];
    const E0 = baseParams.xr * (baseParams.px / baseParams.py) + baseParams.yr;

    expect(step0.discEquity).toBeCloseTo(E0, 8);
    expect(step0.idealEquity).toBeCloseTo(E0, 8);
    expect(step0.discFees).toBe(0);
    expect(step0.idealFees).toBe(0);
    expect(step0.discDebt).toBe(0);
    expect(step0.idealDebt).toBe(0);
  });

  it("fees are monotonically non-decreasing", () => {
    const result = runComparison(baseParams, shortConfig);
    for (let i = 1; i < result.steps.length; i++) {
      expect(result.steps[i].discFees).toBeGreaterThanOrEqual(result.steps[i - 1].discFees - 1e-12);
      expect(result.steps[i].idealFees).toBeGreaterThanOrEqual(result.steps[i - 1].idealFees - 1e-12);
    }
  });

  it("debt costs are monotonically non-decreasing", () => {
    const result = runComparison(baseParams, shortConfig);
    for (let i = 1; i < result.steps.length; i++) {
      expect(result.steps[i].discDebt).toBeGreaterThanOrEqual(result.steps[i - 1].discDebt - 1e-12);
      expect(result.steps[i].idealDebt).toBeGreaterThanOrEqual(result.steps[i - 1].idealDebt - 1e-12);
    }
  });

  it("higher cx = more IL for static (cx > 0 worsens IL)", () => {
    // cx > 0 makes the curve more constant-sum-like, which increases IL
    const nSeeds = 50;
    const il0: number[] = [];
    const il90: number[] = [];
    for (let seed = 1; seed <= nSeeds; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed });
      il0.push(res.summary.statics[0].il);
      il90.push(res.summary.statics[2].il);
    }
    // cx=0.9 should have worse (more negative) IL than cx=0
    expect(mean(il90)).toBeLessThan(mean(il0));
  });
});

// ============================================================================
// 6. DYNAMIC FEE
// ============================================================================

describe("Dynamic fee", () => {
  it("dynamic fee increases revenue at high step frequency", () => {
    const highFreqConfig: ComparisonConfig = {
      ...shortConfig,
      stepsPerDay: 7200,
      durationDays: 1,
      seed: 42,
    };
    const flat = runComparison(baseParams, { ...highFreqConfig, dynamicFee: false });
    const dynamic = runComparison(baseParams, {
      ...highFreqConfig, dynamicFee: true, feeMaxBps: 500, feeDecaySeconds: 60,
    });

    expect(dynamic.summary.idealFees).toBeGreaterThan(flat.summary.idealFees * 2);
    expect(dynamic.summary.discFees).toBeGreaterThan(flat.summary.discFees * 2);
  });

  it("dynamic fee has no effect when elapsed >> τ", () => {
    const flat = runComparison(baseParams, { ...shortConfig, dynamicFee: false });
    const dynamic = runComparison(baseParams, {
      ...shortConfig, dynamicFee: true, feeMaxBps: 500, feeDecaySeconds: 60,
    });

    expect(dynamic.summary.idealFees).toBeCloseTo(flat.summary.idealFees, 8);
    expect(dynamic.summary.discFees).toBeCloseTo(flat.summary.discFees, 8);
  });

  it("dynamic fee does not affect static strategies", () => {
    const flat = runComparison(baseParams, { ...shortConfig, dynamicFee: false });
    const dynamic = runComparison(baseParams, {
      ...shortConfig, dynamicFee: true, feeMaxBps: 500, feeDecaySeconds: 60,
    });

    for (let i = 0; i < 3; i++) {
      expect(dynamic.summary.statics[i].fees).toBeCloseTo(flat.summary.statics[i].fees, 8);
      expect(dynamic.summary.statics[i].il).toBeCloseTo(flat.summary.statics[i].il, 8);
    }
  });

  it("dynamic fee does not change IL (only affects fee revenue)", () => {
    const highFreqConfig: ComparisonConfig = {
      ...shortConfig,
      stepsPerDay: 7200,
      durationDays: 1,
      seed: 42,
    };
    const flat = runComparison(baseParams, { ...highFreqConfig, dynamicFee: false });
    const dynamic = runComparison(baseParams, {
      ...highFreqConfig, dynamicFee: true, feeMaxBps: 500, feeDecaySeconds: 60,
    });

    expect(dynamic.summary.idealIL).toBeCloseTo(flat.summary.idealIL, 10);
    expect(dynamic.summary.discIL).toBeCloseTo(flat.summary.discIL, 10);
    expect(dynamic.summary.idealDebtCost).toBeCloseTo(flat.summary.idealDebtCost, 10);
    expect(dynamic.summary.discDebtCost).toBeCloseTo(flat.summary.discDebtCost, 10);
  });
});

// ============================================================================
// 7. MONTE CARLO: IDEAL vs STATIC
// ============================================================================

describe("Monte Carlo comparison", () => {
  it("ideal IL is always ~0 across 100 seeds", () => {
    const ils: number[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed });
      ils.push(res.summary.idealIL);
    }

    for (const il of ils) {
      expect(Math.abs(il)).toBeLessThan(1e-6);
    }
  });

  it("static cx=0 IL is consistently negative across seeds", () => {
    const ils: number[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed });
      ils.push(res.summary.statics[0].il);
    }

    const negCount = ils.filter(il => il < 0).length;
    expect(negCount).toBeGreaterThan(80);
  });

  it("ideal has better net economics than static cx=0 (zero borrow)", () => {
    const staticNets: number[] = [];
    const idealNets: number[] = [];

    for (let seed = 1; seed <= 100; seed++) {
      const res = runComparison(baseParams, { ...shortConfig, seed, borrowRateAnnual: 0 });
      staticNets.push(res.summary.statics[0].fees + res.summary.statics[0].il);
      idealNets.push(res.summary.idealFees + res.summary.idealIL);
    }

    expect(mean(idealNets)).toBeGreaterThan(mean(staticNets));
  });
});
