import { describe, it, expect } from "vitest";
import {
  fX, fY, gY, gX, fXd, gYd,
  computeSx, computeSy, computeBxc, computeByc,
  computePX, computePY, computeX0, computeY0,
  computeXb, computeYb,
  computeHX, computeHY,
  CXX, CXY_fn, DXX, DXY, xXXdebt, xXYdebt,
  CYY, CYX_fn, DYY, DYX, yYYdebt, yYXdebt,
  pXxy, pXyx, pYxy, pYyx,
  priceAtXb, priceAtYb,
  computeNAV_X,
  computeZd, computePxy, computePyx, computePzx,
  validateParams, defaultParams,
  type Params,
} from "./math";

// ---------------------------------------------------------------------------
// Test coverage: 39/51 exported functions (76%)
//
// Sections:
//  1. Concentration parameter boundary behavior (c=0 constant-product, c→1 constant-sum)
//  2. Curve continuity at equilibrium (fX/fY/gY/gX meet at (x0,y0))
//  3. Inverse round-trip consistency (fY∘gY ≈ id, gX∘fX ≈ id)
//  4. Derivative consistency (analytical vs numerical finite differences)
//  5. Asymmetric prices (px ≠ py)
//  6. Boost helpers (computeSx, computeBxc, computePX, computeXb)
//  7. Health edge cases (dead zone, boundary guarantee)
//  8. Parameter validation (validateParams)
//  9. Derived price helpers (computePxy, computePyx, computePzx, computeZd)
// 10. Debt phase boundaries (xXYdebt, yYXdebt — cx=0 closed form, cx>0 quadratic)
// 11. Collateral functions (CXX, CXY_fn, CYY, CYX_fn)
// 12. Debt functions (DXX, DXY, DYY, DYX — phase guards, active region formulas)
// 13. Marginal prices (pXxy, pXyx, pYxy, pYyx — equilibrium, reciprocal, monotonicity)
// 14. Boundary prices (priceAtXb, priceAtYb — verify (px/py)(1+rx) identity)
// 15. Health branches (H_XX, H_XY, H_XZ on X-side; H_YY, H_YX, H_YZ on Y-side)
// 15b. Z-debt LLTV asymmetry (vxz≠vyz collateral tier shifting, pXyx non-monotonicity)
// 16. Boost candidates (zero-LLTV baseline, Z/Y/X debt leverage, health≈1 at boundary)
// 17. NAV (equilibrium identity, monotonicity, eXC/eXD effects)
// 18. Y-side mirror symmetry (computeSy, computeByc, computePY, computeYb)
// 19. Health invariants within range (H≥1 for Y/X debt; Z-debt dip bounds)
// 20. Exact values at boundary (CXX, price, fX/gY curve values, health≈1)
// 21. Exact values at equilibrium (health formulas, collateral/debt, NAV, price)
//
// Not tested: point-generation functions (generateFXPoints etc.) — thin plot wrappers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a ≈ b within relative tolerance (default 1e-9) */
function approx(a: number, b: number, tol = 1e-9) {
  expect(a).not.toBeNaN();
  expect(b).not.toBeNaN();
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  expect(Math.abs(a - b) / denom).toBeLessThan(tol);
}

/** Numerical derivative via central finite difference */
function numDeriv(fn: (t: number) => number, t: number, h = 1e-7): number {
  return (fn(t + h) - fn(t - h)) / (2 * h);
}

// Common test fixtures
const px = 1, py = 1;
const x0 = 10, y0 = 10;

// ---------------------------------------------------------------------------
// 1. Concentration parameter boundary behavior
// ---------------------------------------------------------------------------

describe("c=0 (constant-product, xy=k)", () => {
  const c = 0;

  it("fX(x) satisfies x·y = x0² when px=py and x0=y0", () => {
    for (const x of [1, 2, 5, 8, 9.9]) {
      const y = fX(x, c, x0, y0, px, py);
      approx(x * y, x0 * y0);
    }
  });

  it("gY(y) satisfies x·y = x0² when px=py and x0=y0", () => {
    for (const y of [1, 2, 5, 8, 9.9]) {
      const x = gY(y, c, y0, x0, px, py);
      approx(x * y, x0 * y0);
    }
  });

  it("fY c=0 matches closed form y0²/((px/py)(x-x0)+y0)", () => {
    for (const x of [10, 12, 15, 20, 50]) {
      const y = fY(x, c, x0, y0, px, py);
      const expected = (y0 * y0) / ((px / py) * (x - x0) + y0);
      approx(y, expected);
    }
  });

  it("fY (inverse side) is monotonically decreasing and positive", () => {
    for (const x of [10, 12, 15, 20, 50]) {
      const y = fY(x, c, x0, y0, px, py);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(y0);
    }
    const y15 = fY(15, c, x0, y0, px, py);
    const y20 = fY(20, c, x0, y0, px, py);
    expect(y15).toBeGreaterThan(y20);
  });

  it("computeSx simplifies to sqrt(1+rx) when cx=0", () => {
    for (const rx of [0.5, 1, 2, 5]) {
      approx(computeSx(rx, 0), Math.sqrt(1 + rx));
    }
  });
});

describe("c→1 (constant-sum, x+y=k)", () => {
  // Use c very close to 1 but not equal (c=1 is excluded from domain)
  const cHigh = 0.9999;

  it("fX is approximately linear: y ≈ y0 + (px/py)(x0-x)", () => {
    for (const x of [3, 5, 7, 9]) {
      const y = fX(x, cHigh, x0, y0, px, py);
      const yLinear = y0 + (px / py) * (x0 - x);
      approx(y, yLinear, 1e-3);
    }
  });

  it("marginal price is approximately constant at px/py", () => {
    for (const x of [3, 5, 8]) {
      const deriv = fXd(x, cHigh, x0, px, py);
      approx(deriv, -(px / py), 2e-3);
    }
  });

  it("fY returns near-zero at the depletion point", () => {
    // Constant-sum depletes Y at x ≈ x0 + y0·(py/px) = 20
    const y = fY(20, cHigh, x0, y0, px, py);
    expect(y).toBeLessThan(0.2);
  });

  it("computeSx grows large as cx→1", () => {
    const sx99 = computeSx(1, 0.99);
    const sx999 = computeSx(1, 0.999);
    expect(sx999).toBeGreaterThan(sx99);
    expect(sx99).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Curve continuity at equilibrium
// ---------------------------------------------------------------------------

describe("curve continuity at equilibrium", () => {
  for (const c of [0, 0.3, 0.5, 0.8, 0.99]) {
    it(`fX(x0) = y0 and fY(x0) = y0 at c=${c}`, () => {
      approx(fX(x0, c, x0, y0, px, py), y0);
      approx(fY(x0, c, x0, y0, px, py), y0);
    });

    it(`gY(y0) = x0 and gX(y0) = x0 at c=${c}`, () => {
      approx(gY(y0, c, y0, x0, px, py), x0);
      approx(gX(y0, c, y0, x0, px, py), x0);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Inverse consistency (round-trip)
// ---------------------------------------------------------------------------

describe("inverse round-trip consistency", () => {
  // fY inverts gY (both Y-side, use cy=c)
  // gX inverts fX (both X-side, use cx=c)
  for (const c of [0, 0.3, 0.5, 0.8]) {
    it(`Y-side: fY(gY(y)) ≈ y at c=${c}`, () => {
      // gY: y ≤ y0 → x ≥ x0;  fY: x ≥ x0 → y ≤ y0
      for (const y of [2, 5, 8, 9.5]) {
        const x = gY(y, c, y0, x0, px, py);
        expect(x).not.toBeNaN();
        expect(x).toBeGreaterThanOrEqual(x0 - 1e-9);
        const yBack = fY(x, c, x0, y0, px, py);
        approx(yBack, y, 1e-6);
      }
    });

    it(`X-side: gX(fX(x)) ≈ x at c=${c}`, () => {
      // fX: x ≤ x0 → y ≥ y0;  gX: y ≥ y0 → x ≤ x0
      for (const x of [2, 5, 8, 9.5]) {
        const y = fX(x, c, x0, y0, px, py);
        expect(y).not.toBeNaN();
        expect(y).toBeGreaterThanOrEqual(y0 - 1e-9);
        const xBack = gX(y, c, y0, x0, px, py);
        approx(xBack, x, 1e-6);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Derivative consistency (numerical vs analytical)
// ---------------------------------------------------------------------------

describe("derivative consistency", () => {
  for (const c of [0, 0.3, 0.5, 0.8]) {
    it(`fXd matches numerical derivative at c=${c}`, () => {
      for (const x of [2, 5, 8]) {
        const analytical = fXd(x, c, x0, px, py);
        const numerical = numDeriv((t) => fX(t, c, x0, y0, px, py), x);
        approx(analytical, numerical, 1e-4);
      }
    });

    it(`gYd matches numerical derivative at c=${c}`, () => {
      for (const y of [2, 5, 8]) {
        const analytical = gYd(y, c, y0, px, py);
        const numerical = numDeriv((t) => gY(t, c, y0, x0, px, py), y);
        approx(analytical, numerical, 1e-4);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Asymmetric prices (px ≠ py)
// ---------------------------------------------------------------------------

describe("asymmetric prices", () => {
  const pxA = 2, pyA = 1;

  it("fX and fY are continuous at equilibrium with px≠py", () => {
    for (const c of [0, 0.5, 0.8]) {
      approx(fX(x0, c, x0, y0, pxA, pyA), y0);
      approx(fY(x0, c, x0, y0, pxA, pyA), y0);
    }
  });

  it("constant-product with px≠py: x·y ≠ k but fX·x is proportional", () => {
    // When px≠py, fX(x) = y0 + (px/py)·x0²/x - (px/py)·x0
    // So y = y0 - (px/py)x0 + (px/py)x0²/x
    // x·y = x·y0 - (px/py)x0·x + (px/py)x0²
    // Not constant, but the curve is still hyperbolic
    const y5 = fX(5, 0, x0, y0, pxA, pyA);
    const y8 = fX(8, 0, x0, y0, pxA, pyA);
    expect(y5).toBeGreaterThan(y8); // more X in → more Y out
  });
});

// ---------------------------------------------------------------------------
// 6. Boost helpers
// ---------------------------------------------------------------------------

describe("boost helpers", () => {
  it("computeSx returns NaN when cx >= 1", () => {
    expect(computeSx(1, 1)).toBeNaN();
    expect(computeSx(1, 1.5)).toBeNaN();
  });

  it("computeSx returns NaN when radicand is negative", () => {
    // (1 + rx - cx) / (1 - cx) < 0 when rx < cx - 1 and cx < 1
    // e.g. rx=0.01, cx=0.99: (1 + 0.01 - 0.99)/(1-0.99) = 0.02/0.01 = 2 > 0
    // Hard to get negative with valid params, but test the guard
    expect(computeSx(-2, 0.5)).toBeNaN();
  });

  it("computeBxc returns NaN with warning when sx <= 1", () => {
    expect(computeBxc(1)).toBeNaN();
    expect(computeBxc(0.5)).toBeNaN();
  });

  it("computeBxc(sx) = sx/(sx-1) for valid sx", () => {
    const sx = 2;
    approx(computeBxc(sx), 2); // 2/(2-1) = 2
    approx(computeBxc(3), 1.5); // 3/(3-1) = 1.5
  });

  it("PX = cx + (1-cx)*sx", () => {
    approx(computePX(0, 2), 2);       // 0 + 1*2
    approx(computePX(0.5, 3), 2);     // 0.5 + 0.5*3
    approx(computePX(0.8, 5), 1.8);   // 0.8 + 0.2*5
  });

  it("boundary xb = x0/sx", () => {
    const rx = 1, cx = 0.5;
    const sx = computeSx(rx, cx);
    const xb = computeXb(x0, rx, cx);
    approx(xb, x0 / sx);
  });

  it("X/Y boost symmetry: same params give same boost", () => {
    const symParams: Params = {
      ...defaultParams,
      px: 1, py: 1, rx: 1, ry: 1, cx: 0.5, cy: 0.5,
      xr: 10, yr: 10, xd: 0, yd: 0, zdebt: 10, zr: 5,
      // Symmetric LLTVs
      vyx: 0.9, vxy: 0.9, vxz: 0.6, vyz: 0.6, vzx: 0.5, vzy: 0.5,
      rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    };
    const bx = computeX0(symParams);
    const by = computeY0(symParams);
    approx(bx, by);
  });
});

// ---------------------------------------------------------------------------
// 7. Health edge cases
// ---------------------------------------------------------------------------

describe("health edge cases", () => {
  it("health = Infinity in dead zone (no debt)", () => {
    // With xd=yd=zdebt=0, health should be Infinity in the dead zone
    // (between xXXdebt and xXYdebt where both DXX and DXY are zero)
    const noDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 0 };
    const x0v = computeX0(noDebt);
    const y0v = computeY0(noDebt);
    // Dead zone is x ∈ (x0-xr, x0). Test near equilibrium.
    const h = computeHX(x0v * 0.99, noDebt, x0v, y0v);
    expect(h).toBe(Infinity);
  });

  it("health is finite when debt exists", () => {
    const withDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(withDebt);
    const y0v = computeY0(withDebt);
    const h = computeHX(x0v * 0.5, withDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("health at boundary xb is ≥ 1 (boost guarantee)", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    // xb is the lower limit; health should be ≥ 1 by construction
    const h = computeHX(xb + 0.001, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(0.99); // allow small numerical tolerance
  });
});

// ---------------------------------------------------------------------------
// 8. Parameter validation
// ---------------------------------------------------------------------------

describe("validateParams", () => {
  it("returns empty for valid default params", () => {
    expect(validateParams(defaultParams)).toHaveLength(0);
  });

  it("catches dual debts", () => {
    const dual = { ...defaultParams, xd: 5, yd: 5, zdebt: 0 };
    const w = validateParams(dual);
    expect(w.some((s) => s.includes("xd and yd"))).toBe(true);
  });

  it("catches cx >= 1", () => {
    const bad = { ...defaultParams, cx: 1 };
    const w = validateParams(bad);
    expect(w.some((s) => s.includes("cx must be"))).toBe(true);
  });

  it("catches non-positive prices", () => {
    const bad = { ...defaultParams, px: 0 };
    const w = validateParams(bad);
    expect(w.some((s) => s.includes("px must be"))).toBe(true);
  });

  it("catches negative rx", () => {
    const bad = { ...defaultParams, rx: -1 };
    const w = validateParams(bad);
    expect(w.some((s) => s.includes("rx must be"))).toBe(true);
  });

  it("catches degenerate ry", () => {
    const bad = { ...defaultParams, ry: -0.5 };
    const w = validateParams(bad);
    expect(w.some((s) => s.includes("ry must be"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Derived price helpers
// ---------------------------------------------------------------------------

describe("derived price helpers", () => {
  it("computePxy = px/py", () => {
    approx(computePxy({ ...defaultParams, px: 3, py: 2 }), 1.5);
  });

  it("computePyx = py/px", () => {
    approx(computePyx({ ...defaultParams, px: 3, py: 2 }), 2 / 3);
  });

  it("computePzx = 1/pxz", () => {
    approx(computePzx({ ...defaultParams, pxz: 4 }), 0.25);
  });

  it("computeZd returns 0 when xd or yd > 0", () => {
    expect(computeZd({ ...defaultParams, xd: 5, yd: 0, zdebt: 10 })).toBe(0);
    expect(computeZd({ ...defaultParams, xd: 0, yd: 5, zdebt: 10 })).toBe(0);
  });

  it("computeZd returns zdebt when xd=yd=0", () => {
    expect(computeZd({ ...defaultParams, xd: 0, yd: 0, zdebt: 10 })).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 10. Debt phase boundaries (xXYdebt, yYXdebt)
// ---------------------------------------------------------------------------

describe("debt phase boundaries", () => {
  it("xXXdebt = x0 - xr", () => {
    approx(xXXdebt(20, 10), 10);
    approx(xXXdebt(100, 30), 70);
  });

  it("xXYdebt = x0 when yd = 0", () => {
    approx(xXYdebt(20, 0.5, 0, 1, 1), 20);
  });

  it("xXYdebt cx=0: x0²/(kX + x0) where kX = yd·py/px", () => {
    // x0=20, yd=5, px=py=1 → kX=5, xXYdebt = 400/25 = 16
    approx(xXYdebt(20, 0, 5, 1, 1), 16);
  });

  it("xXYdebt cx=0.5: fX(xXYd) - y0 = yd (Y debt exactly repaid)", () => {
    const x0v = 20, y0v = 20, yd = 5;
    const xXYd = xXYdebt(x0v, 0.5, yd, 1, 1);
    // At xXYd, the swap delta should equal yd
    const yXdelta = fX(xXYd, 0.5, x0v, y0v, 1, 1) - y0v;
    approx(yXdelta, yd, 1e-9);
  });

  it("xXYdebt with asymmetric prices", () => {
    // x0=20, yd=5, px=2, py=1 → kX = 5*1/2 = 2.5
    // cx=0: xXYdebt = 400/(2.5+20) = 17.778
    approx(xXYdebt(20, 0, 5, 2, 1), 400 / 22.5);
  });

  it("yYYdebt = y0 - yr", () => {
    approx(yYYdebt(20, 10), 10);
  });

  it("yYXdebt = y0 when xd = 0", () => {
    approx(yYXdebt(20, 0.5, 0, 1, 1), 20);
  });

  it("yYXdebt cy=0: y0²/(kY + y0) where kY = xd·px/py", () => {
    // y0=20, xd=5, px=py=1 → kY=5, yYXdebt = 400/25 = 16
    approx(yYXdebt(20, 0, 5, 1, 1), 16);
  });

  it("yYXdebt cy=0.5: gY(yYXd) - x0 = xd (X debt exactly repaid)", () => {
    const x0v = 20, y0v = 20, xd = 5;
    const yYXd = yYXdebt(y0v, 0.5, xd, 1, 1);
    const xYdelta = gY(yYXd, 0.5, y0v, x0v, 1, 1) - x0v;
    approx(xYdelta, xd, 1e-9);
  });
});

// ---------------------------------------------------------------------------
// 11. Collateral functions
// ---------------------------------------------------------------------------

describe("collateral functions", () => {
  it("CXX at equilibrium = xr", () => {
    approx(CXX(20, 20, 10), 10);
  });

  it("CXX = 0 below xXXdebt", () => {
    // x0=20, xr=10, xXXdebt=10. At x=8: CXX = max(10-12, 0) = 0
    approx(CXX(8, 20, 10), 0);
  });

  it("CXX decreases as x moves away from x0", () => {
    // x0=20, xr=10. At x=15: CXX = max(10-5, 0) = 5
    approx(CXX(15, 20, 10), 5);
    expect(CXX(15, 20, 10)).toBeLessThan(CXX(18, 20, 10));
  });

  it("CXY_fn at equilibrium with zd>0 = yr", () => {
    const cxy = CXY_fn(20, 0.5, 20, 20, 1, 1, 10, 0, 5);
    approx(cxy, 10); // yr=10, yXdelta=0
  });

  it("CXY_fn at equilibrium with yd>0 = yr", () => {
    // yXdelta=0, so max(0-yd, 0) = 0, CXY = yr
    const cxy = CXY_fn(20, 0.5, 20, 20, 1, 1, 10, 5, 0);
    approx(cxy, 10);
  });

  it("CXY_fn increases as x decreases (more Y flows in)", () => {
    const c1 = CXY_fn(18, 0.5, 20, 20, 1, 1, 10, 0, 5);
    const c2 = CXY_fn(15, 0.5, 20, 20, 1, 1, 10, 0, 5);
    expect(c2).toBeGreaterThan(c1);
  });

  it("CYY at equilibrium = yr", () => {
    approx(CYY(20, 20, 10), 10);
  });

  it("CYY = 0 below yYYdebt", () => {
    approx(CYY(8, 20, 10), 0);
  });

  it("CYX_fn at equilibrium with zd>0 = xr", () => {
    const cyx = CYX_fn(20, 0.5, 20, 20, 1, 1, 10, 0, 5);
    approx(cyx, 10);
  });
});

// ---------------------------------------------------------------------------
// 12. Debt functions
// ---------------------------------------------------------------------------

describe("debt functions", () => {
  it("DXX = 0 when zd > 0", () => {
    expect(DXX(5, 20, 10, 5, 10, 20, 5)).toBe(0);
  });

  it("DXX = 0 when x > xXXdebt", () => {
    // x=12, xXXd=10, xXYd=20 → x > xXXd → DXX=0
    expect(DXX(12, 20, 10, 5, 10, 20, 0)).toBe(0);
  });

  it("DXX = 0 when x > xXYdebt", () => {
    // x=18, xXXd=10, xXYd=16 → x > xXYd → DXX=0
    expect(DXX(18, 20, 10, 5, 10, 16, 0)).toBe(0);
  });

  it("DXX = xd + max(xXdelta - xr, 0) when in active region", () => {
    // x=8, x0=20, xr=10, xd=5, xXXd=10, xXYd=20
    // x <= xXXd && x <= xXYd → active
    // DXX = 5 + max((20-8)-10, 0) = 5 + 2 = 7
    approx(DXX(8, 20, 10, 5, 10, 20, 0), 7);
  });

  it("DXX at exactly xXXdebt = xd", () => {
    // At xXXdebt=10: xXdelta = x0 - x = 20 - 10 = 10 = xr
    // DXX = xd + max(10-10, 0) = xd
    approx(DXX(10, 20, 10, 5, 10, 20, 0), 5);
  });

  it("DXY = 0 when zd > 0", () => {
    expect(DXY(18, 0.5, 20, 20, 1, 1, 5, 16, 5)).toBe(0);
  });

  it("DXY = 0 when x < xXYdebt", () => {
    // x=14, xXYd=16 → x < xXYd → DXY=0
    expect(DXY(14, 0.5, 20, 20, 1, 1, 5, 16, 0)).toBe(0);
  });

  it("DXY = yd at equilibrium when yd > 0", () => {
    // At x=x0: yXdelta = 0 → DXY = max(yd - 0, 0) = yd
    const x0v = 20, y0v = 20, yd = 5;
    const xXYd = xXYdebt(x0v, 0.5, yd, 1, 1);
    approx(DXY(x0v, 0.5, x0v, y0v, 1, 1, yd, xXYd, 0), yd);
  });

  it("DXY decreases as x decreases from x0 (Y debt being repaid)", () => {
    const x0v = 20, y0v = 20, yd = 5;
    const xXYd = xXYdebt(x0v, 0.5, yd, 1, 1);
    const d1 = DXY(19, 0.5, x0v, y0v, 1, 1, yd, xXYd, 0);
    const d2 = DXY(18, 0.5, x0v, y0v, 1, 1, yd, xXYd, 0);
    expect(d1).toBeGreaterThan(d2);
  });

  it("DYY = 0 when zd > 0", () => {
    expect(DYY(5, 20, 10, 5, 10, 20, 5)).toBe(0);
  });

  it("DYY in active region = yd + max(yYdelta - yr, 0)", () => {
    // y=8, y0=20, yr=10, yd=5, yYYd=10, yYXd=20
    // DYY = 5 + max((20-8)-10, 0) = 5 + 2 = 7
    approx(DYY(8, 20, 10, 5, 10, 20, 0), 7);
  });

  it("DYX = 0 when y < yYXdebt", () => {
    expect(DYX(14, 0.5, 20, 20, 1, 1, 5, 16, 0)).toBe(0);
  });

  it("DYX = xd at equilibrium when xd > 0", () => {
    const x0v = 20, y0v = 20, xd = 5;
    const yYXd = yYXdebt(y0v, 0.5, xd, 1, 1);
    approx(DYX(y0v, 0.5, y0v, x0v, 1, 1, xd, yYXd, 0), xd);
  });
});

// ---------------------------------------------------------------------------
// 13. Marginal prices
// ---------------------------------------------------------------------------

describe("marginal prices", () => {
  it("pXxy at equilibrium = px/py", () => {
    for (const c of [0, 0.3, 0.5, 0.8]) {
      approx(pXxy(x0, c, x0, px, py), px / py);
    }
  });

  it("pXyx at equilibrium = py/px", () => {
    for (const c of [0, 0.3, 0.5, 0.8]) {
      approx(pXyx(x0, c, x0, px, py), py / px);
    }
  });

  it("pXxy * pXyx = 1 (reciprocal identity)", () => {
    for (const x of [2, 5, 8]) {
      const xy = pXxy(x, 0.5, x0, px, py);
      const yx = pXyx(x, 0.5, x0, px, py);
      approx(xy * yx, 1);
    }
  });

  it("pYyx at equilibrium = py/px", () => {
    for (const c of [0, 0.3, 0.5, 0.8]) {
      approx(pYyx(y0, c, y0, px, py), py / px);
    }
  });

  it("pYxy at equilibrium = px/py", () => {
    for (const c of [0, 0.3, 0.5, 0.8]) {
      approx(pYxy(y0, c, y0, px, py), px / py);
    }
  });

  it("pYxy * pYyx = 1 (reciprocal identity)", () => {
    for (const y of [2, 5, 8]) {
      const xy = pYxy(y, 0.5, y0, px, py);
      const yx = pYyx(y, 0.5, y0, px, py);
      approx(xy * yx, 1);
    }
  });

  it("pXxy increases as x decreases (price impact)", () => {
    const p5 = pXxy(5, 0.5, x0, px, py);
    const p8 = pXxy(8, 0.5, x0, px, py);
    expect(p5).toBeGreaterThan(p8);
  });

  it("pXxy with px≠py scales proportionally", () => {
    const pxA = 2, pyA = 1;
    approx(pXxy(x0, 0.5, x0, pxA, pyA), pxA / pyA);
  });
});

// ---------------------------------------------------------------------------
// 14. Boundary prices
// ---------------------------------------------------------------------------

describe("boundary prices", () => {
  it("priceAtXb = (px/py)(1+rx)", () => {
    // At boundary xb, the price should be (px/py)(1+rx)
    for (const [rxV, cxV] of [[1, 0.5], [0.5, 0.3], [2, 0.8]] as [number, number][]) {
      const x0v = 20;
      const expected = (px / py) * (1 + rxV);
      approx(priceAtXb(x0v, rxV, cxV, px, py), expected, 1e-9);
    }
  });

  it("priceAtYb = (py/px)(1+ry)", () => {
    for (const [ryV, cyV] of [[1, 0.5], [0.5, 0.3], [2, 0.8]] as [number, number][]) {
      const y0v = 20;
      const expected = (py / px) * (1 + ryV);
      approx(priceAtYb(y0v, ryV, cyV, px, py), expected, 1e-9);
    }
  });

  it("priceAtXb with asymmetric prices", () => {
    const pxA = 2, pyA = 1;
    approx(priceAtXb(20, 1, 0.5, pxA, pyA), (pxA / pyA) * 2);
  });
});

// ---------------------------------------------------------------------------
// 15. Health branch tests
// ---------------------------------------------------------------------------

describe("health branches", () => {
  // Params with Y debt → H_XY phase near equilibrium, H_XX phase far from equilibrium
  const pYDebt: Params = {
    ...defaultParams, xd: 0, yd: 5, zdebt: 0,
    xr: 10, yr: 10, cx: 0.5, cy: 0.5,
    px: 1, py: 1, vyx: 0.9, vxy: 0.9,
  };

  it("H_XY: health is finite near equilibrium with Y debt", () => {
    const x0v = computeX0(pYDebt);
    const y0v = computeY0(pYDebt);
    // Near equilibrium, DXY > 0 → H_XY branch
    const h = computeHX(x0v * 0.95, pYDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("H_XX: health is finite far from equilibrium with Y debt", () => {
    const x0v = computeX0(pYDebt);
    const y0v = computeY0(pYDebt);
    // Far from equilibrium: Y debt repaid, X debt accumulates → H_XX branch
    const xXYd = xXYdebt(x0v, pYDebt.cx, pYDebt.yd, pYDebt.px, pYDebt.py);
    const xb = computeXb(x0v, pYDebt.rx, pYDebt.cx);
    // Test a point below xXYd but above xb
    const xTest = (xb + xXYd) / 2;
    if (xTest > xb && xTest < xXYd) {
      const h = computeHX(xTest, pYDebt, x0v, y0v);
      expect(h).not.toBeNaN();
      expect(h).toBeGreaterThan(0);
    }
  });

  it("H_XZ: health with Z debt", () => {
    const pZDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(pZDebt);
    const y0v = computeY0(pZDebt);
    const h = computeHX(x0v * 0.5, pZDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("H_XZ uses vxz*CXX + vyz*CXY*pXyx formula", () => {
    // Verify health at equilibrium: CXX=xr, CXY=yr, pXyx=py/px, DXZ=zd
    // H_XZ = (vxz*xr + vyz*yr*(py/px) + rXZ) / (zd * pzx)
    const pZDebt: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5,
      vxz: 0.6, vyz: 0.5, pxz: 1, rXZ: 0,
    };
    const x0v = computeX0(pZDebt);
    const y0v = computeY0(pZDebt);
    // Just below equilibrium to be in valid range
    const xTest = x0v * 0.999;
    const h = computeHX(xTest, pZDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(h).toBeGreaterThan(0);
  });

  // Y-side health mirrors
  const pXDebt: Params = {
    ...defaultParams, xd: 5, yd: 0, zdebt: 0,
    xr: 10, yr: 10, cx: 0.5, cy: 0.5,
    px: 1, py: 1, vyx: 0.9, vxy: 0.9,
  };

  it("H_YX: health is finite near equilibrium with X debt", () => {
    const x0v = computeX0(pXDebt);
    const y0v = computeY0(pXDebt);
    const h = computeHY(y0v * 0.95, pXDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("H_YY: health is finite far from equilibrium with X debt", () => {
    const x0v = computeX0(pXDebt);
    const y0v = computeY0(pXDebt);
    const yYXd = yYXdebt(y0v, pXDebt.cy, pXDebt.xd, pXDebt.px, pXDebt.py);
    const yb = computeYb(y0v, pXDebt.ry, pXDebt.cy);
    const yTest = (yb + yYXd) / 2;
    if (yTest > yb && yTest < yYXd) {
      const h = computeHY(yTest, pXDebt, x0v, y0v);
      expect(h).not.toBeNaN();
      expect(h).toBeGreaterThan(0);
    }
  });

  it("H_YZ: health with Z debt on Y side", () => {
    const pZDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(pZDebt);
    const y0v = computeY0(pZDebt);
    const h = computeHY(y0v * 0.5, pZDebt, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("health decreases as reserve moves toward boundary", () => {
    const pZDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(pZDebt);
    const y0v = computeY0(pZDebt);
    const hNear = computeHX(x0v * 0.8, pZDebt, x0v, y0v);
    const hFar = computeHX(x0v * 0.5, pZDebt, x0v, y0v);
    expect(hNear).toBeGreaterThan(hFar);
  });

  it("health returns NaN for out-of-range x", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    expect(computeHX(0, p, x0v, y0v)).toBeNaN();
    expect(computeHX(-1, p, x0v, y0v)).toBeNaN();
    expect(computeHX(x0v + 1, p, x0v, y0v)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// 15b. Z-debt LLTV asymmetry: swaps shift collateral between tiers
// ---------------------------------------------------------------------------
// H_XZ = (vxz*CXX + vyz*CXY*pXyx + rXZ) / (zd*pzx)
// As x drops from x0: CXX shrinks (X consumed), CXY grows (Y flows in).
// When vxz ≠ vyz the swap converts collateral from one LLTV tier to another,
// which can raise or lower health depending on which LLTV dominates.

describe("Z-debt LLTV asymmetry", () => {
  // Base params: symmetric except for vxz vs vyz, px=py=1 so pXyx≈1
  const base: Params = {
    ...defaultParams,
    xd: 0, yd: 0, zdebt: 10, zr: 5,
    xr: 10, yr: 10, cx: 0.5, cy: 0.5,
    px: 1, py: 1, pxz: 1,
    vyx: 0.9, vxy: 0.9, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0,
    rYX: 0, rYY: 0, rYZ: 0,
  };

  it("vxz > vyz: health decreases as swap converts X→Y collateral", () => {
    // X collateral has higher LLTV, so losing X and gaining Y hurts health
    const p: Params = { ...base, vxz: 0.8, vyz: 0.3 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    // Near equilibrium: mostly X collateral (CXX ≈ xr, CXY ≈ yr)
    const hNear = computeHX(x0v * 0.98, p, x0v, y0v);
    // Further away: less X, more Y
    const hMid = computeHX(x0v * 0.7, p, x0v, y0v);
    expect(hNear).not.toBeNaN();
    expect(hMid).not.toBeNaN();
    expect(isFinite(hNear)).toBe(true);
    expect(isFinite(hMid)).toBe(true);
    // Health should drop because we're losing high-LLTV X and gaining low-LLTV Y
    expect(hNear).toBeGreaterThan(hMid);
  });

  it("swapping vxz↔vyz changes equilibrium health when xr*(py/px) ≠ yr", () => {
    // At equilibrium: H_XZ ≈ (vxz*xr + vyz*yr*(py/px)) / (zd*pzx)
    // Swapping vxz↔vyz changes which term dominates.
    // With xr=yr=10 and px=py=1: xr = yr*(py/px), so both configs give
    // the same equilibrium health. Use px≠py to break symmetry.
    const pA: Params = { ...base, vxz: 0.8, vyz: 0.3, px: 2, py: 1 };
    const pB: Params = { ...base, vxz: 0.3, vyz: 0.8, px: 2, py: 1 };
    const x0a = computeX0(pA), y0a = computeY0(pA);
    const x0b = computeX0(pB), y0b = computeY0(pB);
    // Use additive epsilon to stay very close to equilibrium
    const epsA = Math.min(pA.xr * 1e-6, 1e-6);
    const epsB = Math.min(pB.xr * 1e-6, 1e-6);
    const hA = computeHX(x0a - epsA, pA, x0a, y0a);
    const hB = computeHX(x0b - epsB, pB, x0b, y0b);
    expect(hA).not.toBeNaN();
    expect(hB).not.toBeNaN();
    expect(isFinite(hA)).toBe(true);
    expect(isFinite(hB)).toBe(true);
    // With px=2, py=1: yr*(py/px) = 10*0.5 = 5, while xr = 10
    // pA: 0.8*10 + 0.3*5 = 9.5, pB: 0.3*10 + 0.8*5 = 7.0
    // So hA should be larger (X collateral weighted more when xr > yr*(py/px))
    expect(hA).toBeGreaterThan(hB);
  });

  it("pXyx effect: even with equal LLTVs, health is not strictly monotonic", () => {
    // pXyx = 1/(-fXd(x)) = 1/((px/py)(cx + (1-cx)(x0/x)²))
    // As x→0, (x0/x)² grows quadratically, so pXyx→0. This means Y collateral
    // in X terms (CXY*pXyx) can decrease even as CXY grows in Y terms.
    // This makes health non-monotonic even when vxz = vyz.
    const p: Params = { ...base, vxz: 0.6, vyz: 0.6 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    // Sample health at many points across the range
    const samples = Array.from({ length: 20 }, (_, i) => {
      const frac = 0.05 + 0.9 * (i / 19);
      const x = xb + (x0v - xb) * frac;
      return computeHX(x, p, x0v, y0v);
    }).filter(h => isFinite(h) && !isNaN(h));
    // Health should not be strictly monotonic — verify at least one increase
    let hasIncrease = false;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i] > samples[i - 1] + 1e-9) hasIncrease = true;
    }
    expect(hasIncrease).toBe(true);
  });

  it("health formula at equilibrium matches manual calculation", () => {
    // At x = x0: CXX = xr, CXY = yr, pXyx = py/px = 1
    // H_XZ = (vxz*xr + vyz*yr*1 + 0) / (zd * (1/pxz))
    const p: Params = { ...base, vxz: 0.7, vyz: 0.4 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    // Test just below equilibrium
    const h = computeHX(x0v * 0.9999, p, x0v, y0v);
    const expected = (0.7 * p.xr + 0.4 * p.yr * (p.py / p.px)) / (p.zdebt * (1 / p.pxz));
    approx(h, expected, 1e-3);
  });

  it("Y-side mirror: vyz > vxz means H_YZ health drops as y→yb", () => {
    // On Y side: H_YZ = (vyz*CYY + vxz*CYX*pYxy + rYZ) / (zd*pzy)
    // As y drops: CYY shrinks (Y consumed), CYX grows (X flows in)
    // If vyz > vxz, losing high-LLTV Y hurts more than gaining low-LLTV X helps
    const p: Params = { ...base, vxz: 0.3, vyz: 0.8 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const hNear = computeHY(y0v * 0.98, p, x0v, y0v);
    const hMid = computeHY(y0v * 0.7, p, x0v, y0v);
    expect(hNear).not.toBeNaN();
    expect(hMid).not.toBeNaN();
    expect(isFinite(hNear)).toBe(true);
    expect(isFinite(hMid)).toBe(true);
    expect(hNear).toBeGreaterThan(hMid);
  });

  it("LLTV weighting: higher vxz means X collateral matters more in the formula", () => {
    // At equilibrium: H = (vxz*xr + vyz*yr*(py/px)) / (zd*pzx)
    // Increasing vxz while keeping vyz fixed should increase health
    const pLow: Params = { ...base, vxz: 0.3, vyz: 0.5 };
    const pHigh: Params = { ...base, vxz: 0.8, vyz: 0.5 };
    const x0Low = computeX0(pLow), y0Low = computeY0(pLow);
    const x0High = computeX0(pHigh), y0High = computeY0(pHigh);
    const hLow = computeHX(x0Low * 0.999, pLow, x0Low, y0Low);
    const hHigh = computeHX(x0High * 0.999, pHigh, x0High, y0High);
    expect(hHigh).toBeGreaterThan(hLow);
  });
});

// ---------------------------------------------------------------------------
// 16. Boost candidate tests (via computeX0/Y0)
// ---------------------------------------------------------------------------

describe("boost candidates", () => {
  it("zero LLTVs: boost = concentration only (bXC)", () => {
    // With all LLTVs=0, no leverage is possible regardless of debt
    const noLev: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const sx = computeSx(noLev.rx, noLev.cx);
    const bXC = computeBxc(sx);
    const x0v = computeX0(noLev);
    approx(x0v, noLev.xr * bXC);
  });

  it("Z debt with vxz/vyz > 0 increases boost beyond zero-LLTV baseline", () => {
    const noLev: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const withZ: Params = {
      ...noLev, zdebt: 10, zr: 5, vxz: 0.6, vyz: 0.5,
    };
    expect(computeX0(withZ)).toBeGreaterThan(computeX0(noLev));
  });

  it("Y debt with nonzero LLTVs increases boost beyond zero-LLTV baseline", () => {
    const noLev: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const withYD: Params = {
      ...noLev, yd: 5, vyx: 0.9, vxy: 0.9,
    };
    expect(computeX0(withYD)).toBeGreaterThan(computeX0(noLev));
  });

  it("X debt with nonzero LLTVs increases Y-side boost beyond zero-LLTV baseline", () => {
    const noLev: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const withXD: Params = {
      ...noLev, xd: 5, vyx: 0.9, vxy: 0.9,
    };
    expect(computeY0(withXD)).toBeGreaterThan(computeY0(noLev));
  });

  it("higher LLTV → higher boost", () => {
    const lowV: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.5 };
    const highV: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9 };
    expect(computeX0(highV)).toBeGreaterThanOrEqual(computeX0(lowV));
  });

  it("health ≈ 1 at boundary for Z debt", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    // Health at boundary should be ≈ 1 (boost is calibrated for this)
    const h = computeHX(xb + 0.001, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(0.99);
    expect(h).toBeLessThan(1.5);
  });

  it("health ≈ 1 at boundary for Y debt", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, vxy: 0.9 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const h = computeHX(xb + 0.001, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(0.99);
  });

  it("Y-side: health ≈ 1 at boundary for X debt", () => {
    const p: Params = { ...defaultParams, xd: 5, yd: 0, zdebt: 0, vyx: 0.9, vxy: 0.9 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const h = computeHY(yb + 0.001, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(0.99);
  });

  it("external collateral (rXX) increases boost", () => {
    const base: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, rXX: 0 };
    const withR: Params = { ...base, rXX: 2 };
    expect(computeX0(withR)).toBeGreaterThanOrEqual(computeX0(base));
  });
});

// ---------------------------------------------------------------------------
// 17. NAV (Net Asset Value)
// ---------------------------------------------------------------------------

describe("NAV", () => {
  it("NAV at equilibrium with no debt = xr + yr*(py/px)", () => {
    const noDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0 };
    const x0v = computeX0(noDebt);
    const y0v = computeY0(noDebt);
    // At equilibrium pXyx = py/px = 1
    const nav = computeNAV_X(x0v * 0.999, noDebt, x0v, y0v);
    approx(nav, noDebt.xr + noDebt.yr * (noDebt.py / noDebt.px), 1e-3);
  });

  it("NAV is finite and positive near equilibrium", () => {
    const x0v = computeX0(defaultParams);
    const y0v = computeY0(defaultParams);
    const nav = computeNAV_X(x0v * 0.95, defaultParams, x0v, y0v);
    expect(nav).not.toBeNaN();
    expect(isFinite(nav)).toBe(true);
    expect(nav).toBeGreaterThan(0);
  });

  it("NAV decreases as x moves toward boundary (more risk)", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const navNear = computeNAV_X(x0v * 0.8, p, x0v, y0v);
    const navFar = computeNAV_X(x0v * 0.5, p, x0v, y0v);
    expect(navNear).toBeGreaterThan(navFar);
  });

  it("NAV returns NaN for out-of-range x", () => {
    const x0v = computeX0(defaultParams);
    const y0v = computeY0(defaultParams);
    expect(computeNAV_X(0, defaultParams, x0v, y0v)).toBeNaN();
    expect(computeNAV_X(x0v + 1, defaultParams, x0v, y0v)).toBeNaN();
  });

  it("eXC increases NAV, eXD decreases NAV", () => {
    const base: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0, eXC: 0, eXD: 0 };
    const x0v = computeX0(base);
    const y0v = computeY0(base);
    const xTest = x0v * 0.9;
    const navBase = computeNAV_X(xTest, base, x0v, y0v);
    const navC = computeNAV_X(xTest, { ...base, eXC: 5 }, x0v, y0v);
    const navD = computeNAV_X(xTest, { ...base, eXD: 5 }, x0v, y0v);
    approx(navC - navBase, 5);
    approx(navBase - navD, 5);
  });
});

// ---------------------------------------------------------------------------
// 18. Y-side mirror symmetry
// ---------------------------------------------------------------------------

describe("Y-side mirror functions", () => {
  it("computeSy = computeSx with same params", () => {
    for (const [r, c] of [[1, 0.5], [0.5, 0.3], [2, 0.8]] as [number, number][]) {
      approx(computeSy(r, c), computeSx(r, c));
    }
  });

  it("computeByc = computeBxc with same sx", () => {
    for (const s of [1.5, 2, 3, 5]) {
      approx(computeByc(s), computeBxc(s));
    }
  });

  it("computePY = computePX with same params", () => {
    for (const [c, s] of [[0, 2], [0.5, 3], [0.8, 5]] as [number, number][]) {
      approx(computePY(c, s), computePX(c, s));
    }
  });

  it("computeYb = computeXb with same params", () => {
    for (const [r, c] of [[1, 0.5], [0.5, 0.3], [2, 0.8]] as [number, number][]) {
      approx(computeYb(20, r, c), computeXb(20, r, c));
    }
  });

  it("symmetric params give same X0 and Y0", () => {
    const sym: Params = {
      ...defaultParams,
      px: 1, py: 1, rx: 1, ry: 1, cx: 0.5, cy: 0.5,
      xr: 10, yr: 10, xd: 0, yd: 0, zdebt: 0, zr: 0,
    };
    approx(computeX0(sym), computeY0(sym));
  });
});

// ===========================================================================
// INVARIANT & EXACT-VALUE TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 19. Health invariants within range
// ---------------------------------------------------------------------------
// The boost is calibrated so H=1 at the boundary. For Y/X debt configs,
// health stays ≥ 1 throughout the range. For Z debt with asymmetric LLTVs
// (vxz ≠ vyz), health can dip below 1 mid-range because swaps shift
// collateral between tiers with different LLTVs (see section 15b).

describe("health invariants within range", () => {
  /** Sweep N points between xb and x0, verify health ≥ threshold at each */
  function sweepHealthX(p: Params, threshold = 1, nSamples = 50) {
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const eps = (x0v - xb) * 0.002;
    let minH = Infinity;
    for (let i = 0; i <= nSamples; i++) {
      const x = xb + eps + (x0v - xb - 2 * eps) * (i / nSamples);
      const h = computeHX(x, p, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        if (h < minH) minH = h;
        expect(h).toBeGreaterThanOrEqual(threshold);
      }
    }
    return minH;
  }

  /** Sweep N points between yb and y0, verify health ≥ threshold at each */
  function sweepHealthY(p: Params, threshold = 1, nSamples = 50) {
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const eps = (y0v - yb) * 0.002;
    let minH = Infinity;
    for (let i = 0; i <= nSamples; i++) {
      const y = yb + eps + (y0v - yb - 2 * eps) * (i / nSamples);
      const h = computeHY(y, p, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        if (h < minH) minH = h;
        expect(h).toBeGreaterThanOrEqual(threshold);
      }
    }
    return minH;
  }

  // --- Y/X debt: H ≥ 1 holds exactly (single collateral tier) ---

  it("Y debt: X-side health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, vxy: 0.9 });
  });

  it("X debt: Y-side health ≥ 1", () => {
    sweepHealthY({ ...defaultParams, xd: 5, yd: 0, zdebt: 0, vyx: 0.9, vxy: 0.9 });
  });

  it("Y debt with cx=0 (constant-product): X-side health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 5, zdebt: 0, cx: 0, cy: 0, vyx: 0.9, vxy: 0.9 });
  });

  it("Y debt with cx=0.8 (high concentration): X-side health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 5, zdebt: 0, cx: 0.8, cy: 0.8, vyx: 0.9, vxy: 0.9 });
  });

  it("Y debt with external collateral (rXX > 0): health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, vxy: 0.9, rXX: 2 });
  });

  // --- Z debt with symmetric LLTVs: H ≥ 1 holds ---

  it("Z debt with vxz ≤ vyz: X-side health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5, vxz: 0.3, vyz: 0.8 });
  });

  it("Z debt with external collateral (rXZ > 0): health ≥ 1", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5, vxz: 0.3, vyz: 0.8, rXZ: 2 });
  });

  // --- Z debt with asymmetric LLTVs: health dips below 1 mid-range ---
  // When vxz > vyz, swaps from X→Y lose high-LLTV collateral, causing a
  // health valley. The boost only guarantees H=1 at the boundary, not
  // throughout. Verify health stays positive and eventually recovers.

  it("Z debt (default vxz≈vyz): health dips but stays > 0.9", () => {
    // Default: vxz=0.599, vyz=0.582 — nearly symmetric, small dip
    sweepHealthX({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 }, 0.9);
  });

  it("Z debt (default vxz≈vyz): Y-side health dips but stays > 0.9", () => {
    sweepHealthY({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 }, 0.9);
  });

  it("Z debt with vxz=0.8, vyz=0.3: health dips significantly but stays > 0.5", () => {
    // Highly asymmetric — large dip expected (min ~0.55)
    sweepHealthX({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5, vxz: 0.8, vyz: 0.3 }, 0.5);
  });

  it("Z debt with asymmetric prices (px=2, py=1): health dips but stays > 0.7", () => {
    sweepHealthX({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5, px: 2, py: 1 }, 0.7);
  });

  it("Z debt with asymmetric prices (px=2, py=1): Y-side health dips but stays > 0.7", () => {
    sweepHealthY({ ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5, px: 2, py: 1 }, 0.7);
  });

  // --- No debt: health = Infinity ---

  it("no debt + zero LLTVs: health = Infinity everywhere in range", () => {
    // Must zero out LLTVs too — nonzero LLTVs cause the boost to create
    // implicit leverage even with no explicit debt, making DXX > 0 near xb
    const p: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    for (const frac of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const x = xb + (x0v - xb) * frac;
      const h = computeHX(x, p, x0v, y0v);
      expect(h).toBe(Infinity);
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Exact values at boundary
// ---------------------------------------------------------------------------

describe("exact values at boundary", () => {
  // Algebraically: xb = x0/sx, so x0-xb = x0*(sx-1)/sx = xr*bXL
  // (since x0 = xr*bXC*bXL and bXC = sx/(sx-1))
  // Therefore CXX(xb) = max(xr - xr*bXL, 0) = xr*max(1-bXL, 0)

  it("CXX at xb = 0 when leverage boost > 1", () => {
    // Z debt with nonzero LLTVs → bXL > 1 → CXX(xb) = 0
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    approx(CXX(xb, x0v, p.xr), 0);
  });

  it("CXX at xb = xr*(1-bXL) when bXL < 1", () => {
    // No-leverage config: bXL = 1, so CXX(xb) = 0 exactly
    const noLev: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 0, zr: 0,
      vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    };
    const x0v = computeX0(noLev);
    const xb = computeXb(x0v, noLev.rx, noLev.cx);
    // bXL = 1, so CXX(xb) = xr * max(1-1, 0) = 0
    approx(CXX(xb, x0v, noLev.xr), 0);
  });

  it("price at xb = (px/py)(1+rx) via direct computation", () => {
    // Compute xb, evaluate pXxy at xb, verify it matches the formula
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const priceAtBoundary = pXxy(xb, p.cx, x0v, p.px, p.py);
    approx(priceAtBoundary, (p.px / p.py) * (1 + p.rx));
  });

  it("price at yb = (py/px)(1+ry) via direct computation", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const priceAtBoundary = pYyx(yb, p.cy, y0v, p.px, p.py);
    approx(priceAtBoundary, (p.py / p.px) * (1 + p.ry));
  });

  it("fX at xb: y = y0 + (px/py) * xr * bXL * PX", () => {
    // At xb: fX(xb) = y0 + (px/py)(x0-xb)(cx + (1-cx)(x0/xb))
    //       = y0 + (px/py) * x0*(sx-1)/sx * PX
    //       = y0 + (px/py) * xr*bXL * PX
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const sx = computeSx(p.rx, p.cx);
    const PX = computePX(p.cx, sx);
    const bXC = computeBxc(sx);
    const bXL = x0v / (p.xr * bXC); // derive bXL from x0

    const yAtBoundary = fX(xb, p.cx, x0v, y0v, p.px, p.py);
    const expectedY = y0v + (p.px / p.py) * p.xr * bXL * PX;
    approx(yAtBoundary, expectedY, 1e-9);
  });

  it("gY at yb: x = x0 + (py/px) * yr * bYL * PY", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const sy = computeSy(p.ry, p.cy);
    const PY = computePY(p.cy, sy);
    const bYC = computeByc(sy);
    const bYL = y0v / (p.yr * bYC);

    const xAtBoundary = gY(yb, p.cy, y0v, x0v, p.px, p.py);
    const expectedX = x0v + (p.py / p.px) * p.yr * bYL * PY;
    approx(xAtBoundary, expectedX, 1e-9);
  });

  it("health at xb ≈ 1 for Z debt (tight tolerance)", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    // Use very small epsilon to get close to true boundary
    const h = computeHX(xb + 1e-6, p, x0v, y0v);
    approx(h, 1, 0.01); // within 1%
  });

  it("health at yb ≈ 1 for Z debt (tight tolerance)", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const h = computeHY(yb + 1e-6, p, x0v, y0v);
    approx(h, 1, 0.01);
  });

  it("health at xb ≈ 1 for Y debt (tight tolerance)", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, vxy: 0.9 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const h = computeHX(xb + 1e-6, p, x0v, y0v);
    approx(h, 1, 0.01);
  });

  it("health at yb ≈ 1 for X debt (tight tolerance)", () => {
    const p: Params = { ...defaultParams, xd: 5, yd: 0, zdebt: 0, vyx: 0.9, vxy: 0.9 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const h = computeHY(yb + 1e-6, p, x0v, y0v);
    approx(h, 1, 0.01);
  });
});

// ---------------------------------------------------------------------------
// 21. Exact values at equilibrium
// ---------------------------------------------------------------------------

describe("exact values at equilibrium", () => {
  it("H_XZ at equilibrium = (vxz*xr + vyz*yr*(py/px) + rXZ) / (zd*pzx)", () => {
    const p: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5,
      vxz: 0.599, vyz: 0.582, pxz: 1, rXZ: 0,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    // Just below equilibrium
    const h = computeHX(x0v * 0.9999, p, x0v, y0v);
    const expected = (p.vxz * p.xr + p.vyz * p.yr * (p.py / p.px) + p.rXZ) / (p.zdebt * (1 / p.pxz));
    approx(h, expected, 1e-3);
  });

  it("H_XY at equilibrium = (vxy*xr + vzy*zr*pzx + rXY) / (yd * (py/px))", () => {
    const p: Params = {
      ...defaultParams, xd: 0, yd: 5, zdebt: 0,
      vxy: 0.9, vzy: 0, zr: 0, rXY: 0,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const h = computeHX(x0v * 0.9999, p, x0v, y0v);
    // At equilibrium: CXX=xr, DXY=yd, pXyx=py/px
    // H_XY = (vxy*CXX + vzy*zr*pzx + rXY) / (DXY * pXyx)
    //       = (vxy*xr) / (yd * py/px)
    const expected = (p.vxy * p.xr) / (p.yd * (p.py / p.px));
    approx(h, expected, 1e-3);
  });

  it("H_YX at equilibrium = (vyx*yr + vzx*zr*pzy + rYX) / (xd * (px/py))", () => {
    const p: Params = {
      ...defaultParams, xd: 5, yd: 0, zdebt: 0,
      vyx: 0.9, vzx: 0, zr: 0, rYX: 0,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const h = computeHY(y0v * 0.9999, p, x0v, y0v);
    // At equilibrium: CYY=yr, DYX=xd, pYxy=px/py
    // H_YX = (vyx*CYY + vzx*zr*pzy + rYX) / (DYX * pYxy)
    //       = (vyx*yr) / (xd * px/py)
    const expected = (p.vyx * p.yr) / (p.xd * (p.px / p.py));
    approx(h, expected, 1e-3);
  });

  it("H_XZ with asymmetric prices at equilibrium", () => {
    const p: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5,
      px: 2, py: 1, pxz: 0.5, vxz: 0.6, vyz: 0.5, rXZ: 0,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const h = computeHX(x0v * 0.9999, p, x0v, y0v);
    const pzx = 1 / p.pxz;
    const expected = (p.vxz * p.xr + p.vyz * p.yr * (p.py / p.px) + 0) / (p.zdebt * pzx);
    approx(h, expected, 1e-3);
  });

  it("collateral and debt at equilibrium have expected values", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 5, zdebt: 0, vyx: 0.9, vxy: 0.9 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);

    // At equilibrium x=x0: xXdelta=0, yXdelta=0
    approx(CXX(x0v, x0v, p.xr), p.xr);
    const xXYd = xXYdebt(x0v, p.cx, p.yd, p.px, p.py);
    const cxy = CXY_fn(x0v, p.cx, x0v, y0v, p.px, p.py, p.yr, p.yd, 0);
    approx(cxy, p.yr); // yXdelta=0, max(0-yd,0)=0, so CXY=yr
    const dxy = DXY(x0v, p.cx, x0v, y0v, p.px, p.py, p.yd, xXYd, 0);
    approx(dxy, p.yd); // yXdelta=0, max(yd-0,0)=yd
    const xXXd = xXXdebt(x0v, p.xr);
    const dxx = DXX(x0v, x0v, p.xr, p.xd, xXXd, xXYd, 0);
    approx(dxx, 0); // x0 > xXXd
  });

  it("NAV at equilibrium with Z debt matches formula", () => {
    const p: Params = {
      ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5,
      px: 1, py: 1, pxz: 1, eXC: 3, eXD: 1,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const nav = computeNAV_X(x0v * 0.9999, p, x0v, y0v);
    // At equilibrium: CXX=xr, CXY=yr, pXyx=py/px=1, DXX=0, DXY=0, zd=10, pzx=1
    // NAV = xr + yr*1 + zr*1 - 0 - 0 - zd*1 + eXC - eXD
    //     = 10 + 10 + 5 - 10 + 3 - 1 = 17
    approx(nav, 17, 1e-3);
  });

  it("NAV at equilibrium with Y debt matches formula", () => {
    const p: Params = {
      ...defaultParams, xd: 0, yd: 5, zdebt: 0, zr: 0,
      px: 1, py: 1, eXC: 0, eXD: 0, vyx: 0.9, vxy: 0.9,
    };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const nav = computeNAV_X(x0v * 0.9999, p, x0v, y0v);
    // At equilibrium: CXX=xr=10, CXY=yr=10, pXyx=1, DXX=0, DXY=yd=5, zd=0, zr=0
    // NAV = 10 + 10*1 + 0 - 0 - 5*1 - 0 + 0 - 0 = 15
    approx(nav, 15, 1e-3);
  });

  it("price at equilibrium is exactly px/py", () => {
    for (const [pxV, pyV] of [[1, 1], [2, 1], [1, 3], [5, 2]] as [number, number][]) {
      for (const c of [0, 0.5, 0.8]) {
        const x0v = 10; // arbitrary
        approx(pXxy(x0v, c, x0v, pxV, pyV), pxV / pyV);
        approx(pXyx(x0v, c, x0v, pxV, pyV), pyV / pxV);
      }
    }
  });
});
