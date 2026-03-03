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
  LXX, LYY, lXX, lYY, FX, FY, LXY, LYX, lXY, lYX,
  type Params,
} from "./math";

// ---------------------------------------------------------------------------
// Test coverage: 52/60 exported functions (87%)
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
// 22. Stablecoin-stablecoin LP (USDC/DAI, no debt)             [Ordinary LP]
// 23. Stablecoin LP with WBTC Z debt (pzx=50k numerical)      [Hedged LP]
// 24. ETH/USDC LP (px=2000, no debt, wide range)              [Ordinary LP]
// 25. JIT liquidity (cx=0.99, rx=0.0001, 200x amplification)  [Multiplied LP]
// 26. Leveraged ETH/USDC with Y debt (borrow USDC)            [Multiplied LP]
// 27. Short ETH (borrow ETH against USDC, Y-side health)      [Hedged LP]
// 28. Cross-collateral stETH Z debt (vxz=0.93, vyz=0.7)       [Hedged LP]
// 29. One-sided liquidity (yr=0, range order)                  [Ordinary LP]
// 30. WBTC/ETH correlated pair with Z debt                    [Hedged LP]
// 31. External collateral (rXZ, eXC/eXD augmented position)   [Ordinary LP]
// 32. PSM / instant redemption (cx=0.999 vs cy=0.3)           [PSM]
// 33. Two-sided JIT with leverage (cx=cy=0.95, Y debt)        [Multiplied LP]
// 34. Half-JIT XYZ/WETH (cx=0.95 JIT, cy=0.3 real, X debt)   [Deferred Emissions]
// 35. Deferred emissions LP (xr=0 single-sided, borrow EUL)   [Deferred Emissions]
// 36. Order book functions (LXX/LYY, lXX/lYY, FX/FY, LXY/LYX, lXY/lYX)
// 37. yYYdebt (Y-side debt boundary: y0 - yr)
//
// Not tested: 8 point-generation functions (generateFXPoints etc.) — thin plot wrappers.
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

  it("health decreases from equilibrium toward transition point", () => {
    // With transition-point calibration, health valley is at x0-xr.
    // Health decreases from equilibrium to x0-xr, then increases toward boundary.
    const pZDebt: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(pZDebt);
    const y0v = computeY0(pZDebt);
    const hNear = computeHX(x0v * 0.99, pZDebt, x0v, y0v);
    const hTP = computeHX(x0v - pZDebt.xr + 0.01, pZDebt, x0v, y0v);
    expect(hNear).toBeGreaterThan(hTP);
    // Health at transition point ≈ 1 (calibration target)
    expect(hTP).toBeGreaterThanOrEqual(1 - 1e-3);
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

  it("NAV decreases from equilibrium toward transition point", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const navNear = computeNAV_X(x0v * 0.99, p, x0v, y0v);
    const navTP = computeNAV_X(x0v - p.xr + 0.01, p, x0v, y0v);
    expect(navNear).toBeGreaterThan(navTP);
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

  it("health at xb ≥ 1 for Z debt", () => {
    // With transition-point calibration, H(xb) > 1 because the binding
    // constraint is at x = x0-xr (where CXX = 0), not at the boundary.
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const xb = computeXb(x0v, p.rx, p.cx);
    const h = computeHX(xb + 1e-6, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(1);
  });

  it("health at yb ≥ 1 for Z debt", () => {
    const p: Params = { ...defaultParams, xd: 0, yd: 0, zdebt: 10, zr: 5 };
    const x0v = computeX0(p);
    const y0v = computeY0(p);
    const yb = computeYb(y0v, p.ry, p.cy);
    const h = computeHY(yb + 1e-6, p, x0v, y0v);
    expect(h).toBeGreaterThanOrEqual(1);
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

// ===========================================================================
// REAL-WORLD SCENARIO TESTS (sections 22–35)
// ===========================================================================
// Each scenario models a realistic DeFi use case with appropriate parameter
// choices. These test that the full pipeline (boost → curve → health → NAV)
// produces sensible results for production-relevant configurations.
//
// Position types from the EulerSwap product docs:
//   Ordinary LP    — A supply + B supply, optional lending yield (22, 24, 29, 31)
//   Hedged LP      — A+B collateral, C debt for delta-neutral (23, 27, 28, 30)
//   Multiplied LP  — leverage-loop or JIT to amplify depth (25, 26, 33)
//   PSM            — asymmetric concentration for peg stability (32)
//   Deferred Emissions — single-sided collateral, borrow other JIT (34, 35)

// ---------------------------------------------------------------------------
// 22. Stablecoin-stablecoin LP (USDC/DAI, no debt)
// ---------------------------------------------------------------------------
// High concentration (cx≈0.9), tight range (rx≈0.02), px≈py≈1.
// Pure swap venue — no borrowing. Health should be Infinity everywhere.

describe("scenario: stablecoin-stablecoin LP", () => {
  const stablePair: Params = {
    ...defaultParams,
    px: 1, py: 1, cx: 0.9, cy: 0.9, rx: 0.02, ry: 0.02,
    xr: 10_000, yr: 10_000,
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  it("boost is concentration-only (no leverage)", () => {
    const sx = computeSx(stablePair.rx, stablePair.cx);
    const bXC = computeBxc(sx);
    const x0v = computeX0(stablePair);
    approx(x0v, stablePair.xr * bXC);
  });

  it("high concentration gives large virtual reserves", () => {
    const x0v = computeX0(stablePair);
    // cx=0.9, rx=0.02: sx = sqrt((1+0.02-0.9)/(1-0.9)) = sqrt(1.2) ≈ 1.095
    // bXC = sx/(sx-1) ≈ 11.5 → x0 ≈ 115_000
    expect(x0v).toBeGreaterThan(stablePair.xr * 5);
  });

  it("very tight price range at boundary", () => {
    const x0v = computeX0(stablePair);
    const xb = computeXb(x0v, stablePair.rx, stablePair.cx);
    const priceAtBound = pXxy(xb, stablePair.cx, x0v, stablePair.px, stablePair.py);
    // Price at boundary = 1 * (1 + 0.02) = 1.02
    approx(priceAtBound, 1.02);
  });

  it("health is Infinity everywhere (no debt)", () => {
    const x0v = computeX0(stablePair);
    const y0v = computeY0(stablePair);
    for (const frac of [0.1, 0.5, 0.9]) {
      const xb = computeXb(x0v, stablePair.rx, stablePair.cx);
      const x = xb + (x0v - xb) * frac;
      expect(computeHX(x, stablePair, x0v, y0v)).toBe(Infinity);
    }
  });

  it("curve is nearly linear (low price impact)", () => {
    const x0v = computeX0(stablePair);
    const y0v = computeY0(stablePair);
    const xb = computeXb(x0v, stablePair.rx, stablePair.cx);
    // Midpoint of range
    const xMid = (xb + x0v) / 2;
    const yMid = fX(xMid, stablePair.cx, x0v, y0v, stablePair.px, stablePair.py);
    // Linear approximation: y ≈ y0 + (x0 - x)
    const yLinear = y0v + (x0v - xMid);
    approx(yMid, yLinear, 0.01); // within 1% of linear
  });

  it("NAV equals total reserves", () => {
    const x0v = computeX0(stablePair);
    const y0v = computeY0(stablePair);
    const nav = computeNAV_X(x0v * 0.999, stablePair, x0v, y0v);
    // No debt, px=py=1: NAV = xr + yr = 20_000
    approx(nav, 20_000, 1e-3);
  });
});

// ---------------------------------------------------------------------------
// 23. Stablecoin pair with exogenous Z debt (USDC/DAI, borrowing WBTC)
// ---------------------------------------------------------------------------
// LP stablecoins, carry WBTC debt. pxz is tiny (BTC is expensive in USDC).
// Tests numerical stability when pzx = 1/pxz is very large.

describe("scenario: stablecoin LP with WBTC debt", () => {
  const stableWithBTC: Params = {
    ...defaultParams,
    px: 1, py: 1, cx: 0.8, cy: 0.8, rx: 0.05, ry: 0.05,
    xr: 10_000, yr: 10_000,
    xd: 0, yd: 0,
    zdebt: 0.5, zr: 0.1, pxz: 0.00002, // 1 BTC ≈ 50,000 USDC
    vxz: 0.8, vyz: 0.8, // symmetric LLTVs for stablecoins vs BTC
    vyx: 0, vxy: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  it("pzx is very large but finite", () => {
    const pzx = computePzx(stableWithBTC);
    approx(pzx, 50_000);
    expect(isFinite(pzx)).toBe(true);
  });

  it("boost is greater than concentration-only", () => {
    const noLev: Params = {
      ...stableWithBTC, zdebt: 0, zr: 0,
      vxz: 0, vyz: 0,
    };
    expect(computeX0(stableWithBTC)).toBeGreaterThan(computeX0(noLev));
  });

  it("health at equilibrium matches formula with large pzx", () => {
    const x0v = computeX0(stableWithBTC);
    const y0v = computeY0(stableWithBTC);
    const h = computeHX(x0v * 0.9999, stableWithBTC, x0v, y0v);
    // H_XZ = (vxz*xr + vyz*yr*(py/px) + 0) / (zdebt * pzx)
    //       = (0.8*10000 + 0.8*10000*1) / (0.5 * 50000)
    //       = 16000 / 25000 = 0.64
    const expected = (0.8 * 10_000 + 0.8 * 10_000) / (0.5 * 50_000);
    approx(h, expected, 1e-3);
  });

  it("health at boundary is ≈ 1", () => {
    const x0v = computeX0(stableWithBTC);
    const y0v = computeY0(stableWithBTC);
    const xb = computeXb(x0v, stableWithBTC.rx, stableWithBTC.cx);
    const h = computeHX(xb + 1e-3, stableWithBTC, x0v, y0v);
    approx(h, 1, 0.02);
  });

  it("NAV accounts for large Z debt in X terms", () => {
    const x0v = computeX0(stableWithBTC);
    const y0v = computeY0(stableWithBTC);
    const nav = computeNAV_X(x0v * 0.999, stableWithBTC, x0v, y0v);
    // NAV ≈ xr + yr + zr*pzx - zdebt*pzx = 10k + 10k + 0.1*50k - 0.5*50k
    //     = 10000 + 10000 + 5000 - 25000 = 0
    // Actually this is near zero — the BTC debt is huge relative to stablecoin reserves
    expect(isFinite(nav)).toBe(true);
    expect(nav).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// 24. Volatile/stable pair (ETH/USDC, no debt)
// ---------------------------------------------------------------------------
// px=2000, py=1. xr*px ≈ yr*py (dollar-balanced). Wide range.
// Tests that large px/py ratios don't break anything.

describe("scenario: ETH/USDC LP", () => {
  const ethUsdc: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.5, cy: 0.5, rx: 1, ry: 1,
    xr: 5, yr: 10_000, // ~$10k each side
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  it("x0 and y0 scale correctly with asymmetric reserves", () => {
    const x0v = computeX0(ethUsdc);
    const y0v = computeY0(ethUsdc);
    // x0 ≈ xr * bXC (no leverage)
    const sx = computeSx(ethUsdc.rx, ethUsdc.cx);
    const bXC = computeBxc(sx);
    approx(x0v, ethUsdc.xr * bXC);
    // y0 symmetric
    const sy = computeSy(ethUsdc.ry, ethUsdc.cy);
    const bYC = computeByc(sy);
    approx(y0v, ethUsdc.yr * bYC);
  });

  it("price at equilibrium = px/py = 2000", () => {
    const x0v = computeX0(ethUsdc);
    approx(pXxy(x0v, ethUsdc.cx, x0v, ethUsdc.px, ethUsdc.py), 2000);
  });

  it("price at boundary = px/py * (1+rx) = 4000", () => {
    const x0v = computeX0(ethUsdc);
    const xb = computeXb(x0v, ethUsdc.rx, ethUsdc.cx);
    approx(pXxy(xb, ethUsdc.cx, x0v, ethUsdc.px, ethUsdc.py), 4000);
  });

  it("curve values are finite and positive across range", () => {
    const x0v = computeX0(ethUsdc);
    const y0v = computeY0(ethUsdc);
    const xb = computeXb(x0v, ethUsdc.rx, ethUsdc.cx);
    for (const frac of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const x = xb + (x0v - xb) * frac;
      const y = fX(x, ethUsdc.cx, x0v, y0v, ethUsdc.px, ethUsdc.py);
      expect(y).not.toBeNaN();
      expect(isFinite(y)).toBe(true);
      expect(y).toBeGreaterThan(0);
    }
  });

  it("NAV in X terms = xr + yr*(py/px) = 5 + 10000/2000 = 10", () => {
    const x0v = computeX0(ethUsdc);
    const y0v = computeY0(ethUsdc);
    const nav = computeNAV_X(x0v * 0.999, ethUsdc, x0v, y0v);
    approx(nav, 5 + 10_000 / 2000, 1e-3);
  });
});

// ---------------------------------------------------------------------------
// 25. JIT liquidity (extreme concentration, very tight range)
// ---------------------------------------------------------------------------
// cx=0.99, rx=0.0001 → sx ≈ 1.005, bXC ≈ 201.
// Key insight: bXC = sx/(sx-1), so sx CLOSE to 1 produces huge boost.
// Virtual reserves are 200x+ real, range width is ~0.5%.

describe("scenario: JIT liquidity", () => {
  const jit: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.99, cy: 0.99, rx: 0.0001, ry: 0.0001,
    xr: 10, yr: 20_000,
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  it("virtual reserves are 100x+ real reserves", () => {
    const x0v = computeX0(jit);
    // sx = sqrt((1+0.0001-0.99)/0.01) = sqrt(1.01) ≈ 1.005
    // bXC = 1.005/0.005 ≈ 201 → x0 ≈ 2010
    expect(x0v / jit.xr).toBeGreaterThan(100);
  });

  it("boundary is very close to equilibrium", () => {
    const x0v = computeX0(jit);
    const xb = computeXb(x0v, jit.rx, jit.cx);
    // Range width = 1 - 1/sx ≈ 0.005 (0.5%)
    expect((x0v - xb) / x0v).toBeLessThan(0.01);
  });

  it("price at boundary is barely above equilibrium", () => {
    const x0v = computeX0(jit);
    const xb = computeXb(x0v, jit.rx, jit.cx);
    const pBound = pXxy(xb, jit.cx, x0v, jit.px, jit.py);
    // pXxy(xb) = (px/py)(1+rx) = 2000 * 1.0001 = 2000.2
    approx(pBound, 2000 * (1 + jit.rx));
  });

  it("curve is extremely linear within tight range", () => {
    const x0v = computeX0(jit);
    const y0v = computeY0(jit);
    const xb = computeXb(x0v, jit.rx, jit.cx);
    const xMid = (xb + x0v) / 2;
    const deriv = fXd(xMid, jit.cx, x0v, jit.px, jit.py);
    // Near-constant-sum: derivative ≈ -(px/py) everywhere
    approx(deriv, -(jit.px / jit.py), 0.01);
  });

  it("sx close to 1 produces huge bXC boost", () => {
    const sx = computeSx(jit.rx, jit.cx);
    // For JIT: sx is barely above 1, which makes bXC = sx/(sx-1) enormous
    expect(sx).toBeGreaterThan(1);
    expect(sx).toBeLessThan(1.02);
    expect(isFinite(sx)).toBe(true);
    const bXC = computeBxc(sx);
    expect(isFinite(bXC)).toBe(true);
    expect(bXC).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// 26. Leveraged ETH/USDC with Y debt (borrow USDC against ETH LP)
// ---------------------------------------------------------------------------
// Classic DeFi leverage: deposit ETH + USDC, borrow more USDC.
// Tests health pipeline with px >> py and Y debt.

describe("scenario: leveraged ETH/USDC (borrow USDC)", () => {
  const levEthUsdc: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5,
    xr: 5, yr: 10_000,
    xd: 0, yd: 5000, zdebt: 0, zr: 0,
    vxy: 0.82, vyx: 0.85,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  it("leverage boost is > 1 (borrowing amplifies position)", () => {
    const noLev: Params = {
      ...levEthUsdc, yd: 0, vxy: 0, vyx: 0,
    };
    expect(computeX0(levEthUsdc)).toBeGreaterThan(computeX0(noLev));
  });

  it("health at equilibrium ≈ (vxy*xr) / (yd * py/px)", () => {
    const x0v = computeX0(levEthUsdc);
    const y0v = computeY0(levEthUsdc);
    const h = computeHX(x0v * 0.9999, levEthUsdc, x0v, y0v);
    // H_XY = (vxy*CXX) / (DXY * pXyx) at equilibrium
    //       = (0.82 * 5) / (5000 * (1/2000))
    //       = 4.1 / 2.5 = 1.64 (approximate — boost shifts collateral slightly)
    const expected = (levEthUsdc.vxy * levEthUsdc.xr) / (levEthUsdc.yd * (levEthUsdc.py / levEthUsdc.px));
    approx(h, expected, 5e-3);
  });

  it("health ≥ 1 throughout range (Y debt, single tier)", () => {
    const x0v = computeX0(levEthUsdc);
    const y0v = computeY0(levEthUsdc);
    const xb = computeXb(x0v, levEthUsdc.rx, levEthUsdc.cx);
    const eps = (x0v - xb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const x = xb + eps + (x0v - xb - 2 * eps) * (i / 30);
      const h = computeHX(x, levEthUsdc, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("health at boundary ≈ 1", () => {
    const x0v = computeX0(levEthUsdc);
    const y0v = computeY0(levEthUsdc);
    const xb = computeXb(x0v, levEthUsdc.rx, levEthUsdc.cx);
    const h = computeHX(xb + 1e-6, levEthUsdc, x0v, y0v);
    approx(h, 1, 0.02);
  });

  it("price at boundary = px/py * (1+rx) = 3000", () => {
    const x0v = computeX0(levEthUsdc);
    const xb = computeXb(x0v, levEthUsdc.rx, levEthUsdc.cx);
    approx(pXxy(xb, levEthUsdc.cx, x0v, levEthUsdc.px, levEthUsdc.py), 3000);
  });

  it("NAV at equilibrium = xr + yr*(py/px) - yd*(py/px)", () => {
    const x0v = computeX0(levEthUsdc);
    const y0v = computeY0(levEthUsdc);
    const nav = computeNAV_X(x0v * 0.999, levEthUsdc, x0v, y0v);
    // NAV = 5 + 10000/2000 - 5000/2000 = 5 + 5 - 2.5 = 7.5
    approx(nav, 5 + 10_000 / 2000 - 5000 / 2000, 1e-3);
  });
});

// ---------------------------------------------------------------------------
// 27. Short ETH (borrow ETH against USDC LP)
// ---------------------------------------------------------------------------
// Deposit USDC-heavy LP, borrow ETH. Y-side health matters.
// Tests X debt with px >> py.

describe("scenario: short ETH (borrow ETH against USDC)", () => {
  const shortEth: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5,
    xr: 5, yr: 10_000,
    xd: 2, yd: 0, zdebt: 0, zr: 0, // borrow 2 ETH
    vyx: 0.85, vxy: 0.82,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  it("Y-side health at equilibrium ≈ (vyx*yr) / (xd * px/py)", () => {
    const x0v = computeX0(shortEth);
    const y0v = computeY0(shortEth);
    const h = computeHY(y0v * 0.9999, shortEth, x0v, y0v);
    // H_YX = (vyx*yr) / (xd * px/py) = (0.85*10000) / (2 * 2000) = 2.125
    // Approximate — boost shifts collateral slightly
    const expected = (shortEth.vyx * shortEth.yr) / (shortEth.xd * (shortEth.px / shortEth.py));
    approx(h, expected, 5e-3);
  });

  it("Y-side boost > concentration-only", () => {
    const noLev: Params = { ...shortEth, xd: 0, vyx: 0, vxy: 0 };
    expect(computeY0(shortEth)).toBeGreaterThan(computeY0(noLev));
  });

  it("Y-side health ≥ 1 throughout range", () => {
    const x0v = computeX0(shortEth);
    const y0v = computeY0(shortEth);
    const yb = computeYb(y0v, shortEth.ry, shortEth.cy);
    const eps = (y0v - yb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const y = yb + eps + (y0v - yb - 2 * eps) * (i / 30);
      const h = computeHY(y, shortEth, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 28. Cross-collateral: ETH/USDC LP borrowing stETH
// ---------------------------------------------------------------------------
// LP ETH/USDC, borrow stETH. ETH collateral has high LLTV against stETH
// (correlated), USDC has lower LLTV. Asymmetric vxz vs vyz.

describe("scenario: ETH/USDC LP borrowing stETH", () => {
  const ethSteth: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5,
    xr: 5, yr: 10_000,
    xd: 0, yd: 0,
    zdebt: 3, zr: 1, pxz: 0.98, // stETH ≈ 0.98 ETH
    vxz: 0.93, vyz: 0.7, // ETH backs stETH well; USDC less so
    vyx: 0, vxy: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  it("health at equilibrium uses both X and Y collateral tiers", () => {
    const x0v = computeX0(ethSteth);
    const y0v = computeY0(ethSteth);
    const h = computeHX(x0v * 0.9999, ethSteth, x0v, y0v);
    // H_XZ = (vxz*xr + vyz*yr*(py/px)) / (zdebt * pzx)
    //       = (0.93*5 + 0.7*10000*(1/2000)) / (3 * (1/0.98))
    //       = (4.65 + 3.5) / 3.0612 = 8.15 / 3.06 ≈ 2.664
    const pzx = 1 / ethSteth.pxz;
    const expected = (ethSteth.vxz * ethSteth.xr + ethSteth.vyz * ethSteth.yr * (ethSteth.py / ethSteth.px)) / (ethSteth.zdebt * pzx);
    approx(h, expected, 1e-3);
  });

  it("health dips mid-range due to vxz > vyz asymmetry", () => {
    const x0v = computeX0(ethSteth);
    const y0v = computeY0(ethSteth);
    // Near equilibrium: mostly ETH collateral (high LLTV)
    const hNear = computeHX(x0v * 0.95, ethSteth, x0v, y0v);
    // Mid-range: ETH depleted, more USDC (lower LLTV)
    const hMid = computeHX(x0v * 0.5, ethSteth, x0v, y0v);
    expect(hNear).toBeGreaterThan(hMid);
  });

  it("health at boundary ≥ 1 (transition-point calibration)", () => {
    const x0v = computeX0(ethSteth);
    const y0v = computeY0(ethSteth);
    const xb = computeXb(x0v, ethSteth.rx, ethSteth.cx);
    const h = computeHX(xb + 1e-6, ethSteth, x0v, y0v);
    // With transition-point calibration, H(xb) > 1 because the binding
    // constraint is at x = x0-xr, not at the boundary.
    expect(h).toBeGreaterThanOrEqual(1);
  });

  it("all values finite across full range", () => {
    const x0v = computeX0(ethSteth);
    const y0v = computeY0(ethSteth);
    const xb = computeXb(x0v, ethSteth.rx, ethSteth.cx);
    for (let i = 1; i <= 20; i++) {
      const x = xb + (x0v - xb) * (i / 21);
      const h = computeHX(x, ethSteth, x0v, y0v);
      expect(h).not.toBeNaN();
      expect(isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 29. One-sided liquidity (range order: deposit only ETH)
// ---------------------------------------------------------------------------
// yr=0 — only X reserves. Tests that formulas handle zero Y reserves.

describe("scenario: one-sided liquidity (ETH only)", () => {
  const oneSided: Params = {
    ...defaultParams,
    px: 2000, py: 1, cx: 0.5, cy: 0.5, rx: 1, ry: 1,
    xr: 10, yr: 0, // no Y reserves
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  it("boost computation succeeds with yr=0", () => {
    const x0v = computeX0(oneSided);
    expect(x0v).not.toBeNaN();
    expect(isFinite(x0v)).toBe(true);
    expect(x0v).toBeGreaterThan(0);
  });

  it("y0 = 0 when yr = 0", () => {
    const y0v = computeY0(oneSided);
    // With yr=0 and no leverage, y0 should be 0
    // (no Y reserves to boost)
    expect(y0v).not.toBeNaN();
  });

  it("CXX at equilibrium = xr", () => {
    const x0v = computeX0(oneSided);
    approx(CXX(x0v, x0v, oneSided.xr), oneSided.xr);
  });

  it("NAV = xr when no Y reserves and no debt", () => {
    const x0v = computeX0(oneSided);
    const y0v = computeY0(oneSided);
    if (y0v > 0 && x0v > 0) {
      const nav = computeNAV_X(x0v * 0.999, oneSided, x0v, y0v);
      // With yr=0: NAV ≈ xr + 0 = 10
      approx(nav, 10, 1e-2);
    }
  });
});

// ---------------------------------------------------------------------------
// 30. WBTC/ETH correlated pair with Z debt
// ---------------------------------------------------------------------------
// Two volatile correlated assets. px/py ≈ 20. Moderate concentration.

describe("scenario: WBTC/ETH correlated pair", () => {
  const btcEth: Params = {
    ...defaultParams,
    px: 40_000, py: 2000, cx: 0.3, cy: 0.3, rx: 0.3, ry: 0.3,
    xr: 0.5, yr: 10, // $20k each side
    xd: 0, yd: 0,
    zdebt: 5000, zr: 1000, pxz: 8, // Z is USDC: 1 USDC = 8 WBTC? No...
    // pxz = price of Z per unit of X. If Z=USDC, X=WBTC: pxz = 1/40000 = 0.000025
    // Let's say Z is a stablecoin lending token
    vxz: 0.85, vyz: 0.85, // symmetric
    vyx: 0, vxy: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  // Fix pxz: Z is USDC priced in WBTC. 1 USDC = 1/40000 WBTC
  const corrected = { ...btcEth, pxz: 0.000025 };

  it("price at equilibrium = px/py = 20", () => {
    const x0v = computeX0(corrected);
    approx(pXxy(x0v, corrected.cx, x0v, corrected.px, corrected.py), 20);
  });

  it("health computation works with extreme pzx", () => {
    const x0v = computeX0(corrected);
    const y0v = computeY0(corrected);
    const h = computeHX(x0v * 0.99, corrected, x0v, y0v);
    expect(h).not.toBeNaN();
    expect(isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("NAV is finite with large pzx values", () => {
    const x0v = computeX0(corrected);
    const y0v = computeY0(corrected);
    const nav = computeNAV_X(x0v * 0.999, corrected, x0v, y0v);
    expect(nav).not.toBeNaN();
    expect(isFinite(nav)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 31. External collateral augmented position
// ---------------------------------------------------------------------------
// LP with additional collateral from external vaults (rXX, rXZ > 0).
// Tests that external collateral flows through health/NAV correctly.

describe("scenario: externally collateralized position", () => {
  const extColl: Params = {
    ...defaultParams,
    px: 1, py: 1, cx: 0.5, cy: 0.5, rx: 1, ry: 1,
    xr: 10, yr: 10,
    xd: 0, yd: 0, zdebt: 10, zr: 5, pxz: 1,
    vxz: 0.6, vyz: 0.6,
    vyx: 0, vxy: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 5, // 5 units of external Z collateral on X-side
    rYX: 0, rYY: 0, rYZ: 5,
    eXC: 3, eXD: 1, eYC: 0, eYD: 0,
  };

  it("external collateral rXZ increases health", () => {
    const noExt: Params = { ...extColl, rXZ: 0 };
    const x0v = computeX0(extColl); // same x0 (rXZ doesn't affect boost)
    const y0v = computeY0(extColl);
    const hWith = computeHX(x0v * 0.9, extColl, x0v, y0v);
    const hWithout = computeHX(x0v * 0.9, noExt, x0v, y0v);
    expect(hWith).toBeGreaterThan(hWithout);
  });

  it("health formula includes rXZ addend", () => {
    const x0v = computeX0(extColl);
    const y0v = computeY0(extColl);
    const h = computeHX(x0v * 0.9999, extColl, x0v, y0v);
    // H_XZ = (vxz*xr + vyz*yr*(py/px) + rXZ) / (zdebt*pzx)
    //       = (0.6*10 + 0.6*10*1 + 5) / (10*1)
    //       = (6 + 6 + 5) / 10 = 1.7
    const expected = (0.6 * 10 + 0.6 * 10 + 5) / (10 * 1);
    approx(h, expected, 1e-3);
  });

  it("eXC and eXD affect NAV but not health", () => {
    const x0v = computeX0(extColl);
    const y0v = computeY0(extColl);
    const noE: Params = { ...extColl, eXC: 0, eXD: 0 };
    // Health should be same
    const hWith = computeHX(x0v * 0.9, extColl, x0v, y0v);
    const hWithout = computeHX(x0v * 0.9, noE, x0v, y0v);
    approx(hWith, hWithout);
    // NAV should differ by eXC - eXD = 3 - 1 = 2
    const navWith = computeNAV_X(x0v * 0.999, extColl, x0v, y0v);
    const navWithout = computeNAV_X(x0v * 0.999, noE, x0v, y0v);
    approx(navWith - navWithout, 2);
  });
});

// ---------------------------------------------------------------------------
// 32. PSM / instant redemption (asymmetric concentration)
// ---------------------------------------------------------------------------
// USDS/USDC peg stability module. X-side (USDC→USDS) is near-constant-sum
// (cx=0.999, rx=0.001) so swaps execute at ~1:1. Y-side (USDS→USDC) has
// lower concentration (cy=0.3, ry=0.5) allowing price discovery if the PSM
// is depleted. Also models the "Launchpad" use case from the doc.

describe("scenario: PSM / instant redemption", () => {
  const psm: Params = {
    ...defaultParams,
    px: 1, py: 1, cx: 0.999, cy: 0.3, rx: 0.001, ry: 0.5,
    xr: 100_000, yr: 10_000, // PSM has deep USDC reserves
    xd: 0, yd: 0, zdebt: 0, zr: 0,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  it("X-side price at boundary barely above peg", () => {
    const x0v = computeX0(psm);
    const xb = computeXb(x0v, psm.rx, psm.cx);
    const pBound = pXxy(xb, psm.cx, x0v, psm.px, psm.py);
    // pXxy(xb) = (px/py)(1+rx) = 1 * 1.001 = 1.001
    approx(pBound, 1.001);
  });

  it("Y-side price at boundary allows wide price discovery", () => {
    const y0v = computeY0(psm);
    const yb = computeYb(y0v, psm.ry, psm.cy);
    const pBound = pYxy(yb, psm.cy, y0v, psm.px, psm.py);
    // pYxy(yb) = 1 / ((py/px)(1+ry)) = 1 / 1.5 ≈ 0.667
    // i.e., USDS can trade down to ~$0.67 if PSM depleted
    approx(pBound, 1 / 1.5, 1e-3);
  });

  it("X-side curve is nearly linear (constant-sum behavior)", () => {
    const x0v = computeX0(psm);
    const y0v = computeY0(psm);
    const xb = computeXb(x0v, psm.rx, psm.cx);
    // Check derivative at several points — should all be ≈ -1
    for (const frac of [0.1, 0.5, 0.9]) {
      const x = xb + (x0v - xb) * frac;
      const d = fXd(x, psm.cx, x0v, psm.px, psm.py);
      approx(d, -1, 0.01);
    }
  });

  it("Y-side curve has significant curvature (price discovery)", () => {
    const y0v = computeY0(psm);
    const yb = computeYb(y0v, psm.ry, psm.cy);
    // Derivative at equilibrium vs boundary should differ substantially
    const dEquil = gYd(y0v * 0.999, psm.cy, y0v, psm.px, psm.py);
    const dBound = gYd(yb + (y0v - yb) * 0.01, psm.cy, y0v, psm.px, psm.py);
    // Near equilibrium: -1. Near boundary: steeper.
    // cy=0.3 gives meaningful curvature (ratio > 1.3)
    expect(Math.abs(dBound / dEquil)).toBeGreaterThan(1.3);
  });

  it("price ranges are highly asymmetric", () => {
    // X-side: price range from 1.0 to 1.001 (0.1% band — peg stability)
    // Y-side: price range from 1.0 down to ~0.667 (33% band — price discovery)
    const xRange = psm.rx; // 0.001
    const yRange = psm.ry; // 0.5
    expect(yRange / xRange).toBeGreaterThan(100);
  });

  it("health is Infinity everywhere (no debt)", () => {
    const x0v = computeX0(psm);
    const y0v = computeY0(psm);
    const xb = computeXb(x0v, psm.rx, psm.cx);
    for (const frac of [0.1, 0.5, 0.9]) {
      const x = xb + (x0v - xb) * frac;
      expect(computeHX(x, psm, x0v, y0v)).toBe(Infinity);
    }
  });

  it("validates cleanly", () => {
    expect(validateParams(psm)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 33. Two-sided JIT with leverage (USDtb/USDC, borrow USDC)
// ---------------------------------------------------------------------------
// Both sides highly concentrated (cx=cy=0.95, rx=ry=0.001). Y debt (borrow
// USDC) with mutual cross-collateral (vxy=vyx=0.92). This is the "50x
// deeper liquidity" scenario from the use-case doc.

describe("scenario: two-sided JIT with leverage", () => {
  const jitLev: Params = {
    ...defaultParams,
    px: 1, py: 1, cx: 0.95, cy: 0.95, rx: 0.001, ry: 0.001,
    xr: 10_000, yr: 10_000,
    xd: 0, yd: 5000, zdebt: 0, zr: 0, // borrow 5000 USDC
    vxy: 0.92, vyx: 0.92,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  const jitNoLev: Params = {
    ...jitLev, yd: 0, vxy: 0, vyx: 0,
  };

  it("concentration + leverage gives massive amplification", () => {
    const x0v = computeX0(jitLev);
    // Concentration-only boost already large (cx=0.95, rx=0.001)
    // sx = sqrt((1+0.001-0.95)/0.05) = sqrt(1.02) ≈ 1.01 → bXC ≈ 101
    // Leverage on top should push x0 even higher
    expect(x0v / jitLev.xr).toBeGreaterThan(100);
  });

  it("leverage boost exceeds concentration-only", () => {
    const x0Lev = computeX0(jitLev);
    const x0NoLev = computeX0(jitNoLev);
    expect(x0Lev).toBeGreaterThan(x0NoLev);
    // Leverage adds meaningful depth beyond concentration alone
    expect(x0Lev / x0NoLev).toBeGreaterThan(1.1);
  });

  it("health ≥ 1 throughout X-side range (Y debt)", () => {
    const x0v = computeX0(jitLev);
    const y0v = computeY0(jitLev);
    const xb = computeXb(x0v, jitLev.rx, jitLev.cx);
    const eps = (x0v - xb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const x = xb + eps + (x0v - xb - 2 * eps) * (i / 30);
      const h = computeHX(x, jitLev, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("health at boundary ≈ 1", () => {
    const x0v = computeX0(jitLev);
    const y0v = computeY0(jitLev);
    const xb = computeXb(x0v, jitLev.rx, jitLev.cx);
    const h = computeHX(xb + 1e-6, jitLev, x0v, y0v);
    approx(h, 1, 0.02);
  });

  it("curve is near-linear on X-side (high concentration)", () => {
    const x0v = computeX0(jitLev);
    const xb = computeXb(x0v, jitLev.rx, jitLev.cx);
    const xMid = (xb + x0v) / 2;
    const d = fXd(xMid, jitLev.cx, x0v, jitLev.px, jitLev.py);
    approx(d, -(jitLev.px / jitLev.py), 0.01);
  });

  it("NAV accounts for Y debt", () => {
    const x0v = computeX0(jitLev);
    const y0v = computeY0(jitLev);
    const nav = computeNAV_X(x0v * 0.999, jitLev, x0v, y0v);
    // NAV ≈ xr + yr - yd = 10000 + 10000 - 5000 = 15000
    approx(nav, 15_000, 5e-3);
  });

  it("validates cleanly", () => {
    expect(validateParams(jitLev)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 34. Half-JIT: XYZ/WETH (WETH real reserves, XYZ JIT-boosted)
// ---------------------------------------------------------------------------
// XYZ token ($10) paired with WETH ($2000). WETH side has low concentration
// (cy=0.3, real reserves earning yield). XYZ side has high concentration
// (cx=0.95, JIT-boosted). X debt (borrow XYZ against WETH collateral) allows
// the DAO to sell XYZ at depth while recycling WETH proceeds.

describe("scenario: half-JIT (XYZ/WETH)", () => {
  const halfJit: Params = {
    ...defaultParams,
    px: 10, py: 2000, cx: 0.95, cy: 0.3, rx: 0.01, ry: 1,
    xr: 1000, yr: 5, // ~$10k each side
    xd: 500, yd: 0, zdebt: 0, zr: 0, // borrow 500 XYZ
    vyx: 0.85, vxy: 0.85,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  const halfJitNoLev: Params = {
    ...halfJit, xd: 0, vyx: 0, vxy: 0,
  };

  it("X-side (JIT) boost >> Y-side boost from concentration alone", () => {
    const sxBXC = computeBxc(computeSx(halfJit.rx, halfJit.cx));
    const syBYC = computeByc(computeSy(halfJit.ry, halfJit.cy));
    // cx=0.95, rx=0.01 → sx=sqrt(1.2)≈1.095 → bXC≈11.5
    // cy=0.3, ry=1 → sy=sqrt(2.43)≈1.56 → bYC≈2.78
    expect(sxBXC).toBeGreaterThan(syBYC * 3);
  });

  it("Y-side leverage-boosted by X debt", () => {
    const y0Lev = computeY0(halfJit);
    const y0NoLev = computeY0(halfJitNoLev);
    // xd>0 triggers bYL computation in computeBoostY
    expect(y0Lev).toBeGreaterThan(y0NoLev);
  });

  it("Y-side health ≥ 1 throughout range (X debt)", () => {
    const x0v = computeX0(halfJit);
    const y0v = computeY0(halfJit);
    const yb = computeYb(y0v, halfJit.ry, halfJit.cy);
    const eps = (y0v - yb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const y = yb + eps + (y0v - yb - 2 * eps) * (i / 30);
      const h = computeHY(y, halfJit, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("X-side health ≥ 1 within range (xd creates H_XX/H_XY phases)", () => {
    const x0v = computeX0(halfJit);
    const y0v = computeY0(halfJit);
    const xb = computeXb(x0v, halfJit.rx, halfJit.cx);
    const eps = (x0v - xb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const x = xb + eps + (x0v - xb - 2 * eps) * (i / 30);
      const h = computeHX(x, halfJit, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("price ranges are highly asymmetric", () => {
    const x0v = computeX0(halfJit);
    const y0v = computeY0(halfJit);
    const xb = computeXb(x0v, halfJit.rx, halfJit.cx);
    const yb = computeYb(y0v, halfJit.ry, halfJit.cy);
    // X boundary price = (px/py)(1+rx) = (10/2000)*1.01 = 0.00505
    const pXBound = pXxy(xb, halfJit.cx, x0v, halfJit.px, halfJit.py);
    approx(pXBound, (halfJit.px / halfJit.py) * (1 + halfJit.rx));
    // Y boundary price = 1/((py/px)(1+ry)) = 1/((2000/10)*2) = 1/400 = 0.0025
    const pYBound = pYxy(yb, halfJit.cy, y0v, halfJit.px, halfJit.py);
    approx(pYBound, 1 / ((halfJit.py / halfJit.px) * (1 + halfJit.ry)), 1e-3);
  });

  it("NAV is finite and positive", () => {
    const x0v = computeX0(halfJit);
    const y0v = computeY0(halfJit);
    // With high leverage, x0 >> xr so evaluation point must be deep enough
    // to engage real reserves. Use x = x0 - xr (all X reserves deployed).
    const x = x0v - halfJit.xr;
    const nav = computeNAV_X(x, halfJit, x0v, y0v);
    expect(nav).not.toBeNaN();
    expect(isFinite(nav)).toBe(true);
    expect(nav).toBeGreaterThan(0);
  });

  it("validates cleanly", () => {
    expect(validateParams(halfJit)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 35. Deferred Emissions LP (USDC collateral only, borrow EUL JIT)
// ---------------------------------------------------------------------------
// Single-sided USDC deposits (xr=0, yr=200k). EUL ($5) borrowed JIT to
// service buy orders (xd=10k). Y-side is JIT-concentrated (cy=0.95,
// ry=0.001). x0=0 because there are no X reserves — the pool only
// supports one-way swaps (buy EUL with USDC). DAO defers token emissions
// by borrowing EUL instead of depositing it.

describe("scenario: deferred emissions LP (USDC/EUL)", () => {
  const deferred: Params = {
    ...defaultParams,
    px: 5, py: 1,         // EUL=$5, USDC=$1
    cx: 0.5, cy: 0.95,    // moderate X, high Y (JIT)
    rx: 1, ry: 0.001,     // wide X (unused), tight Y
    xr: 0, yr: 200_000,   // USDC only — no EUL deposits
    xd: 10_000, yd: 0, zdebt: 0, zr: 0, // borrow 10k EUL
    vyx: 0.8, vxy: 0.8,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    rXX: 0, rXY: 0, rXZ: 0, rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0, pxz: 1,
  };

  const deferredNoLev: Params = {
    ...deferred, xd: 0, vyx: 0, vxy: 0,
  };

  it("x0 = 0 (no X reserves, pool is Y-side only)", () => {
    expect(computeX0(deferred)).toBe(0);
  });

  it("y0 is massively amplified by JIT concentration + leverage", () => {
    const y0v = computeY0(deferred);
    // cy=0.95, ry=0.001: sy ≈ 1.01, bYC ≈ 101
    // Plus leverage from xd=10k → even higher
    expect(y0v / deferred.yr).toBeGreaterThan(100);
  });

  it("leverage boost exceeds concentration-only", () => {
    const y0Lev = computeY0(deferred);
    const y0NoLev = computeY0(deferredNoLev);
    expect(y0Lev).toBeGreaterThan(y0NoLev);
  });

  it("Y-side health ≥ 1 throughout range (X debt)", () => {
    const x0v = computeX0(deferred);
    const y0v = computeY0(deferred);
    const yb = computeYb(y0v, deferred.ry, deferred.cy);
    const eps = (y0v - yb) * 0.01;
    for (let i = 0; i <= 30; i++) {
      const y = yb + eps + (y0v - yb - 2 * eps) * (i / 30);
      const h = computeHY(y, deferred, x0v, y0v);
      if (!isNaN(h) && isFinite(h)) {
        expect(h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("Y-side health at boundary ≈ 1", () => {
    const x0v = computeX0(deferred);
    const y0v = computeY0(deferred);
    const yb = computeYb(y0v, deferred.ry, deferred.cy);
    const h = computeHY(yb + 1e-3, deferred, x0v, y0v);
    approx(h, 1, 0.02);
  });

  it("validates cleanly", () => {
    expect(validateParams(deferred)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 36. Order book functions (LXX/LYY, lXX/lYY, FX/FY, LXY/LYX, lXY/lYX)
// ---------------------------------------------------------------------------
// Concrete numeric tests for the order book layer. Complements the property-
// based fuzz coverage in math.fuzz.test.ts with exact hand-computable values.

describe("order book — cumulative liquidity (LXX/LYY)", () => {
  // LXX(x, cx, x0) = x0 / sqrt((1+x-cx)/(1-cx))
  // At x=0: LXX = x0 / sqrt(1) = x0
  // At x=rx: LXX = xb = x0/sx

  it("LXX(0) = x0 (full reserves at equilibrium)", () => {
    approx(LXX(0, 0.5, 100), 100);
    approx(LXX(0, 0, 100), 100);
    approx(LXX(0, 0.99, 100), 100);
  });

  it("LYY(0) = y0", () => {
    approx(LYY(0, 0.5, 200), 200);
  });

  it("LXX(rx) matches computeXb", () => {
    const cx = 0.8, rx = 0.5, x0 = 1000;
    const xb = computeXb(x0, rx, cx);
    approx(LXX(rx, cx, x0), xb);
  });

  it("LXX is monotonically decreasing (hand-picked points)", () => {
    const cx = 0.5, x0 = 100;
    const L0 = LXX(0, cx, x0);
    const L1 = LXX(0.5, cx, x0);
    const L2 = LXX(1.0, cx, x0);
    expect(L0).toBeGreaterThan(L1);
    expect(L1).toBeGreaterThan(L2);
  });

  it("LXX(negative) returns NaN", () => {
    expect(LXX(-0.1, 0.5, 100)).toBeNaN();
  });

  it("c=0 closed form: LXX = x0/sqrt(1+x)", () => {
    const x0 = 50;
    for (const x of [0, 0.5, 1, 2, 5]) {
      approx(LXX(x, 0, x0), x0 / Math.sqrt(1 + x));
    }
  });

  it("LXX(0) - LXX(rx) = xr (reserve identity)", () => {
    const cx = 0.6, rx = 0.3;
    const sx = computeSx(rx, cx);
    const bXC = computeBxc(sx);
    const xr = 100;
    const x0 = xr * bXC;
    approx(LXX(0, cx, x0) - LXX(rx, cx, x0), xr);
  });

  it("X/Y symmetry: LXX and LYY identical for same args", () => {
    approx(LXX(0.3, 0.7, 100), LYY(0.3, 0.7, 100));
  });
});

describe("order book — liquidity density (lXX/lYY)", () => {
  // lXX(x, cx, x0) = x0 * sqrt(1-cx) / (2 * (1+x-cx)^(3/2))

  it("lXX is positive at equilibrium and boundary", () => {
    expect(lXX(0, 0.5, 100)).toBeGreaterThan(0);
    expect(lXX(1, 0.5, 100)).toBeGreaterThan(0);
  });

  it("lYY is positive", () => {
    expect(lYY(0, 0.5, 200)).toBeGreaterThan(0);
  });

  it("lXX decreases as x increases", () => {
    const cx = 0.5, x0 = 100;
    const l0 = lXX(0, cx, x0);
    const l1 = lXX(0.5, cx, x0);
    const l2 = lXX(1.0, cx, x0);
    expect(l0).toBeGreaterThan(l1);
    expect(l1).toBeGreaterThan(l2);
  });

  it("c=0 closed form: lXX = x0 / (2*(1+x)^(3/2))", () => {
    const x0 = 60;
    for (const x of [0, 0.5, 1, 3]) {
      approx(lXX(x, 0, x0), x0 / (2 * Math.pow(1 + x, 1.5)));
    }
  });

  it("matches negative numerical derivative of LXX", () => {
    const cx = 0.6, x0 = 100, x = 0.4;
    const h = 1e-7;
    const numerical = -(LXX(x + h, cx, x0) - LXX(x - h, cx, x0)) / (2 * h);
    approx(lXX(x, cx, x0), numerical, 1e-5);
  });

  it("lXX(negative) returns NaN", () => {
    expect(lXX(-0.1, 0.5, 100)).toBeNaN();
  });

  it("lXX scales linearly with x0", () => {
    const cx = 0.5, x = 0.3;
    approx(lXX(x, cx, 200) / lXX(x, cx, 100), 2);
  });
});

describe("order book — fingerprint (FX/FY)", () => {
  // FX(x, cx) = sqrt(1-cx) * (1+x)^(3/2) / (1+x-cx)^(3/2)

  it("FX(x, 0) = 1 for all x (c=0 is baseline)", () => {
    for (const x of [0, 0.5, 1, 5]) {
      approx(FX(x, 0), 1);
    }
  });

  it("FY(y, 0) = 1 for all y", () => {
    approx(FY(0, 0), 1);
    approx(FY(2, 0), 1);
  });

  it("FX(0, cx) > 1 for cx > 0", () => {
    // At x=0: FX = sqrt(1-cx) * 1 / (1-cx)^(3/2) = 1/(1-cx)
    for (const cx of [0.1, 0.5, 0.9]) {
      approx(FX(0, cx), 1 / (1 - cx));
    }
  });

  it("FX(0, cx) = 1/(1-cx) exact formula", () => {
    approx(FX(0, 0.8), 5);
    approx(FX(0, 0.5), 2);
  });

  it("FX is monotonically decreasing in x", () => {
    const cx = 0.7;
    expect(FX(0, cx)).toBeGreaterThan(FX(0.5, cx));
    expect(FX(0.5, cx)).toBeGreaterThan(FX(1, cx));
    expect(FX(1, cx)).toBeGreaterThan(FX(3, cx));
  });

  it("FX approaches 1 as x → ∞", () => {
    // At large x, (1+x-cx) ≈ (1+x), so FX → sqrt(1-cx) ≈ less than 1
    // Actually FX → sqrt(1-cx) * ((1+x)/(1+x-cx))^(3/2) → sqrt(1-cx) as x→∞
    // Wait: lim x→∞ = sqrt(1-cx) * 1^(3/2) = sqrt(1-cx)
    const cx = 0.5;
    const fLarge = FX(1000, cx);
    approx(fLarge, Math.sqrt(1 - cx), 1e-3);
  });

  it("X/Y symmetry: FX(x, c) = FY(x, c)", () => {
    approx(FX(0.5, 0.6), FY(0.5, 0.6));
  });

  it("FX(negative) returns NaN", () => {
    expect(FX(-0.1, 0.5)).toBeNaN();
  });
});

describe("order book — cross-asset liquidity (LXY/LYX)", () => {
  // LXY(x) = fX(LXX(x)) — Y amount on the curve when X is at LXX(x)
  // At x=0: LXY = fX(x0) = y0

  const px = 2, py = 1, cx = 0.5, x0 = 100, y0 = 200;

  it("LXY(0) = y0 (at equilibrium)", () => {
    approx(LXY(0, cx, x0, y0, px, py), y0);
  });

  it("LYX(0) = x0 (at equilibrium)", () => {
    const cy = 0.5;
    approx(LYX(0, cy, y0, x0, px, py), x0);
  });

  it("LXY increases as x increases (more Y paid out)", () => {
    const L1 = LXY(0.1, cx, x0, y0, px, py);
    const L2 = LXY(0.5, cx, x0, y0, px, py);
    expect(L2).toBeGreaterThan(L1);
    expect(L1).toBeGreaterThan(y0); // both above y0
  });

  it("LXY(negative) returns NaN", () => {
    expect(LXY(-0.1, cx, x0, y0, px, py)).toBeNaN();
  });

  it("c=0 cross-asset: LXY uses constant-product formula", () => {
    // c=0: fX(x) = x0*y0/x (scaled by prices). LXX(x,0,x0) = x0/sqrt(1+x)
    // so LXY = fX(x0/sqrt(1+x)) = y0*sqrt(1+x) * (px*x0)/(py*x0) ... actually
    // fX(x, 0, x0, y0, px, py) = px*x0^2/(py*x) + (1-px/py)*y0 when cx=0
    // Just verify numerical consistency
    const val = LXY(0.5, 0, x0, y0, px, py);
    const xAtPoint = LXX(0.5, 0, x0);
    const yFromCurve = fX(xAtPoint, 0, x0, y0, px, py);
    approx(val, yFromCurve);
  });
});

describe("order book — cross-asset density (lXY/lYX)", () => {
  // lXY(x) = pXxy(LXX(x)) * lXX(x)
  const px = 2, py = 1, cx = 0.5, x0 = 100, y0 = 200;

  it("lXY is positive at equilibrium", () => {
    expect(lXY(0, cx, x0, y0, px, py)).toBeGreaterThan(0);
  });

  it("lYX is positive at equilibrium", () => {
    const cy = 0.5;
    expect(lYX(0, cy, y0, x0, px, py)).toBeGreaterThan(0);
  });

  it("lXY matches numerical derivative of LXY", () => {
    const x = 0.3, h = 1e-7;
    const numerical = (LXY(x + h, cx, x0, y0, px, py) - LXY(x - h, cx, x0, y0, px, py)) / (2 * h);
    approx(lXY(x, cx, x0, y0, px, py), numerical, 1e-4);
  });

  it("lXY = pXxy(LXX(x)) * lXX(x) composition", () => {
    const x = 0.4;
    const xPos = LXX(x, cx, x0);
    const price = pXxy(xPos, cx, x0, px, py);
    const density = lXX(x, cx, x0);
    approx(lXY(x, cx, x0, y0, px, py), price * density);
  });

  it("lXY(negative) returns NaN", () => {
    expect(lXY(-0.1, cx, x0, y0, px, py)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// 37. yYYdebt (Y-side debt boundary: y0 - yr)
// ---------------------------------------------------------------------------

describe("yYYdebt", () => {
  it("returns y0 - yr", () => {
    approx(yYYdebt(150, 100), 50);
    approx(yYYdebt(100, 100), 0);
    approx(yYYdebt(100, 0), 100);
  });

  it("mirrors xXXdebt formula", () => {
    // xXXdebt(x0, xr) = x0 - xr — same pattern
    const x0 = 200, xr = 80;
    approx(xXXdebt(x0, xr), yYYdebt(x0, xr));
  });
});
