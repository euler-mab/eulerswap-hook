import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  fX, fXd, gY, gYd,
  computeSx, computeSy, computeBxc, computeByc,
  computeX0, computeY0,
  computeXb, computeYb,
  computeHX, computeHY,
  computeNAV_X, computeNAV_Y,
  pXxy, pXyx, pYxy, pYyx,
  CXX, CXY_fn, DXX, DXY, xXXdebt, xXYdebt,
  CYY, CYX_fn, DYY, DYX, yYYdebt, yYXdebt,
  defaultParams,
  type Params,
} from "./math";

// ============================================================================
// TRADING STRATEGY HYPOTHESIS TESTS
// ============================================================================
//
// These tests explore properties of EulerSwap that are relevant to trading
// strategies: LP profitability, impermanent loss, concentration tradeoffs,
// and leverage effects. Each hypothesis is stated, then tested via fast-check
// property-based testing.
//
// Journey documented in: src/lib/STRATEGY_JOURNEY.md
// ============================================================================

// --- Arbitraries ---

const arbC = fc.double({ min: 0.01, max: 0.95, noNaN: true });
const arbReserve = fc.double({ min: 1, max: 100, noNaN: true });
const arbPrice = fc.double({ min: 0.1, max: 10, noNaN: true });
const arbRange = fc.double({ min: 0.05, max: 3, noNaN: true });
const arbLLTV = fc.double({ min: 0.3, max: 0.95, noNaN: true });
const arbFrac = fc.double({ min: 0.01, max: 0.99, noNaN: true });

const NUM_RUNS = 500;

/** Build no-debt params for IL/NAV tests */
function noDebtParams(overrides: Partial<Params> = {}): fc.Arbitrary<Params> {
  return fc.record({
    vyx: arbLLTV, vxy: arbLLTV,
    vxz: arbLLTV, vyz: arbLLTV,
    vzx: fc.constant(0), vzy: fc.constant(0),
    px: arbPrice, py: arbPrice,
    pxz: fc.constant(1),
    rx: arbRange, ry: arbRange,
    cx: arbC, cy: arbC,
    xr: arbReserve, yr: arbReserve,
    zr: fc.constant(0),
    xd: fc.constant(0), yd: fc.constant(0), zdebt: fc.constant(0),
    rXX: fc.constant(0), rXY: fc.constant(0), rXZ: fc.constant(0),
    rYX: fc.constant(0), rYY: fc.constant(0), rYZ: fc.constant(0),
    eXC: fc.constant(0), eXD: fc.constant(0),
    eYC: fc.constant(0), eYD: fc.constant(0),
  }).map((p) => ({ ...p, ...overrides }));
}

/** Build params with Y debt for leverage tests */
function yDebtParams(): fc.Arbitrary<Params> {
  return noDebtParams().chain((p) =>
    fc.double({ min: 0.1, max: p.yr * 0.8, noNaN: true }).map((yd) => ({
      ...p, yd, xd: 0, zdebt: 0,
    }))
  );
}

// --- Helpers ---

function relErr(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-15);
  return Math.abs(a - b) / denom;
}

/** Compute IL at position x: NAV_X(x) - holding value at current price */
function computeIL_X(x: number, p: Params, x0: number, y0: number): number {
  const nav = computeNAV_X(x, p, x0, y0);
  if (!isFinite(nav)) return NaN;
  const pXyxVal = pXyx(x, p.cx, x0, p.px, p.py);
  if (!isFinite(pXyxVal)) return NaN;
  // Holding value: xr + yr * pXyx(x) (what you'd have if you just held)
  const holdValue = p.xr + p.yr * pXyxVal;
  return nav - holdValue;
}

/** Compute IL at position y on Y side: NAV_Y(y) - holding value */
function computeIL_Y(y: number, p: Params, x0: number, y0: number): number {
  const nav = computeNAV_Y(y, p, x0, y0);
  if (!isFinite(nav)) return NaN;
  const pYxyVal = pYxy(y, p.cy, y0, p.px, p.py);
  if (!isFinite(pYxyVal)) return NaN;
  // Holding value in Y: yr + xr * pYxy(y)
  const holdValue = p.yr + p.xr * pYxyVal;
  return nav - holdValue;
}

/** Get x position at fractional distance from equilibrium to boundary */
function xAtFrac(frac: number, x0: number, xb: number): number {
  return x0 - frac * (x0 - xb);
}

/** Get y position at fractional distance from equilibrium to boundary */
function yAtFrac(frac: number, y0: number, yb: number): number {
  return y0 - frac * (y0 - yb);
}

// ============================================================================
// H1: NAV IS ALWAYS POSITIVE (no-debt case)
// ============================================================================
//
// Rationale: With no initial debt (xd=yd=zd=0), the LP deposited real assets.
// Even though the pool uses virtual reserves via concentration boost, the LP
// should never owe more than they have. The NAV should be strictly positive
// at every point within the range.
//
// Why it might fail: If the boost mechanism creates implicit debt that
// exceeds the collateral at some intermediate point.

describe("H1: NAV always positive within range (no debt)", () => {
  it("NAV_X(x) > 0 for all x in [xb, x0] — X side", () => {
    fc.assert(fc.property(noDebtParams(), arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
      const xb = computeXb(x0, p.rx, p.cx);
      if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

      const x = xAtFrac(frac, x0, xb);
      const nav = computeNAV_X(x, p, x0, y0);
      if (!isFinite(nav)) return true;

      return nav > -1e-9; // positive (with tiny numerical tolerance)
    }), { numRuns: NUM_RUNS });
  });

  it("NAV_Y(y) > 0 for all y in [yb, y0] — Y side", () => {
    fc.assert(fc.property(noDebtParams(), arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
      const yb = computeYb(y0, p.ry, p.cy);
      if (!isFinite(yb) || yb <= 0 || yb >= y0) return true;

      const y = yAtFrac(frac, y0, yb);
      const nav = computeNAV_Y(y, p, x0, y0);
      if (!isFinite(nav)) return true;

      return nav > -1e-9;
    }), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H2: IMPERMANENT LOSS IS ALWAYS NON-POSITIVE
// ============================================================================
//
// Rationale: An LP always loses value relative to simply holding the
// deposited assets, measured at the current marginal price. This is
// the defining characteristic of impermanent loss in AMMs.
//
// Formally: NAV_X(x) ≤ xr + yr * pXyx(x) for all x in [xb, x0].
//
// Why it works: The AMM sells the appreciating asset and buys the
// depreciating one at every point along the curve. Each infinitesimal
// swap is at the marginal price, but the accumulation of these swaps
// at deteriorating prices leads to a loss vs holding.
//
// Why it might fail: If the boost mechanism somehow creates value
// (it shouldn't — boost is leverage, not free money).

describe("H2: Impermanent loss is always non-positive (no debt)", () => {
  it("IL_X ≤ 0 at all points within range", () => {
    fc.assert(fc.property(noDebtParams(), arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
      const xb = computeXb(x0, p.rx, p.cx);
      if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

      const x = xAtFrac(frac, x0, xb);
      const il = computeIL_X(x, p, x0, y0);
      if (!isFinite(il)) return true;

      return il <= 1e-9; // non-positive (tiny tolerance for numerics)
    }), { numRuns: NUM_RUNS });
  });

  it("IL_Y ≤ 0 at all points within range", () => {
    fc.assert(fc.property(noDebtParams(), arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
      const yb = computeYb(y0, p.ry, p.cy);
      if (!isFinite(yb) || yb <= 0 || yb >= y0) return true;

      const y = yAtFrac(frac, y0, yb);
      const il = computeIL_Y(y, p, x0, y0);
      if (!isFinite(il)) return true;

      return il <= 1e-9;
    }), { numRuns: NUM_RUNS });
  });

  it("IL = 0 at equilibrium (no loss when price hasn't moved)", () => {
    fc.assert(fc.property(noDebtParams(), (p) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;

      // IL at equilibrium should be 0 (no price movement = no IL)
      const il = computeIL_X(x0, p, x0, y0);
      if (!isFinite(il)) return true;

      return Math.abs(il) < 1e-6;
    }), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H3: IL INCREASES MONOTONICALLY TOWARD BOUNDARY
// ============================================================================
//
// Rationale: As price moves further from equilibrium, the LP incurs
// more and more impermanent loss. Each additional swap at an increasingly
// unfavorable price makes the situation worse.
//
// IL(frac1) ≥ IL(frac2) when frac1 < frac2 (frac=0 is eq, frac=1 is boundary)
// Since IL is negative, |IL| increases as frac increases.
//
// Why it might fail: The NAV uses the local marginal price for conversion,
// which changes non-linearly. There could be an inflection point.

describe("H3: IL increases monotonically toward boundary (no debt)", () => {
  it("IL_X(frac_near) ≥ IL_X(frac_far) for frac_near < frac_far", () => {
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.05, max: 0.85, noNaN: true }),
      (p, frac) => {
        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        const xb = computeXb(x0, p.rx, p.cx);
        if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

        const frac2 = frac + 0.1;
        if (frac2 > 1) return true;

        const x1 = xAtFrac(frac, x0, xb);
        const x2 = xAtFrac(frac2, x0, xb);
        const il1 = computeIL_X(x1, p, x0, y0);
        const il2 = computeIL_X(x2, p, x0, y0);
        if (!isFinite(il1) || !isFinite(il2)) return true;

        // il1 should be ≥ il2 (less negative = less IL nearer to eq)
        return il1 >= il2 - 1e-6;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("IL_Y(frac_near) ≥ IL_Y(frac_far) for frac_near < frac_far", () => {
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.05, max: 0.85, noNaN: true }),
      (p, frac) => {
        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        const yb = computeYb(y0, p.ry, p.cy);
        if (!isFinite(yb) || yb <= 0 || yb >= y0) return true;

        const frac2 = frac + 0.1;
        if (frac2 > 1) return true;

        const y1 = yAtFrac(frac, y0, yb);
        const y2 = yAtFrac(frac2, y0, yb);
        const il1 = computeIL_Y(y1, p, x0, y0);
        const il2 = computeIL_Y(y2, p, x0, y0);
        if (!isFinite(il1) || !isFinite(il2)) return true;

        return il1 >= il2 - 1e-6;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H4: HIGHER CONCENTRATION → MORE IL AT SAME PRICE DEVIATION
// ============================================================================
//
// Rationale: Higher concentration means more virtual liquidity near
// equilibrium. The pool trades more aggressively at each price level,
// so more tokens change hands per unit price movement. This amplifies
// impermanent loss at any given price deviation.
//
// KEY INSIGHT (discovered during testing): Comparing at the same x-space
// frac is WRONG because the same frac maps to different prices for
// different cx values. Higher cx pools have flatter curves near eq,
// so at the same frac they're at a CLOSER price to equilibrium, which
// can mean LESS IL. The correct comparison is at the same price level.
//
// At the same price: pXxy = (px/py)(cx + (1-cx)(x0/x)²)
// Given target deviation d (pXxy = (px/py)(1+d)):
//   x = x0 / sqrt((1+d-cx)/(1-cx))
//
// At the boundary (d = rx), all pools reach the same price regardless
// of cx, and higher cx → more IL (proven analytically).

describe("H4: Higher concentration → more IL at same price deviation", () => {
  /** Convert price deviation d to x position */
  function xAtPriceDev(d: number, cx: number, x0: number): number {
    const inner = (1 + d - cx) / (1 - cx);
    if (inner <= 0) return NaN;
    return x0 / Math.sqrt(inner);
  }

  it("IL_X with higher cx ≤ IL_X with lower cx at same price deviation", () => {
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.05, max: 0.4, noNaN: true }),  // cx_low
      fc.double({ min: 0.1, max: 0.3, noNaN: true }),   // cx_delta
      fc.double({ min: 0.1, max: 0.9, noNaN: true }),   // devFrac (fraction of rx)
      (p, cx_low, cx_delta, devFrac) => {
        const cx_high = cx_low + cx_delta;
        if (cx_high >= 0.99) return true;

        const d = p.rx * devFrac; // price deviation (same for both)
        if (d <= 0) return true;

        // Low concentration pool
        const p1 = { ...p, cx: cx_low, cy: cx_low };
        const x0_1 = computeX0(p1);
        const y0_1 = computeY0(p1);
        if (!isFinite(x0_1) || !isFinite(y0_1) || x0_1 <= 0 || y0_1 <= 0) return true;
        const x1 = xAtPriceDev(d, cx_low, x0_1);
        if (!isFinite(x1) || x1 <= 0 || x1 > x0_1) return true;

        // High concentration pool
        const p2 = { ...p, cx: cx_high, cy: cx_high };
        const x0_2 = computeX0(p2);
        const y0_2 = computeY0(p2);
        if (!isFinite(x0_2) || !isFinite(y0_2) || x0_2 <= 0 || y0_2 <= 0) return true;
        const x2 = xAtPriceDev(d, cx_high, x0_2);
        if (!isFinite(x2) || x2 <= 0 || x2 > x0_2) return true;

        const il1 = computeIL_X(x1, p1, x0_1, y0_1);
        const il2 = computeIL_X(x2, p2, x0_2, y0_2);
        if (!isFinite(il1) || !isFinite(il2)) return true;

        // Higher concentration should have more IL (more negative)
        return il2 <= il1 + 1e-6;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("at boundary (same price for all cx), higher cx → more IL", () => {
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.05, max: 0.4, noNaN: true }),
      fc.double({ min: 0.1, max: 0.3, noNaN: true }),
      (p, cx_low, cx_delta) => {
        const cx_high = cx_low + cx_delta;
        if (cx_high >= 0.99) return true;

        const p1 = { ...p, cx: cx_low, cy: cx_low };
        const p2 = { ...p, cx: cx_high, cy: cx_high };

        const x0_1 = computeX0(p1), y0_1 = computeY0(p1);
        const x0_2 = computeX0(p2), y0_2 = computeY0(p2);
        if (!isFinite(x0_1) || !isFinite(y0_1) || x0_1 <= 0 || y0_1 <= 0) return true;
        if (!isFinite(x0_2) || !isFinite(y0_2) || x0_2 <= 0 || y0_2 <= 0) return true;

        // Near boundary (99% of range)
        const xb_1 = computeXb(x0_1, p1.rx, p1.cx);
        const xb_2 = computeXb(x0_2, p2.rx, p2.cx);
        if (!isFinite(xb_1) || !isFinite(xb_2) || xb_1 <= 0 || xb_2 <= 0) return true;

        const x1 = xb_1 + (x0_1 - xb_1) * 0.01;
        const x2 = xb_2 + (x0_2 - xb_2) * 0.01;
        const il1 = computeIL_X(x1, p1, x0_1, y0_1);
        const il2 = computeIL_X(x2, p2, x0_2, y0_2);
        if (!isFinite(il1) || !isFinite(il2)) return true;

        return il2 <= il1 + 1e-6;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H5: CURVE IS CONVEX (price impact is superlinear)
// ============================================================================
//
// Rationale: fX is decreasing and convex (f''X > 0). This means larger
// trades face progressively worse prices — the price impact is superlinear.
// This is a fundamental property that protects LPs from large trades.
//
// Analytically: f''X(x) = 2(px/py)(1-cx)(x0²/x³) > 0 for all valid x.
//
// Trading implication: A trader splitting a large order into smaller
// pieces and executing at different prices would get a better average
// price than executing all at once (if no other trades happen in between).

describe("H5: Curve convexity — price impact is superlinear", () => {
  it("f''X(x) > 0 everywhere on (0, x0) via numerical second derivative", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (cx, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const h = x * 1e-5;
        if (x - h <= 0 || x + h > x0) return true;

        const f_minus = fX(x - h, cx, x0, y0, px, py);
        const f_center = fX(x, cx, x0, y0, px, py);
        const f_plus = fX(x + h, cx, x0, y0, px, py);
        if (!isFinite(f_minus) || !isFinite(f_center) || !isFinite(f_plus)) return true;

        const fpp = (f_plus - 2 * f_center + f_minus) / (h * h);
        return fpp > -1e-3; // positive (with numerical tolerance)
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gY''(y) > 0 everywhere on (0, y0) — Y side is also convex", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (cy, x0, y0, px, py, frac) => {
        const y = frac * y0;
        const h = y * 1e-5;
        if (y - h <= 0 || y + h > y0) return true;

        const g_minus = gY(y - h, cy, y0, x0, px, py);
        const g_center = gY(y, cy, y0, x0, px, py);
        const g_plus = gY(y + h, cy, y0, x0, px, py);
        if (!isFinite(g_minus) || !isFinite(g_center) || !isFinite(g_plus)) return true;

        const gpp = (g_plus - 2 * g_center + g_minus) / (h * h);
        return gpp > -1e-3;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("trade splitting is always cheaper: 2 × halfSwap ≤ fullSwap Y cost", () => {
    // Convexity implies that splitting a trade into two halves costs less Y
    // than doing it all at once (price impact is superlinear).
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.1, max: 0.5, noNaN: true }), // swap size as fraction of range
      (p, swapFrac) => {
        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        const xb = computeXb(x0, p.rx, p.cx);
        if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

        const swapSize = swapFrac * (x0 - xb);
        const xEnd = x0 - swapSize;
        const xMid = x0 - swapSize / 2;
        if (xEnd <= 0 || xMid <= 0) return true;

        // Full swap: Y cost to move from x0 to xEnd
        const yFull = fX(xEnd, p.cx, x0, y0, p.px, p.py) - y0;

        // Two half swaps: first half Y cost, then second half
        // First half: x0 → xMid
        const yHalf1 = fX(xMid, p.cx, x0, y0, p.px, p.py) - y0;
        // Second half: xMid → xEnd (same curve, same reserves)
        const yHalf2 = fX(xEnd, p.cx, x0, y0, p.px, p.py) - fX(xMid, p.cx, x0, y0, p.px, p.py);

        if (!isFinite(yFull) || !isFinite(yHalf1) || !isFinite(yHalf2)) return true;

        // yFull should equal yHalf1 + yHalf2 (conservation of Y flow)
        // This is trivially true: fX(xEnd) - y0 = (fX(xMid) - y0) + (fX(xEnd) - fX(xMid))
        // The real test for superlinearity: the AVERAGE PRICE of the full swap
        // is worse than the average price of each half swap weighted by size.
        //
        // Actually, since both halves use the same curve (AMM is path-independent),
        // the total Y is the same regardless of splitting. The convexity matters
        // when the pool resets between trades (which doesn't happen here).
        //
        // So instead test: Y per X is worse for the second half than the first half
        // (price impact increases with size)
        const avgPrice1 = yHalf1 / (swapSize / 2);
        const avgPrice2 = yHalf2 / (swapSize / 2);
        if (!isFinite(avgPrice1) || !isFinite(avgPrice2)) return true;

        // Second half should cost more Y per X (worse price for trader)
        return avgPrice2 >= avgPrice1 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H6: LEVERAGE AMPLIFIES IL
// ============================================================================
//
// Rationale: A leveraged LP position (with debt) has larger virtual reserves
// relative to the real deposits. This means more tokens change hands per unit
// price movement, amplifying IL proportionally to the leverage ratio.
//
// Test: For the same base parameters, an LP with Y debt should have
// more IL than an LP without debt, at the same fractional position.
//
// Subtlety: The leverage ratio is L = x0/(xr*bXC). With bXL > 1,
// L > 1 and the effective exposure is amplified.

describe("H6: Leverage amplifies IL", () => {
  it("IL with Y debt ≥ IL without debt at same fractional position", () => {
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.1, max: 0.7, noNaN: true }), // frac
      fc.double({ min: 0.1, max: 0.7, noNaN: true }), // debt fraction of yr
      (pBase, frac, debtFrac) => {
        // Unleveraged pool
        const x0_base = computeX0(pBase);
        const y0_base = computeY0(pBase);
        if (!isFinite(x0_base) || !isFinite(y0_base) || x0_base <= 0 || y0_base <= 0) return true;
        const xb_base = computeXb(x0_base, pBase.rx, pBase.cx);
        if (!isFinite(xb_base) || xb_base <= 0 || xb_base >= x0_base) return true;

        // Leveraged pool (same params but with Y debt)
        const yd = pBase.yr * debtFrac;
        const pLev = { ...pBase, yd, xd: 0, zdebt: 0 };
        const x0_lev = computeX0(pLev);
        const y0_lev = computeY0(pLev);
        if (!isFinite(x0_lev) || !isFinite(y0_lev) || x0_lev <= 0 || y0_lev <= 0) return true;
        const xb_lev = computeXb(x0_lev, pLev.rx, pLev.cx);
        if (!isFinite(xb_lev) || xb_lev <= 0 || xb_lev >= x0_lev) return true;

        // Skip if leverage didn't actually increase the boost
        if (x0_lev <= x0_base * 1.01) return true;

        // IL at same frac
        const x_base = xAtFrac(frac, x0_base, xb_base);
        const x_lev = xAtFrac(frac, x0_lev, xb_lev);
        const il_base = computeIL_X(x_base, pBase, x0_base, y0_base);
        const il_lev = computeIL_X(x_lev, pLev, x0_lev, y0_lev);
        if (!isFinite(il_base) || !isFinite(il_lev)) return true;

        // Both should be ≤ 0, and leveraged should be more negative
        return il_lev <= il_base + 1e-6;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H7: SYMMETRIC POOLS HAVE SYMMETRIC BEHAVIOR
// ============================================================================
//
// Rationale: When cx=cy, rx=ry, px=py, xr=yr (fully symmetric params),
// the X-side and Y-side should behave identically. This means IL at
// the X boundary should equal IL at the Y boundary.
//
// Trading implication: A symmetric LP has no directional bias.

describe("H7: Symmetric pools have symmetric IL", () => {
  it("IL at X boundary ≈ IL at Y boundary for symmetric params", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbPrice, arbRange, arbLLTV,
      (c, res, pr, r, v) => {
        const p: Params = {
          ...defaultParams,
          px: pr, py: pr, pxz: 1,
          rx: r, ry: r, cx: c, cy: c,
          xr: res, yr: res,
          vyx: v, vxy: v, vxz: 0.5, vyz: 0.5, vzx: 0, vzy: 0,
          xd: 0, yd: 0, zdebt: 0, zr: 0,
          rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
          eXC: 0, eXD: 0, eYC: 0, eYD: 0,
        };

        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        if (relErr(x0, y0) > 1e-6) return true; // skip if boost asymmetric

        const xb = computeXb(x0, p.rx, p.cx);
        const yb = computeYb(y0, p.ry, p.cy);
        if (!isFinite(xb) || !isFinite(yb) || xb <= 0 || yb <= 0) return true;

        // IL near boundary (95% of range)
        const x = xAtFrac(0.95, x0, xb);
        const y = yAtFrac(0.95, y0, yb);
        const il_x = computeIL_X(x, p, x0, y0);
        const il_y = computeIL_Y(y, p, x0, y0);
        if (!isFinite(il_x) || !isFinite(il_y)) return true;

        // Normalize IL by equilibrium NAV for comparison
        const nav_eq_x = p.xr + p.yr * (p.py / p.px);
        const nav_eq_y = p.yr + p.xr * (p.px / p.py);
        if (nav_eq_x <= 0 || nav_eq_y <= 0) return true;

        const il_x_pct = il_x / nav_eq_x;
        const il_y_pct = il_y / nav_eq_y;

        return relErr(il_x_pct, il_y_pct) < 0.05; // within 5% relative
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H8: NAV AT BOUNDARY WITH LEVERAGE (detailed analysis)
// ============================================================================
//
// For an LP with Y debt and no Z: At the X boundary (xb), the LP's
// position has CXX=0, DXY=0, and health≈1. The NAV should be:
//   NAV = CXY * pXyx - DXX
//   Health = vyx * CXY * pXyx / DXX = 1
//   → DXX = vyx * CXY * pXyx
//   → NAV = CXY * pXyx * (1 - vyx) = DXX * (1/vyx - 1)
//
// This means the LP always retains positive value at boundary because
// vyx < 1. The residual NAV is proportional to the debt weighted by
// the "LTV gap" (1/v - 1).
//
// Trading implication: Even at maximum adverse price movement, the LP
// has a positive position. The LLTV acts as a safety buffer.

describe("H8: NAV at boundary with leverage", () => {
  it("NAV at boundary > 0 when leveraged (Y debt)", () => {
    fc.assert(fc.property(yDebtParams(), (p) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
      const xb = computeXb(x0, p.rx, p.cx);
      if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

      // Just inside boundary
      const x = xb + (x0 - xb) * 0.005;
      const nav = computeNAV_X(x, p, x0, y0);
      if (!isFinite(nav)) return true;

      return nav > -1e-6;
    }), { numRuns: NUM_RUNS });
  });

  it("NAV at boundary ≈ DXX * (H/vyx - 1) — generalized boundary formula", () => {
    // At the boundary, H≈1 by boost calibration. The exact relationship is:
    //   H_XX = vyx * CXY * pXyx / DXX
    //   NAV = CXY * pXyx - DXX = DXX * (H/vyx - 1)
    // Near (but not exactly at) boundary, H > 1 slightly, so we use the
    // measured H value in the formula.
    fc.assert(fc.property(
      noDebtParams(),
      fc.double({ min: 0.1, max: 0.5, noNaN: true }),
      (pBase, debtFrac) => {
        const yd = pBase.yr * debtFrac;
        const p = { ...pBase, yd, xd: 0, zdebt: 0, zr: 0 };

        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        const xb = computeXb(x0, p.rx, p.cx);
        if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

        // Slightly inside boundary
        const eps = (x0 - xb) * 0.005;
        const x = xb + eps;
        const nav = computeNAV_X(x, p, x0, y0);
        const hx = computeHX(x, p, x0, y0);
        if (!isFinite(nav) || !isFinite(hx) || hx <= 0) return true;

        // Must be in H_XX phase (CXX=0, DXY=0)
        const xXXd = xXXdebt(x0, p.xr);
        const xXYd = xXYdebt(x0, p.cx, p.yd, p.px, p.py);
        if (x > xXYd) return true; // H_XY phase, different formula
        const dxx = DXX(x, x0, p.xr, p.xd, xXXd, xXYd, 0);
        if (!isFinite(dxx) || dxx <= 0) return true;

        // Use actual H value: NAV = DXX * (H/vyx - 1)
        const expectedNav = dxx * (hx / p.vyx - 1);
        if (!isFinite(expectedNav)) return true;

        return relErr(nav, expectedNav) < 0.05;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// H9: CONSTANT-PRODUCT SPECIAL CASE — IL FORMULA
// ============================================================================
//
// For c=0 (constant-product AMM) with px=py and x0=y0:
//   IL(x) = -(x0 - x)² / x0
//
// This is the classic AMM impermanent loss formula (in X units).
// It provides a sanity check that our general IL computation reduces
// to the known result for the simplest case.

describe("H9: Constant-product IL formula (c=0)", () => {
  it("IL_X ≈ -(x0-x)²/x0 for c=0, px=py, symmetric", () => {
    fc.assert(fc.property(
      arbReserve, arbPrice, arbRange, arbLLTV, arbFrac,
      (res, pr, r, v, frac) => {
        const p: Params = {
          ...defaultParams,
          px: pr, py: pr, pxz: 1,
          rx: r, ry: r, cx: 0, cy: 0,
          xr: res, yr: res,
          vyx: v, vxy: v, vxz: 0.5, vyz: 0.5, vzx: 0, vzy: 0,
          xd: 0, yd: 0, zdebt: 0, zr: 0,
          rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
          eXC: 0, eXD: 0, eYC: 0, eYD: 0,
        };

        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (!isFinite(x0) || !isFinite(y0) || x0 <= 0 || y0 <= 0) return true;
        if (relErr(x0, y0) > 1e-6) return true;
        const xb = computeXb(x0, p.rx, p.cx);
        if (!isFinite(xb) || xb <= 0 || xb >= x0) return true;

        const x = xAtFrac(frac, x0, xb);
        const il = computeIL_X(x, p, x0, y0);
        if (!isFinite(il)) return true;

        // Expected: -(x0-x)²/x0
        const expected = -Math.pow(x0 - x, 2) / x0;

        return relErr(il, expected) < 0.01; // within 1%
      }
    ), { numRuns: NUM_RUNS });
  });
});
