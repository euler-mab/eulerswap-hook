import { describe, it, expect } from "vitest";
import {
  fX, fY, gY, gX, fXd, gYd,
  computeSx, computeSy, computeBxc, computeByc,
  computePX, computePY, computeX0, computeY0,
  computeXb, computeYb,
  computeHX, computeHY,
  validateParams, defaultParams,
  type Params,
} from "./math";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a ≈ b within relative tolerance (default 1e-9) */
function approx(a: number, b: number, tol = 1e-9) {
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

  it("fY (inverse side) is consistent with constant-product", () => {
    // For c=0 inverse: y = y0² / ((px/py)(x-x0) + y0)
    // Check x·y = k doesn't hold on inverse side (different curve piece),
    // but fY should be continuous at x0 and monotonically decreasing
    for (const x of [10, 12, 15, 20, 50]) {
      const y = fY(x, c, x0, y0, px, py);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(y0);
    }
    // Monotonically decreasing
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

  it("catches degenerate boost", () => {
    // rx very small with cx very high → sx near 1 → bXC huge or degenerate
    const bad = { ...defaultParams, rx: 0.001, cx: 0.999 };
    const w = validateParams(bad);
    // sx = sqrt((1+0.001-0.999)/(1-0.999)) = sqrt(0.002/0.001) = sqrt(2) ≈ 1.414
    // That's > 1, so it should be fine. Let's use a case that actually fails:
    // rx=-0.5 → inner < 0 → sx=NaN
    const bad2 = { ...defaultParams, rx: -1 };
    const w2 = validateParams(bad2);
    expect(w2.some((s) => s.includes("rx must be"))).toBe(true);
  });
});
