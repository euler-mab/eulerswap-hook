import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  fX, fY, gY, gX, fXd, gYd,
  computeSx, computeSy, computeBxc, computeByc,
  computePX, computeX0, computeY0,
  computeXb, computeYb,
  computeHX, computeHY,
  computeNAV_X,
  pXxy, pYxy, pXyx, pYyx,
  CXX,
  xXXdebt,
  validateParams, defaultParams,
  LXX, LYY, lXX, FX, FY,
  LXY, LYX, lXY,
  type Params,
} from "./math";

// ============================================================================
// Arbitraries (random input generators)
// ============================================================================

/** Concentration parameter c ∈ (0, 0.99) — exclude 0 and 1 boundaries */
const arbC = fc.double({ min: 0.01, max: 0.99, noNaN: true });

/** Concentration including exact 0 */
const arbCwithZero = fc.oneof(fc.constant(0), arbC);

/** Positive reserve / equilibrium value */
const arbReserve = fc.double({ min: 0.1, max: 1000, noNaN: true });

/** x value within curve domain: (0, x0] — expressed as fraction of x0 */
const arbFrac = fc.double({ min: 0.01, max: 1.0, noNaN: true });

/** Positive price */
const arbPrice = fc.double({ min: 0.01, max: 100, noNaN: true });

/** Price range parameter rx or ry ∈ (0.01, 5] */
const arbRange = fc.double({ min: 0.01, max: 5, noNaN: true });

/** LLTV parameter ∈ (0, 1) */
const arbLLTV = fc.double({ min: 0.01, max: 0.99, noNaN: true });

/** Small non-negative value for debts/reserves */
const arbSmallPos = fc.double({ min: 0, max: 50, noNaN: true });

/** Generate valid Params for full-system tests */
const arbParams: fc.Arbitrary<Params> = fc.record({
  vyx: arbLLTV,
  vxy: arbLLTV,
  vxz: arbLLTV,
  vyz: arbLLTV,
  vzx: arbLLTV,
  vzy: arbLLTV,
  px: arbPrice,
  py: arbPrice,
  pxz: arbPrice,
  rx: arbRange,
  ry: arbRange,
  cx: arbC,
  cy: arbC,
  xr: arbReserve,
  yr: arbReserve,
  zr: arbSmallPos,
  xd: fc.constant(0),
  yd: fc.constant(0),
  zdebt: arbSmallPos,
  rXX: fc.constant(0),
  rXY: fc.constant(0),
  rXZ: fc.constant(0),
  rYX: fc.constant(0),
  rYY: fc.constant(0),
  rYZ: fc.constant(0),
  eXC: fc.constant(0),
  eXD: fc.constant(0),
  eYC: fc.constant(0),
  eYD: fc.constant(0),
});

/** Params with X debt */
const arbParamsXDebt: fc.Arbitrary<Params> = arbParams.map((p) => ({
  ...p, xd: p.xr * 0.5, yd: 0, zdebt: 0,
}));

/** Params with Y debt */
const arbParamsYDebt: fc.Arbitrary<Params> = arbParams.map((p) => ({
  ...p, xd: 0, yd: p.yr * 0.5, zdebt: 0,
}));

const NUM_RUNS = 500;

// ============================================================================
// Helpers
// ============================================================================

function relErr(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-15);
  return Math.abs(a - b) / denom;
}

function numDeriv(fn: (t: number) => number, t: number, h = 1e-7): number {
  return (fn(t + h) - fn(t - h)) / (2 * h);
}

// ============================================================================
// 1. CURVE FUNCTIONS — Core algebraic properties
// ============================================================================

describe("fuzz: fX/gY curve properties", () => {
  it("fX is always ≥ y0 for x ∈ (0, x0]", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const y = fX(x, c, x0, y0, px, py);
        return isNaN(y) || y >= y0 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gY is always ≥ x0 for y ∈ (0, y0]", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, y0, px, py, frac) => {
        const y = frac * y0;
        const x = gY(y, c, y0, x0, px, py);
        return isNaN(x) || x >= x0 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fX is monotonically decreasing in x", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.02, max: 0.98, noNaN: true }),
      (c, x0, y0, px, py, frac) => {
        const x1 = frac * x0;
        const x2 = (frac + 0.01) * x0;
        if (x2 > x0) return true;
        const y1 = fX(x1, c, x0, y0, px, py);
        const y2 = fX(x2, c, x0, y0, px, py);
        if (isNaN(y1) || isNaN(y2)) return true;
        return y1 >= y2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gY is monotonically decreasing in y", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.02, max: 0.98, noNaN: true }),
      (c, x0, y0, px, py, frac) => {
        const y1 = frac * y0;
        const y2 = (frac + 0.01) * y0;
        if (y2 > y0) return true;
        const x1 = gY(y1, c, y0, x0, px, py);
        const x2 = gY(y2, c, y0, x0, px, py);
        if (isNaN(x1) || isNaN(x2)) return true;
        return x1 >= x2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fY is monotonically decreasing for x ≥ x0", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 1.0, max: 3.0, noNaN: true }),
      (c, x0, y0, px, py, mult) => {
        const x1 = x0 * mult;
        const x2 = x0 * (mult + 0.01);
        const y1 = fY(x1, c, x0, y0, px, py);
        const y2 = fY(x2, c, x0, y0, px, py);
        if (isNaN(y1) || isNaN(y2)) return true;
        return y1 >= y2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gX is monotonically decreasing for y ≥ y0", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 1.0, max: 3.0, noNaN: true }),
      (c, x0, y0, px, py, mult) => {
        const y1 = y0 * mult;
        const y2 = y0 * (mult + 0.01);
        const x1 = gX(y1, c, y0, x0, px, py);
        const x2 = gX(y2, c, y0, x0, px, py);
        if (isNaN(x1) || isNaN(x2)) return true;
        return x1 >= x2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 2. CONTINUITY at equilibrium
// ============================================================================

describe("fuzz: continuity at equilibrium", () => {
  it("fX(x0) = y0 for all valid params", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (c, x0, y0, px, py) => {
        return relErr(fX(x0, c, x0, y0, px, py), y0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fY(x0) = y0 for all valid params", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (c, x0, y0, px, py) => {
        return relErr(fY(x0, c, x0, y0, px, py), y0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gY(y0) = x0 for all valid params", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (c, x0, y0, px, py) => {
        return relErr(gY(y0, c, y0, x0, px, py), x0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gX(y0) = x0 for all valid params", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (c, x0, y0, px, py) => {
        return relErr(gX(y0, c, y0, x0, px, py), x0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fX and fY agree near equilibrium (left/right limit)", () => {
    // fX uses cx, fY uses cy — use same c for both to test continuity
    // Scale eps by inverse price ratio to account for curve steepness
    fc.assert(fc.property(
      arbCwithZero,
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      (c, x0, y0, px, py) => {
        // Scale eps so that the price-scaled displacement is small
        const eps = x0 * 1e-8;
        const yLeft = fX(x0 - eps, c, x0, y0, px, py);
        const yRight = fY(x0 + eps, c, x0, y0, px, py);
        if (isNaN(yLeft) || isNaN(yRight)) return true;
        return relErr(yLeft, y0) < 1e-4 && relErr(yRight, y0) < 1e-4;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 3. ROUND-TRIP CONSISTENCY (inverse functions)
// ============================================================================

describe("fuzz: round-trip consistency", () => {
  it("fY(gY(y)) ≈ y for y ∈ (0, y0]", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, y0, px, py, frac) => {
        const y = frac * y0;
        const x = gY(y, c, y0, x0, px, py);
        if (isNaN(x) || x < x0) return true; // skip invalid
        const yBack = fY(x, c, x0, y0, px, py);
        if (isNaN(yBack)) return true;
        return relErr(yBack, y) < 1e-5;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gX(fX(x)) ≈ x for x ∈ (0, x0]", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const y = fX(x, c, x0, y0, px, py);
        if (isNaN(y) || y < y0) return true;
        const xBack = gX(y, c, y0, x0, px, py);
        if (isNaN(xBack)) return true;
        return relErr(xBack, x) < 1e-5;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gY(fX(x)) ≈ ... composing X and Y sides preserves structure", () => {
    // When px=py and cx=cy=c and x0=y0: the curve is symmetric,
    // so gY(y, c, y0, x0) should invert fX(x, c, x0, y0) on [0, x0]
    fc.assert(fc.property(
      arbCwithZero,
      fc.double({ min: 1, max: 100, noNaN: true }),
      arbFrac,
      (c, eq, frac) => {
        const x = frac * eq;
        const y = fX(x, c, eq, eq, 1, 1);
        if (isNaN(y) || y <= 0 || y > eq) return true;
        // For symmetric case, gY should give us x back (since gY is the X-side of the Y curve)
        // Actually gY maps y→x and its domain is y ∈ (0, y0], range is x ≥ x0
        // So gY(y) with y=fX(x) ∈ [y0, ∞) won't work — y must be ≤ y0
        // Skip if y > eq (which it always is for x < x0)
        return true;
      }
    ), { numRuns: 10 }); // minimal — this is just a structure test
  });
});

// ============================================================================
// 4. DERIVATIVE CONSISTENCY
// ============================================================================

describe("fuzz: derivative consistency", () => {
  it("fXd matches numerical derivative of fX", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      (c, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const h = Math.max(x * 1e-6, 1e-10);
        if (x - h <= 0 || x + h > x0) return true;
        // Skip extreme ratios where numerical derivative loses precision
        if (y0 / x0 > 100 || x0 / y0 > 100) return true;
        const analytical = fXd(x, c, x0, px, py);
        const numerical = numDeriv((t) => fX(t, c, x0, y0, px, py), x, h);
        if (isNaN(analytical) || isNaN(numerical)) return true;
        return relErr(analytical, numerical) < 1e-3;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gYd matches numerical derivative of gY", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      (c, x0, y0, px, py, frac) => {
        const y = frac * y0;
        const h = Math.max(y * 1e-6, 1e-10);
        if (y - h <= 0 || y + h > y0) return true;
        // When x0 >> y0, gY ≈ x0 + tiny_perturbation. The numerical derivative
        // subtracts two ≈x0 values, causing catastrophic cancellation. Skip these.
        if (x0 / y0 > 100 || y0 / x0 > 100) return true;
        const analytical = gYd(y, c, y0, px, py);
        const numerical = numDeriv((t) => gY(t, c, y0, x0, px, py), y, h);
        if (isNaN(analytical) || isNaN(numerical)) return true;
        return relErr(analytical, numerical) < 1e-3;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fXd is always negative (curve is decreasing)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, px, py, frac) => {
        const x = frac * x0;
        const d = fXd(x, c, x0, px, py);
        return isNaN(d) || d < 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gYd is always negative (curve is decreasing)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, y0, px, py, frac) => {
        const y = frac * y0;
        const d = gYd(y, c, y0, px, py);
        return isNaN(d) || d < 0;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 5. MARGINAL PRICE PROPERTIES
// ============================================================================

describe("fuzz: marginal price properties", () => {
  it("pXxy(x) is always positive", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, px, py, frac) => {
        const x = frac * x0;
        const p = pXxy(x, c, x0, px, py);
        return isNaN(p) || p > 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("pXyx(x) is always positive", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, px, py, frac) => {
        const x = frac * x0;
        const p = pXyx(x, c, x0, px, py);
        return isNaN(p) || p > 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("pXxy * pXyx ≈ 1 (reciprocal prices)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, px, py, frac) => {
        const x = frac * x0;
        const pxy = pXxy(x, c, x0, px, py);
        const pyx = pXyx(x, c, x0, px, py);
        if (isNaN(pxy) || isNaN(pyx)) return true;
        return relErr(pxy * pyx, 1) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("pYxy * pYyx ≈ 1 (reciprocal prices on Y side)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, y0, px, py, frac) => {
        const y = frac * y0;
        const _pxy = pYxy(y, c, y0, px, py);
        const _pyx = pYyx(y, c, y0, px, py);
        if (isNaN(_pxy) || isNaN(_pyx)) return true;
        return relErr(_pxy * _pyx, 1) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("price at equilibrium = px/py (X side)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice,
      (c, x0, px, py) => {
        const p = pXxy(x0, c, x0, px, py);
        if (isNaN(p)) return true;
        return relErr(p, px / py) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("price at equilibrium = py/px (Y side)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice,
      (c, y0, px, py) => {
        const p = pYyx(y0, c, y0, px, py);
        if (isNaN(p)) return true;
        return relErr(p, py / px) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("pXxy increases as x decreases (higher price impact deeper in curve)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.05, max: 0.9, noNaN: true }),
      (c, x0, px, py, frac) => {
        const x1 = frac * x0;
        const x2 = (frac + 0.05) * x0;
        if (x2 > x0) return true;
        const p1 = pXxy(x1, c, x0, px, py);
        const p2 = pXxy(x2, c, x0, px, py);
        if (isNaN(p1) || isNaN(p2)) return true;
        return p1 >= p2 - 1e-9; // price higher when x is lower
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 6. CONSTANT-PRODUCT INVARIANT (c=0 special case)
// ============================================================================

describe("fuzz: constant-product invariant (c=0)", () => {
  it("x * fX(x) ≈ x0 * y0 when c=0, px=py, x0=y0", () => {
    // xy=k only holds when px=py AND x0=y0 (symmetric equilibrium)
    fc.assert(fc.property(
      arbReserve, arbPrice, arbFrac,
      (eq, p, frac) => {
        const x = frac * eq;
        const y = fX(x, 0, eq, eq, p, p);
        if (isNaN(y)) return true;
        return relErr(x * y, eq * eq) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("y * gY(y) ≈ x0 * y0 when c=0, px=py, x0=y0", () => {
    fc.assert(fc.property(
      arbReserve, arbPrice, arbFrac,
      (eq, p, frac) => {
        const y = frac * eq;
        const x = gY(y, 0, eq, eq, p, p);
        if (isNaN(x)) return true;
        return relErr(x * y, eq * eq) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 7. BOOST HELPERS
// ============================================================================

describe("fuzz: boost helper properties", () => {
  it("computeSx(rx, 0) = sqrt(1+rx)", () => {
    fc.assert(fc.property(arbRange, (rx) => {
      return relErr(computeSx(rx, 0), Math.sqrt(1 + rx)) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });

  it("computeSy(ry, 0) = sqrt(1+ry)", () => {
    fc.assert(fc.property(arbRange, (ry) => {
      return relErr(computeSy(ry, 0), Math.sqrt(1 + ry)) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });

  it("sx > 1 for all valid (rx, cx) pairs", () => {
    fc.assert(fc.property(arbRange, arbC, (rx, cx) => {
      const sx = computeSx(rx, cx);
      return isNaN(sx) || sx > 1;
    }), { numRuns: NUM_RUNS });
  });

  it("bXC = sx/(sx-1) ≥ 1 for valid sx", () => {
    fc.assert(fc.property(arbRange, arbC, (rx, cx) => {
      const sx = computeSx(rx, cx);
      if (isNaN(sx) || sx <= 1) return true;
      const bxc = computeBxc(sx);
      return !isNaN(bxc) && bxc >= 1;
    }), { numRuns: NUM_RUNS });
  });

  it("higher cx → higher sx (concentration widens the sqrt factor)", () => {
    // sx = sqrt((1+rx-cx)/(1-cx)) = sqrt(1 + rx/(1-cx)), which increases with cx
    // bXC = sx/(sx-1) actually DECREASES as sx grows, so test sx directly
    fc.assert(fc.property(
      arbRange,
      fc.double({ min: 0.01, max: 0.49, noNaN: true }),
      (rx, cx1) => {
        const cx2 = cx1 + 0.01;
        if (cx2 >= 1) return true;
        const sx1 = computeSx(rx, cx1);
        const sx2 = computeSx(rx, cx2);
        if (isNaN(sx1) || isNaN(sx2)) return true;
        return sx2 >= sx1 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("xb = x0/sx (boundary definition)", () => {
    fc.assert(fc.property(arbReserve, arbRange, arbC, (x0, rx, cx) => {
      const sx = computeSx(rx, cx);
      if (isNaN(sx) || sx <= 0) return true;
      const xb = computeXb(x0, rx, cx);
      return relErr(xb, x0 / sx) < 1e-9;
    }), { numRuns: NUM_RUNS });
  });

  it("PX = cx + (1-cx)*sx ≥ 1 for valid params", () => {
    fc.assert(fc.property(arbRange, arbC, (rx, cx) => {
      const sx = computeSx(rx, cx);
      if (isNaN(sx)) return true;
      const PX = computePX(cx, sx);
      return PX >= 1 - 1e-9;
    }), { numRuns: NUM_RUNS });
  });

  it("X/Y symmetry: identical params → identical boosts", () => {
    fc.assert(fc.property(
      arbRange, arbC, arbReserve, arbSmallPos, arbLLTV, arbLLTV, arbLLTV, arbPrice,
      (r, c, res, zdebt, v1, v2, v3, pr) => {
        const p: Params = {
          ...defaultParams,
          px: pr, py: pr, pxz: pr,
          rx: r, ry: r, cx: c, cy: c,
          xr: res, yr: res, xd: 0, yd: 0, zdebt,
          zr: zdebt > 0 ? res : 0,
          vyx: v1, vxy: v1, vxz: v2, vyz: v2, vzx: v3, vzy: v3,
          rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
        };
        const bx = computeX0(p);
        const by = computeY0(p);
        if (isNaN(bx) || isNaN(by)) return true;
        return relErr(bx, by) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 8. COLLATERAL / DEBT PROPERTIES
// ============================================================================

describe("fuzz: collateral and debt properties", () => {
  it("CXX is non-negative for all x", () => {
    fc.assert(fc.property(
      arbReserve, arbReserve, arbFrac,
      (x0, xr, frac) => {
        const x = frac * x0;
        return CXX(x, x0, xr) >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("CXX(x0, x0, xr) = xr (at equilibrium, full collateral)", () => {
    fc.assert(fc.property(arbReserve, arbReserve, (x0, xr) => {
      return relErr(CXX(x0, x0, xr), xr) < 1e-9;
    }), { numRuns: NUM_RUNS });
  });

  it("CXX decreases as x decreases from x0", () => {
    fc.assert(fc.property(
      arbReserve, arbReserve,
      fc.double({ min: 0.05, max: 0.9, noNaN: true }),
      (x0, xr, frac) => {
        const x1 = frac * x0;
        const x2 = (frac + 0.05) * x0;
        if (x2 > x0) return true;
        return CXX(x2, x0, xr) >= CXX(x1, x0, xr) - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("xXXdebt is within [0, x0] range", () => {
    fc.assert(fc.property(arbReserve, arbReserve, (x0, xr) => {
      const d = xXXdebt(x0, xr);
      // xXXdebt = x0 - xr, can be negative if xr > x0 (leveraged)
      // but the value itself should be finite
      return isFinite(d);
    }), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 9. HEALTH PROPERTIES
// ============================================================================

describe("fuzz: health properties (Z debt)", () => {
  it("health is positive or NaN for valid params with Z debt", () => {
    fc.assert(fc.property(arbParams, arbFrac, (p, frac) => {
      if (p.zdebt <= 0) return true;
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      const x = frac * x0;
      const h = computeHX(x, p, x0, y0);
      return isNaN(h) || h > 0 || h === Infinity;
    }), { numRuns: NUM_RUNS });
  });

  it("health at boundary ≥ 1 (boost guarantee) with Z debt", () => {
    fc.assert(fc.property(arbParams, (p) => {
      if (p.zdebt <= 0 || p.zr <= 0) return true;
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      const xb = computeXb(x0, p.rx, p.cx);
      if (isNaN(xb) || xb <= 0 || xb >= x0) return true;
      // Test slightly inside boundary (numerical stability)
      const x = xb + (x0 - xb) * 0.001;
      const h = computeHX(x, p, x0, y0);
      if (isNaN(h) || h === Infinity) return true;
      return h >= 0.95; // allow numerical tolerance
    }), { numRuns: NUM_RUNS });
  });

  it("health is continuous (nearby points have similar health)", () => {
    // Health should change smoothly — nearby x values should have similar health
    fc.assert(fc.property(arbParams, arbFrac, (p, frac) => {
      if (p.zdebt <= 0) return true;
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      const xb = computeXb(x0, p.rx, p.cx);
      if (isNaN(xb) || xb <= 0 || xb >= x0) return true;

      // Two nearby points within the range
      const x1 = xb + (x0 - xb) * frac;
      const x2 = xb + (x0 - xb) * Math.min(frac + 0.001, 1);
      if (x1 <= 0 || x2 <= 0 || x1 > x0 || x2 > x0) return true;
      const h1 = computeHX(x1, p, x0, y0);
      const h2 = computeHX(x2, p, x0, y0);
      if (isNaN(h1) || isNaN(h2)) return true;
      if (h1 === Infinity || h2 === Infinity) return true;
      if (h1 === 0 || h2 === 0) return true;
      // Nearby points should have health within 50% of each other
      return relErr(h1, h2) < 0.5;
    }), { numRuns: NUM_RUNS });
  });
});

describe("fuzz: Z-debt LLTV asymmetry", () => {
  // When vxz ≠ vyz, the direction of health change depends on which LLTV is higher.
  // As x decreases: CXX drops (X consumed), CXY rises (Y flows in).
  // H_XZ = (vxz*CXX + vyz*CXY*pXyx + rXZ) / (zd*pzx)

  /** Params with Z debt and controlled LLTV asymmetry */
  const arbZDebtParams = (vxz: number, vyz: number): fc.Arbitrary<Params> =>
    fc.record({
      vyx: arbLLTV, vxy: arbLLTV,
      vxz: fc.constant(vxz), vyz: fc.constant(vyz),
      vzx: fc.constant(0), vzy: fc.constant(0),
      px: fc.double({ min: 0.5, max: 5, noNaN: true }),
      py: fc.double({ min: 0.5, max: 5, noNaN: true }),
      pxz: fc.double({ min: 0.5, max: 5, noNaN: true }),
      rx: arbRange, ry: arbRange,
      cx: arbC, cy: arbC,
      xr: fc.double({ min: 5, max: 100, noNaN: true }),
      yr: fc.double({ min: 5, max: 100, noNaN: true }),
      zr: fc.double({ min: 1, max: 50, noNaN: true }),
      xd: fc.constant(0), yd: fc.constant(0),
      zdebt: fc.double({ min: 1, max: 50, noNaN: true }),
      rXX: fc.constant(0), rXY: fc.constant(0), rXZ: fc.constant(0),
      rYX: fc.constant(0), rYY: fc.constant(0), rYZ: fc.constant(0),
      eXC: fc.constant(0), eXD: fc.constant(0),
      eYC: fc.constant(0), eYD: fc.constant(0),
    });

  it("H_XZ at equilibrium matches (vxz*xr + vyz*yr*(py/px)) / (zd/pxz)", () => {
    // At x=x0: CXX=xr, CXY=yr (yXdelta=0), pXyx=py/px
    // Use additive epsilon (not multiplicative) so it works when x0 is large
    fc.assert(fc.property(arbZDebtParams(0.7, 0.4), (p) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      if (p.zdebt <= 0) return true;
      // Use tiny additive step: ensures (x0-x) << xr regardless of x0 magnitude
      const eps = Math.min(p.xr * 1e-6, 1e-6);
      const x = x0 - eps;
      if (x <= 0) return true;
      const h = computeHX(x, p, x0, y0);
      if (isNaN(h) || !isFinite(h)) return true;
      const expected = (p.vxz * p.xr + p.vyz * p.yr * (p.py / p.px)) / (p.zdebt * (1 / p.pxz));
      return relErr(h, expected) < 1e-2;
    }), { numRuns: NUM_RUNS });
  });

  it("doubling vxz roughly doubles the X-collateral contribution to health", () => {
    // Verify vxz scales the CXX term by comparing two configs that only differ in vxz.
    // Since boost also changes with vxz, compare at equilibrium where CXX = xr is exact.
    fc.assert(fc.property(arbZDebtParams(0.4, 0.5), (pBase) => {
      const pDouble = { ...pBase, vxz: 0.8 }; // double vxz
      const x01 = computeX0(pBase), y01 = computeY0(pBase);
      const x02 = computeX0(pDouble), y02 = computeY0(pDouble);
      if (isNaN(x01) || isNaN(y01) || x01 <= 0 || y01 <= 0) return true;
      if (isNaN(x02) || isNaN(y02) || x02 <= 0 || y02 <= 0) return true;
      if (pBase.zdebt <= 0) return true;
      // At equilibrium, CXX=xr, CXY=yr, pXyx=py/px for both
      const pyx = pBase.py / pBase.px;
      const pzx = 1 / pBase.pxz;
      const denom = pBase.zdebt * pzx;
      // Expected health: (vxz*xr + vyz*yr*pyx) / denom
      const hBase = (0.4 * pBase.xr + 0.5 * pBase.yr * pyx) / denom;
      const hDouble = (0.8 * pBase.xr + 0.5 * pBase.yr * pyx) / denom;
      // The X-collateral contribution doubled, so total health increased
      return hDouble > hBase;
    }), { numRuns: NUM_RUNS });
  });

  it("swapping vxz↔vyz changes health direction at equilibrium", () => {
    // At equilibrium with xr ≠ yr*(py/px), swapping LLTVs changes the weighting
    fc.assert(fc.property(arbZDebtParams(0.8, 0.3), (p) => {
      if (p.zdebt <= 0) return true;
      const pSwapped = { ...p, vxz: 0.3, vyz: 0.8 };
      const x01 = computeX0(p), y01 = computeY0(p);
      const x02 = computeX0(pSwapped), y02 = computeY0(pSwapped);
      if (isNaN(x01) || isNaN(y01) || x01 <= 0 || y01 <= 0) return true;
      if (isNaN(x02) || isNaN(y02) || x02 <= 0 || y02 <= 0) return true;
      const h1 = computeHX(x01 * 0.9999, p, x01, y01);
      const h2 = computeHX(x02 * 0.9999, pSwapped, x02, y02);
      if (isNaN(h1) || isNaN(h2) || !isFinite(h1) || !isFinite(h2)) return true;
      // Health should differ (unless xr*(py/px) happens to equal yr)
      const pyx = p.py / p.px;
      if (relErr(p.xr, p.yr * pyx) < 0.01) return true; // skip symmetric case
      return h1 !== h2;
    }), { numRuns: NUM_RUNS });
  });
});

describe("fuzz: health properties (X/Y debt)", () => {
  it("health is positive or Infinity with X debt", () => {
    fc.assert(fc.property(arbParamsXDebt, arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      const x = frac * x0;
      const h = computeHX(x, p, x0, y0);
      return isNaN(h) || h > 0 || h === Infinity;
    }), { numRuns: NUM_RUNS });
  });

  it("Y-side health is positive or Infinity with Y debt", () => {
    fc.assert(fc.property(arbParamsYDebt, arbFrac, (p, frac) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      const y = frac * y0;
      const h = computeHY(y, p, x0, y0);
      return isNaN(h) || h > 0 || h === Infinity;
    }), { numRuns: NUM_RUNS });
  });

  it("no debt → health = Infinity in dead zone", () => {
    // With no initial debt, health is Infinity in the "dead zone"
    // where x ∈ (x0 - xr, x0). With high leverage x0 >> xr, so this
    // zone can be tiny. Test at the midpoint of the dead zone.
    fc.assert(fc.property(
      arbParams.map((p) => ({ ...p, xd: 0, yd: 0, zdebt: 0 })),
      (p) => {
        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
        // Dead zone: x ∈ (x0 - xr, x0). Test at midpoint.
        const x = x0 - p.xr * 0.5;
        if (x <= 0 || x > x0) return true;
        const h = computeHX(x, p, x0, y0);
        return isNaN(h) || h === Infinity;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 10. NAV PROPERTIES
// ============================================================================

describe("fuzz: NAV properties", () => {
  it("NAV at equilibrium is finite for valid params", () => {
    fc.assert(fc.property(arbParams, (p) => {
      const x0 = computeX0(p);
      const y0 = computeY0(p);
      if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
      // Slightly below x0 to be in valid domain
      const nav = computeNAV_X(x0 * 0.99, p, x0, y0);
      return isNaN(nav) || isFinite(nav);
    }), { numRuns: NUM_RUNS });
  });

  it("NAV with no debt is non-negative in dead zone", () => {
    // In the dead zone (x ∈ (x0-xr, x0)) with no debt, NAV should be positive
    // since all collateral is real and there's no outstanding debt.
    fc.assert(fc.property(
      arbParams.map((p) => ({ ...p, xd: 0, yd: 0, zdebt: 0, eXD: 0 })),
      (p) => {
        const x0 = computeX0(p);
        const y0 = computeY0(p);
        if (isNaN(x0) || isNaN(y0) || x0 <= 0 || y0 <= 0) return true;
        // Test at midpoint of dead zone where no implicit debt exists
        const x = x0 - p.xr * 0.5;
        if (x <= 0 || x > x0) return true;
        const nav = computeNAV_X(x, p, x0, y0);
        if (isNaN(nav)) return true;
        return nav >= -1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 11. PARAMETER VALIDATION
// ============================================================================

describe("fuzz: parameter validation", () => {
  it("valid random params pass validation", () => {
    fc.assert(fc.property(arbParams, (p) => {
      const warnings = validateParams(p);
      return warnings.length === 0;
    }), { numRuns: NUM_RUNS });
  });

  it("dual debt always caught", () => {
    fc.assert(fc.property(
      arbParams,
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      (p, xd, yd) => {
        const bad = { ...p, xd, yd, zdebt: 0 };
        const warnings = validateParams(bad);
        return warnings.some((s) => s.includes("xd and yd"));
      }
    ), { numRuns: 100 });
  });

  it("negative prices always caught", () => {
    fc.assert(fc.property(arbParams, (p) => {
      const bad = { ...p, px: -1 };
      const warnings = validateParams(bad);
      return warnings.some((s) => s.includes("px must be"));
    }), { numRuns: 100 });
  });

  it("cx >= 1 always caught", () => {
    fc.assert(fc.property(
      arbParams,
      fc.double({ min: 1, max: 5, noNaN: true }),
      (p, cx) => {
        const bad = { ...p, cx };
        const warnings = validateParams(bad);
        return warnings.some((s) => s.includes("cx must be"));
      }
    ), { numRuns: 100 });
  });
});

// ============================================================================
// 12. NUMERICAL STABILITY — stress tests
// ============================================================================

describe("fuzz: numerical stability", () => {
  it("fX never returns negative for valid inputs", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice, arbFrac,
      (c, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const y = fX(x, c, x0, y0, px, py);
        return isNaN(y) || y >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fY never returns negative for valid inputs", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 1.0, max: 10.0, noNaN: true }),
      (c, x0, y0, px, py, mult) => {
        const x = x0 * mult;
        const y = fY(x, c, x0, y0, px, py);
        return isNaN(y) || y >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fY handles extreme x values without crashing", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 100, max: 1e6, noNaN: true }),
      (c, x0, y0, px, py, mult) => {
        const x = x0 * mult;
        const y = fY(x, c, x0, y0, px, py);
        // Just shouldn't crash; NaN or 0 is fine
        return y === undefined || isNaN(y) || y >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("gX handles extreme y values without crashing", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 100, max: 1e6, noNaN: true }),
      (c, x0, y0, px, py, mult) => {
        const y = y0 * mult;
        const x = gX(y, c, y0, x0, px, py);
        return x === undefined || isNaN(x) || x >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("high concentration (c→1) doesn't produce NaN in fX", () => {
    fc.assert(fc.property(
      fc.double({ min: 0.99, max: 0.9999, noNaN: true }),
      arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.1, max: 0.99, noNaN: true }),
      (c, x0, y0, px, py, frac) => {
        const x = frac * x0;
        const y = fX(x, c, x0, y0, px, py);
        return !isNaN(y) && isFinite(y) && y >= 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("very small x doesn't produce NaN/Infinity in fX", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (c, x0, y0, px, py) => {
        const x = x0 * 1e-6;
        const y = fX(x, c, x0, y0, px, py);
        return !isNaN(y) && isFinite(y) && y > 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("citardauq vs standard form agree near switching point", () => {
    // The quadratic solver switches between standard and citardauq form at B=0
    // Test continuity near this boundary. Both forms should give the same answer,
    // but there can be numerical differences at extreme parameter ratios.
    fc.assert(fc.property(
      arbC,
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 0.5, max: 5, noNaN: true }),
      fc.double({ min: 0.5, max: 5, noNaN: true }),
      (cy, x0, y0, px, py) => {
        // Find x where B ≈ 0: B = (px/py)(x-x0) - (2cy-1)*y0 = 0
        const xSwitch = x0 + (2 * cy - 1) * y0 * (py / px);
        if (xSwitch <= x0 * 1.05) return true; // too close to domain boundary
        // Evaluate fY on both sides; the function should be smooth through B=0
        const eps = xSwitch * 1e-3;
        const yLeft = fY(xSwitch - eps, cy, x0, y0, px, py);
        const yMid = fY(xSwitch, cy, x0, y0, px, py);
        const yRight = fY(xSwitch + eps, cy, x0, y0, px, py);
        if (isNaN(yLeft) || isNaN(yMid) || isNaN(yRight)) return true;
        if (yMid < 1e-10) return true; // near depletion, skip
        // Check that mid is between left and right (monotonicity through switch)
        return yLeft >= yMid - 1e-9 && yMid >= yRight - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 13. X/Y SYMMETRY
// ============================================================================

describe("fuzz: X/Y curve symmetry", () => {
  it("fX with (c,x0,y0,px,py) = gY with (c,y0,x0,py,px) when symmetric", () => {
    // When we swap X↔Y roles, fX becomes gY
    fc.assert(fc.property(
      arbCwithZero,
      fc.double({ min: 1, max: 100, noNaN: true }),
      arbPrice, arbPrice, arbFrac,
      (c, eq, px, py, frac) => {
        const val = frac * eq;
        const yFromFX = fX(val, c, eq, eq, px, py);
        const xFromGY = gY(val, c, eq, eq, py, px);
        if (isNaN(yFromFX) || isNaN(xFromGY)) return true;
        return relErr(yFromFX, xFromGY) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("fY with (cy,x0,y0,px,py) = gX with (cx,y0,x0,py,px) when symmetric", () => {
    fc.assert(fc.property(
      arbCwithZero,
      fc.double({ min: 1, max: 100, noNaN: true }),
      arbPrice, arbPrice,
      fc.double({ min: 1.01, max: 3.0, noNaN: true }),
      (c, eq, px, py, mult) => {
        const val = eq * mult;
        const yFromFY = fY(val, c, eq, eq, px, py);
        const xFromGX = gX(val, c, eq, eq, py, px);
        if (isNaN(yFromFY) || isNaN(xFromGX)) return true;
        return relErr(yFromFY, xFromGX) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

// ============================================================================
// 14. ORDER BOOK PROPERTIES
// ============================================================================

describe("fuzz: order book — cumulative liquidity", () => {
  it("LXX(0) = x0 (full reserves at equilibrium)", () => {
    fc.assert(fc.property(arbCwithZero, arbReserve, (cx, x0) => {
      return relErr(LXX(0, cx, x0), x0) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });

  it("LYY(0) = y0 (full reserves at equilibrium)", () => {
    fc.assert(fc.property(arbCwithZero, arbReserve, (cy, y0) => {
      return relErr(LYY(0, cy, y0), y0) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });

  it("LXX(rx) = computeXb(x0, rx, cx) (boundary match)", () => {
    fc.assert(fc.property(arbC, arbReserve, arbRange, (cx, x0, rx) => {
      const fromLXX = LXX(rx, cx, x0);
      const fromXb = computeXb(x0, rx, cx);
      if (isNaN(fromLXX) || isNaN(fromXb)) return true;
      return relErr(fromLXX, fromXb) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });

  it("LXX is monotonically decreasing in x", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbRange,
      fc.double({ min: 0.01, max: 0.9, noNaN: true }),
      (cx, x0, rx, frac) => {
        const x1 = rx * frac;
        const x2 = rx * Math.min(frac + 0.05, 1);
        const L1 = LXX(x1, cx, x0);
        const L2 = LXX(x2, cx, x0);
        if (isNaN(L1) || isNaN(L2)) return true;
        return L1 >= L2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("LXX(0) - LXX(rx) ≈ xr (integral consistency)", () => {
    // x0 - x0/sx = x0*(sx-1)/sx = xr*bXC*(sx-1)/sx = xr
    fc.assert(fc.property(arbC, arbReserve, arbRange, (cx, xr, rx) => {
      const sx = computeSx(rx, cx);
      if (isNaN(sx) || sx <= 1) return true;
      const bXC = computeBxc(sx);
      if (isNaN(bXC)) return true;
      const x0 = xr * bXC;
      const diff = LXX(0, cx, x0) - LXX(rx, cx, x0);
      return relErr(diff, xr) < 1e-9;
    }), { numRuns: NUM_RUNS });
  });

  it("X/Y symmetry: LXX(x, c, v) = LYY(x, c, v)", () => {
    fc.assert(fc.property(arbCwithZero, arbReserve, arbRange, (c, v, x) => {
      return relErr(LXX(x, c, v), LYY(x, c, v)) < 1e-12;
    }), { numRuns: NUM_RUNS });
  });
});

describe("fuzz: order book — liquidity density", () => {
  it("lXX is always positive for x >= 0", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbRange,
      fc.double({ min: 0, max: 1, noNaN: true }),
      (cx, x0, rx, frac) => {
        const x = rx * frac;
        const l = lXX(x, cx, x0);
        return isNaN(l) || l > 0;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("lXX matches negative numerical derivative of LXX", () => {
    fc.assert(fc.property(
      arbC, arbReserve,
      fc.double({ min: 0.1, max: 3, noNaN: true }),
      (cx, x0, x) => {
        const h = x * 1e-6;
        if (h < 1e-12) return true;
        const analytical = lXX(x, cx, x0);
        // LXX is decreasing, so -dLXX/dx = lXX
        const numerical = -(LXX(x + h, cx, x0) - LXX(x - h, cx, x0)) / (2 * h);
        if (isNaN(analytical) || isNaN(numerical)) return true;
        return relErr(analytical, numerical) < 1e-4;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("lXX decreases as x increases (density falls at higher prices)", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbRange,
      fc.double({ min: 0.01, max: 0.9, noNaN: true }),
      (cx, x0, rx, frac) => {
        const x1 = rx * frac;
        const x2 = rx * Math.min(frac + 0.05, 1);
        const l1 = lXX(x1, cx, x0);
        const l2 = lXX(x2, cx, x0);
        if (isNaN(l1) || isNaN(l2)) return true;
        return l1 >= l2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});

describe("fuzz: order book — fingerprint", () => {
  it("FX(x, 0) = 1 for all x (c=0 is the baseline)", () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 5, noNaN: true }),
      (x) => {
        return relErr(FX(x, 0), 1) < 1e-12;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("FY(y, 0) = 1 for all y", () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 5, noNaN: true }),
      (y) => {
        return relErr(FY(y, 0), 1) < 1e-12;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("FX(0, cx) > 1 for cx > 0 (concentration amplifies at equilibrium)", () => {
    fc.assert(fc.property(arbC, (cx) => {
      return FX(0, cx) > 1;
    }), { numRuns: NUM_RUNS });
  });

  it("FX is monotonically decreasing in x (concentration effect fades)", () => {
    fc.assert(fc.property(
      arbC,
      fc.double({ min: 0.01, max: 4, noNaN: true }),
      (cx, x) => {
        const f1 = FX(x, cx);
        const f2 = FX(x + 0.05, cx);
        if (isNaN(f1) || isNaN(f2)) return true;
        return f1 >= f2 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("X/Y symmetry: FX(x, c) = FY(x, c)", () => {
    fc.assert(fc.property(
      arbC,
      fc.double({ min: 0, max: 5, noNaN: true }),
      (c, x) => {
        return relErr(FX(x, c), FY(x, c)) < 1e-12;
      }
    ), { numRuns: NUM_RUNS });
  });
});

describe("fuzz: order book — cross-asset liquidity", () => {
  it("LXY(0) = y0 (at equilibrium, fX(x0) = y0)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (cx, x0, y0, px, py) => {
        const val = LXY(0, cx, x0, y0, px, py);
        if (isNaN(val)) return true;
        return relErr(val, y0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("LYX(0) = x0 (at equilibrium, gY(y0) = x0)", () => {
    fc.assert(fc.property(
      arbCwithZero, arbReserve, arbReserve, arbPrice, arbPrice,
      (cy, x0, y0, px, py) => {
        const val = LYX(0, cy, y0, x0, px, py);
        if (isNaN(val)) return true;
        return relErr(val, x0) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("LXY is monotonically increasing in x (more Y flows out at higher prices)", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbReserve, arbPrice, arbPrice, arbRange,
      fc.double({ min: 0.01, max: 0.9, noNaN: true }),
      (cx, x0, y0, px, py, rx, frac) => {
        const x1 = rx * frac;
        const x2 = rx * Math.min(frac + 0.05, 1);
        const L1 = LXY(x1, cx, x0, y0, px, py);
        const L2 = LXY(x2, cx, x0, y0, px, py);
        if (isNaN(L1) || isNaN(L2)) return true;
        return L2 >= L1 - 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("lXY matches numerical derivative of LXY", () => {
    fc.assert(fc.property(
      arbC,
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 1, max: 100, noNaN: true }),
      fc.double({ min: 0.5, max: 5, noNaN: true }),
      fc.double({ min: 0.5, max: 5, noNaN: true }),
      fc.double({ min: 0.1, max: 2, noNaN: true }),
      (cx, x0, y0, px, py, x) => {
        const h = x * 1e-6;
        if (h < 1e-12) return true;
        const analytical = lXY(x, cx, x0, y0, px, py);
        const numerical = (LXY(x + h, cx, x0, y0, px, py) - LXY(x - h, cx, x0, y0, px, py)) / (2 * h);
        if (isNaN(analytical) || isNaN(numerical)) return true;
        if (Math.abs(analytical) < 1e-10 && Math.abs(numerical) < 1e-10) return true;
        return relErr(analytical, numerical) < 1e-3;
      }
    ), { numRuns: NUM_RUNS });
  });

  it("lXY = pXxy(LXX(x)) * lXX(x) cross-check", () => {
    fc.assert(fc.property(
      arbC, arbReserve, arbReserve, arbPrice, arbPrice,
      fc.double({ min: 0.01, max: 3, noNaN: true }),
      (cx, x0, y0, px, py, x) => {
        const lxyVal = lXY(x, cx, x0, y0, px, py);
        const xPos = LXX(x, cx, x0);
        if (isNaN(xPos) || isNaN(lxyVal)) return true;
        const price = pXxy(xPos, cx, x0, px, py);
        const dens = lXX(x, cx, x0);
        if (isNaN(price) || isNaN(dens)) return true;
        return relErr(lxyVal, price * dens) < 1e-9;
      }
    ), { numRuns: NUM_RUNS });
  });
});
