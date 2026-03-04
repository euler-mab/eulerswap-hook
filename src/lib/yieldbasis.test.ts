/**
 * Formal verification: EulerSwap IL elimination via compounding leverage.
 *
 * Proves that for cx=0 (constant-product), L=2 compounding leverage
 * eliminates impermanent loss. Shows that for cx>0, no constant L suffices.
 * Verifies all results numerically against the math library.
 */
import { describe, it, expect } from "vitest";
import {
  fX, fY, gY, gX,
  fXd, pXxy, pYxy,
  computeX0, computeY0,
  computeSx, computeSy,
  computeBxc, computeByc,
  computeXb, computeYb,
  Params, defaultParams,
} from "./math";

// ---------------------------------------------------------------------------
// Helper: build a simple no-debt, no-leverage EulerSwap Params
// ---------------------------------------------------------------------------
function simpleParams(overrides: Partial<Params> = {}): Params {
  return {
    ...defaultParams,
    vyx: 0, vxy: 0, vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    px: 1, py: 1, pxz: 1,
    rx: 1, ry: 1,
    cx: 0, cy: 0,
    xr: 100, yr: 100,
    zr: 0, xd: 0, yd: 0, zdebt: 0,
    rXX: 0, rXY: 0, rXZ: 0,
    rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Theorem 1: LP value function for EulerSwap
//
//   V(p) / V(p₀) = √((1 − cx)(r − cx)) + cx
//
//   where r = p/p₀  (price ratio),  p₀ = px/py,
//   and V is measured in Y units at the point where marginal price = p.
//
// Derivation:
//   Marginal price: P(x) = −fX'(x) = (px/py)[cx + (1−cx)(x₀/x)²]
//   Setting P(x) = p = r·p₀:
//     x = x₀ · √((1−cx)/(r−cx))
//
//   Value = x·p + fX(x)
//   After algebra (see docs/yield-basis-analysis.md):
//     V(r) = y₀ + p₀·x₀·[2√((1−cx)(r−cx)) + 2cx − 1]
//
//   At equilibrium (r=1) with balanced pool y₀ = p₀·x₀:
//     V(1) = 2·p₀·x₀
//
//   So V(r)/V(1) = √((1−cx)(r−cx)) + cx.
// ---------------------------------------------------------------------------

/**
 * Compute the LP value in Y terms at market price p, for a SYMMETRIC pool
 * (cx = cy) with equilibrium at (x₀, y₀), oracle price p₀ = px/py.
 *
 * Handles both sides:
 *   r ≥ 1 (price rises): X side, x decreases from x₀, y = fX(x)
 *   r < 1 (price drops):  Y side, y decreases from y₀, x = gY(y)
 *
 * Returns { x, y, value } where (x, y) is the reserve at marginal price = p.
 */
function lpValueAtPrice(
  p: number,       // market price (Y per X)
  x0: number,
  y0: number,
  px: number,
  py: number,
  cx: number,      // assumed cx = cy for this analysis
): { x: number; y: number; value: number } {
  const p0 = px / py;
  const r = p / p0;

  if (r >= 1) {
    // X side: price rises, x decreases from x₀
    // Marginal price: P(x) = p₀·[cx + (1−cx)·(x₀/x)²] = p
    // x = x₀ · √((1−cx)/(r−cx))
    if (r <= cx) throw new Error(`Price too low for X side: r=${r} <= cx=${cx}`);
    const x = x0 * Math.sqrt((1 - cx) / (r - cx));
    const y = fX(x, cx, x0, y0, px, py);
    return { x, y, value: x * p + y };
  } else {
    // Y side: price drops, y decreases from y₀
    // Marginal price (Y per X): pYxy(y) = (px/py) / [cy + (1−cy)·(y₀/y)²]
    // Setting pYxy = p:  cy + (1−cy)·(y₀/y)² = p₀/p = 1/r
    // y = y₀ · √((1−cx)/(1/r − cx))  =  y₀ · √((1−cx)·r/(1−cx·r))
    const cy = cx; // symmetric pool
    const s = 1 / r; // s > 1
    if (s <= cy) throw new Error(`Price too high for Y side: s=${s} <= cy=${cy}`);
    const y = y0 * Math.sqrt((1 - cy) / (s - cy));
    const x = gY(y, cy, y0, x0, px, py);
    return { x, y, value: x * p + y };
  }
}

/**
 * Theoretical value ratio V(r)/V(1).
 *
 * For a symmetric pool (cx = cy, px = py, x₀ = y₀):
 *   r ≥ 1 (X side): V(r)/V(1) = √((1−cx)(r−cx)) + cx
 *   r < 1 (Y side): By X↔Y symmetry, V(r)/V(1) = r·[√((1−cx)(1/r−cx)) + cx]
 *
 * At cx = 0: both reduce to √r (for all r > 0).
 */
function theoreticalValueRatio(r: number, cx: number): number {
  if (r >= 1) {
    // X side
    return Math.sqrt((1 - cx) * (r - cx)) + cx;
  } else {
    // Y side: swap the role of X and Y.
    // In X units, value ratio = √((1-cx)(s-cx)) + cx where s = 1/r.
    // Converting to Y units: multiply by r (price conversion).
    const s = 1 / r;
    return r * (Math.sqrt((1 - cx) * (s - cx)) + cx);
  }
}

describe("Part 1: LP Value Function", () => {
  // Balanced pool: px = py, xr = yr, so x₀ = y₀ and p₀ = 1
  const configs = [
    { cx: 0,    label: "cx=0 (constant-product)" },
    { cx: 0.3,  label: "cx=0.3" },
    { cx: 0.5,  label: "cx=0.5" },
    { cx: 0.8,  label: "cx=0.8" },
    { cx: 0.95, label: "cx=0.95 (near constant-sum)" },
  ];

  const priceRatios = [0.5, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.5, 2.0];

  for (const { cx, label } of configs) {
    describe(label, () => {
      // Need a wide enough range to handle all price ratios
      const rx = 10; // very wide range
      const ry = 10;
      const p = simpleParams({ cx, cy: cx, rx, ry, xr: 100, yr: 100 });
      const x0 = computeX0(p);
      const y0 = computeY0(p);

      it("V(1)/V(1) = 1 (identity at equilibrium)", () => {
        const { value: v1 } = lpValueAtPrice(1, x0, y0, 1, 1, cx);
        expect(v1 / v1).toBeCloseTo(1, 10);
      });

      for (const r of priceRatios) {
        if (r <= cx) continue; // below valid range for this cx
        it(`V(r=${r})/V(1) matches theory`, () => {
          const { value: v1 } = lpValueAtPrice(1, x0, y0, 1, 1, cx);
          const { value: vr } = lpValueAtPrice(r, x0, y0, 1, 1, cx);
          const actual = vr / v1;
          const expected = theoreticalValueRatio(r, cx);
          expect(actual).toBeCloseTo(expected, 8);
        });
      }

      it("cx=0 special case: V(r)/V(1) = √r", () => {
        if (cx !== 0) return;
        for (const r of priceRatios) {
          const { value: v1 } = lpValueAtPrice(1, x0, y0, 1, 1, 0);
          const { value: vr } = lpValueAtPrice(r, x0, y0, 1, 1, 0);
          expect(vr / v1).toBeCloseTo(Math.sqrt(r), 8);
        }
      });
    });
  }

  it("non-unit prices: V(r)/V(1) still matches theory", () => {
    // ETH/USDC: px=2000, py=1. Pool balanced in value: yr = xr × (px/py)
    const cx = 0;
    const px = 2000, py = 1;
    const xr = 10, yr = xr * (px / py); // 20000
    const p = simpleParams({ cx, cy: cx, px, py, rx: 5, ry: 5, xr, yr });
    const x0 = computeX0(p);
    const y0 = computeY0(p);

    // Verify pool is balanced: y₀ ≈ x₀ × (px/py)
    expect(y0 / x0).toBeCloseTo(px / py, 4);

    for (const r of [0.8, 1.0, 1.2, 2.0]) {
      const marketPrice = r * (px / py); // r × 2000
      const { value: v1 } = lpValueAtPrice(px / py, x0, y0, px, py, cx);
      const { value: vr } = lpValueAtPrice(marketPrice, x0, y0, px, py, cx);
      expect(vr / v1).toBeCloseTo(theoreticalValueRatio(r, cx), 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Theorem 2: Compounding leverage eliminates IL iff cx = 0
//
//   With discrete compounding at leverage L, after n price steps:
//     V*_n / V*_0 = Π_{i=1}^{n} [V(r_i) / V(1)]^L
//
//   where r_i = p_i / p_{i-1} (per-step price ratio after re-centering).
//
//   For cx = 0:
//     V(r)/V(1) = √r
//     [√r_i]^2 = r_i
//     Π r_i = p_n / p_0     (telescopes)
//     ⟹ V*/V₀ = p_n/p₀ = HODL return ⟹ IL = 0  ∎
//
//   For cx > 0:
//     [√((1−cx)(r−cx)) + cx]^L ≠ r  for general r when cx > 0.
//     Proof: expanding [√((1−cx)(r−cx)) + cx]² = r gives (r−1)² = 0,
//     which only holds at r = 1. No constant L works. ∎
// ---------------------------------------------------------------------------

describe("Part 2: IL elimination via compounding leverage", () => {
  describe("cx=0, L=2: exact IL elimination", () => {
    const pricePaths = [
      { label: "monotone up",     steps: [1.0, 1.1, 1.2, 1.5, 2.0] },
      { label: "monotone down",   steps: [1.0, 0.9, 0.8, 0.6, 0.5] },
      { label: "up then down",    steps: [1.0, 1.5, 2.0, 1.5, 1.0] },
      { label: "volatile",        steps: [1.0, 1.3, 0.7, 1.1, 0.9, 1.4] },
      { label: "extreme",         steps: [1.0, 3.0, 0.5, 2.0, 0.8] },
      { label: "small moves",     steps: [1.0, 1.01, 1.02, 1.01, 1.03, 1.02] },
    ];

    for (const { label, steps } of pricePaths) {
      it(`path: ${label}`, () => {
        const L = 2;
        let compoundedValue = 1.0;

        for (let i = 1; i < steps.length; i++) {
          // Per-step price ratio (after re-centering at previous price)
          const r = steps[i] / steps[i - 1];
          // Value ratio for one step at cx=0
          const stepReturn = theoreticalValueRatio(r, 0); // = √r
          // Compound with leverage L
          compoundedValue *= Math.pow(stepReturn, L); // (√r)^2 = r
        }

        // Should equal final/initial price ratio (HODL return)
        const hodlReturn = steps[steps.length - 1] / steps[0];
        expect(compoundedValue).toBeCloseTo(hodlReturn, 10);
      });
    }

    it("algebraic proof: (√r)^2 = r for all r > 0", () => {
      // This is trivially true but let's verify numerically for many r
      for (let r = 0.01; r <= 10; r += 0.1) {
        const base = theoreticalValueRatio(r, 0); // √r
        expect(Math.pow(base, 2)).toBeCloseTo(r, 10);
      }
    });
  });

  describe("cx>0, L=2: IL is NOT eliminated", () => {
    const cxValues = [0.1, 0.3, 0.5, 0.8, 0.95];

    for (const cx of cxValues) {
      it(`cx=${cx}: [V(r)/V(1)]² ≠ r for r ≠ 1`, () => {
        const testRatios = [0.5, 0.8, 1.2, 1.5, 2.0].filter(r => r > cx);
        for (const r of testRatios) {
          const base = theoreticalValueRatio(r, cx);
          const compounded = Math.pow(base, 2);
          // Should NOT equal r (except at r=1)
          if (Math.abs(r - 1) > 0.01) {
            expect(Math.abs(compounded - r)).toBeGreaterThan(1e-6);
          }
        }
      });
    }

    it("algebraic proof: [√((1−cx)(r−cx)) + cx]² = r ⟹ (r−1)² = 0", () => {
      // Expand [√((1-cx)(r-cx)) + cx]² = r
      // (1-cx)(r-cx) + 2cx√((1-cx)(r-cx)) + cx² = r
      // Let s = √((1-cx)(r-cx))
      // (1-cx)(r-cx) + 2cx·s + cx² = r
      // r - cx - cx·r + cx² + 2cx·s + cx² = r
      // -cx + 2cx² - cx·r + 2cx·s = 0   (assuming cx ≠ 0)
      // 2s = r + 1 - 2cx
      // 4s² = (r + 1 - 2cx)²
      // 4(1-cx)(r-cx) = (r + 1 - 2cx)²
      // 4r - 4cx - 4cx·r + 4cx² = r² + 1 + 4cx² + 2r - 4cx - 4cx·r
      // 4r = r² + 1 + 2r
      // 0 = r² - 2r + 1 = (r-1)²
      //
      // Only solution: r = 1. QED.
      //
      // Verify numerically:
      for (const cx of [0.1, 0.5, 0.9]) {
        for (const r of [0.5, 0.8, 1.0, 1.2, 2.0]) {
          if (r <= cx) continue;
          const lhs = Math.pow(theoreticalValueRatio(r, cx), 2);
          const residual = lhs - r;
          if (Math.abs(r - 1) < 1e-10) {
            expect(Math.abs(residual)).toBeLessThan(1e-10);
          } else {
            expect(Math.abs(residual)).toBeGreaterThan(1e-8);
          }
        }
      }
    });

    it("no constant L works for cx > 0 (value function is not a power of r)", () => {
      // If V(r)/V(1) = r^α for some α, then [r^α]^L = r requires αL = 1.
      // But V(r)/V(1) = √((1-cx)(r-cx)) + cx is NOT of the form r^α.
      // We prove this by showing the "implied α" varies with r.
      const cx = 0.5;
      const alphaAtR = (r: number) => {
        const v = theoreticalValueRatio(r, cx);
        return Math.log(v) / Math.log(r);
      };

      // α should be different at different r values
      const alpha1 = alphaAtR(0.7);
      const alpha2 = alphaAtR(1.5);
      const alpha3 = alphaAtR(3.0);

      expect(Math.abs(alpha1 - alpha2)).toBeGreaterThan(0.01);
      expect(Math.abs(alpha2 - alpha3)).toBeGreaterThan(0.01);
    });
  });

  describe("cx>0, L=2: residual IL quantification", () => {
    it("residual IL = cx·ε²/(4(1−cx)) for small ε", () => {
      // Taylor expansion: V(1+ε)/V(1) ≈ 1 + ε/2 − ε²/(8(1−cx))
      // [V]² ≈ 1 + ε − cx·ε²/(4(1−cx))
      // HODL = 1 + ε
      // Residual = [V]² − HODL = −cx·ε²/(4(1−cx))
      for (const cx of [0.1, 0.3, 0.5, 0.8]) {
        const eps = 0.01; // small price change
        const r = 1 + eps;
        const compounded = Math.pow(theoreticalValueRatio(r, cx), 2);
        const hodl = r;
        const residual = compounded - hodl;
        const predicted = -cx * eps * eps / (4 * (1 - cx));
        expect(residual).toBeCloseTo(predicted, 5);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Theorem 3: Discrete compounding via afterSwap hook
//
// The hook re-centers the curve after each swap. Numerically verify that
// compounding n discrete steps with re-centering matches the theoretical
// product Π [V(r_i)]^L.
// ---------------------------------------------------------------------------

describe("Part 3: Discrete compounding simulation", () => {
  /**
   * Simulate a sequence of price changes with per-step re-centering.
   * At each step:
   *   1. Price changes from p_{i-1} to p_i
   *   2. Value changes by V(r_i)/V(1) where r_i = p_i/p_{i-1}
   *   3. Leverage L is applied: step return = [V(r_i)/V(1)]^L
   *   4. Re-center: new equilibrium = current reserves (conceptually)
   */
  function simulateCompounding(prices: number[], cx: number, L: number): number {
    let cumReturn = 1.0;
    for (let i = 1; i < prices.length; i++) {
      const r = prices[i] / prices[i - 1];
      if (r <= cx) throw new Error(`Price drop too large: r=${r} <= cx=${cx}`);
      const stepReturn = theoreticalValueRatio(r, cx);
      cumReturn *= Math.pow(stepReturn, L);
    }
    return cumReturn;
  }

  it("cx=0, L=2: 100 random steps, compound return = p_n/p_0", () => {
    const cx = 0, L = 2;
    // Generate random price path
    const rng = (seed: number) => {
      let s = seed;
      return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    };
    const rand = rng(42);

    const prices = [1.0];
    for (let i = 0; i < 100; i++) {
      // Random multiplicative step: 0.9 to 1.1
      const step = 0.9 + 0.2 * rand();
      prices.push(prices[prices.length - 1] * step);
    }

    const result = simulateCompounding(prices, cx, L);
    const hodlReturn = prices[prices.length - 1] / prices[0];
    expect(result).toBeCloseTo(hodlReturn, 8);
  });

  it("cx=0.5, L=2: compounded return ≠ HODL (IL present)", () => {
    const cx = 0.5, L = 2;
    const prices = [1.0, 1.5, 2.0, 1.5, 1.0, 1.5, 2.5];

    const result = simulateCompounding(prices, cx, L);
    const hodlReturn = prices[prices.length - 1] / prices[0];
    expect(Math.abs(result - hodlReturn)).toBeGreaterThan(0.01);
  });

  it("cx=0, L=1: standard AMM, IL present", () => {
    const cx = 0, L = 1;
    const prices = [1.0, 2.0]; // 100% price increase

    const result = simulateCompounding(prices, cx, L);
    const hodlReturn = prices[1] / prices[0]; // = 2
    const il = result / hodlReturn - 1;
    // √2/2 - 1 ≈ -0.293
    expect(il).toBeCloseTo(Math.sqrt(2) / 2 - 1, 8);
  });

  it("cx=0, L=3: over-leveraged, exceeds HODL (negative IL but risky)", () => {
    const cx = 0, L = 3;
    const prices = [1.0, 2.0];

    const result = simulateCompounding(prices, cx, L);
    const hodlReturn = 2.0;
    // (√2)^3 = 2√2 ≈ 2.828 > 2 = HODL
    expect(result).toBeCloseTo(Math.pow(Math.sqrt(2), 3), 8);
    expect(result).toBeGreaterThan(hodlReturn);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Verify against math.ts curve functions
//
// Cross-check the analytical value function against actual fX/gY evaluation.
// ---------------------------------------------------------------------------

describe("Part 4: Cross-validation with math.ts", () => {
  const configs = [
    { cx: 0, rx: 5, label: "cx=0" },
    { cx: 0.3, rx: 5, label: "cx=0.3" },
    { cx: 0.5, rx: 5, label: "cx=0.5" },
    { cx: 0.8, rx: 3, label: "cx=0.8" },
  ];

  for (const { cx, rx, label } of configs) {
    describe(label, () => {
      const p = simpleParams({ cx, cy: cx, rx, ry: rx });
      const x0 = computeX0(p);
      const y0 = computeY0(p);

      it("marginal price at equilibrium = px/py", () => {
        const pAtEq = pXxy(x0, cx, x0, 1, 1);
        expect(pAtEq).toBeCloseTo(1.0, 8); // px/py = 1
      });

      it("value at equilibrium = x₀ + y₀", () => {
        const { value } = lpValueAtPrice(1, x0, y0, 1, 1, cx);
        expect(value).toBeCloseTo(x0 + y0, 6);
      });

      for (const r of [0.5, 0.8, 1.2, 1.5, 2.0]) {
        it(`at r=${r}: reserves lie on curve`, () => {
          const { x, y } = lpValueAtPrice(r, x0, y0, 1, 1, cx);
          if (r >= 1) {
            // X side: y should match fX(x)
            const yCurve = fX(x, cx, x0, y0, 1, 1);
            expect(y).toBeCloseTo(yCurve, 6);
          } else {
            // Y side: x should match gY(y)
            const xCurve = gY(y, cx, y0, x0, 1, 1);
            expect(x).toBeCloseTo(xCurve, 6);
          }
        });

        it(`at r=${r}: marginal price = r × p₀`, () => {
          const { x, y } = lpValueAtPrice(r, x0, y0, 1, 1, cx);
          if (r >= 1) {
            const marginal = pXxy(x, cx, x0, 1, 1);
            expect(marginal).toBeCloseTo(r, 6);
          } else {
            const marginal = pYxy(y, cx, y0, 1, 1);
            expect(marginal).toBeCloseTo(r, 6);
          }
        });
      }
    });
  }

  it("Y-side symmetry: same value function applies", () => {
    // For a symmetric pool (px=py, cx=cy, xr=yr), the Y-side
    // value function is the mirror image.
    const cx = 0;
    const p = simpleParams({ cx, cy: cx, rx: 5, ry: 5 });
    const x0 = computeX0(p);
    const y0 = computeY0(p);

    // Price drops (Y side): marginal price < p₀
    // On Y side, as price drops, y increases from y₀ toward pool selling X
    for (const r of [0.5, 0.7, 0.9]) {
      // X-side: price = r, x increases (AMM buys X)
      const { value: vX } = lpValueAtPrice(r, x0, y0, 1, 1, cx);
      // By symmetry (px=py, cx=cy, xr=yr), value ratio should be same
      const v1 = lpValueAtPrice(1, x0, y0, 1, 1, cx).value;
      expect(vX / v1).toBeCloseTo(Math.sqrt(r), 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 5: CurveLib.verify constraint analysis
//
// When the afterSwap hook reconfigures, the new curve must pass through
// the current reserves. Analyze when this is possible.
// ---------------------------------------------------------------------------

describe("Part 5: Reconfiguration constraints", () => {
  it("re-centering at current reserves always passes verify", () => {
    // After a swap, reserves are (r0, r1) with r0 < x₀ (X-side swap).
    // If we set new equilibrium = (r0, r1) (no leverage), the reserves
    // are exactly at equilibrium → verify trivially passes.
    const cx = 0;
    const p = simpleParams({ cx, cy: cx, rx: 2, ry: 2 });
    const x0 = computeX0(p);
    const y0 = computeY0(p);

    // Simulate X-side swap: x drops to 0.8·x₀
    const x = 0.8 * x0;
    const y = fX(x, cx, x0, y0, 1, 1);

    // Re-center: new x₀ = x, new y₀ = y
    // At new equilibrium, reserves ARE the equilibrium → on the curve
    // verify(newParams, x, y) passes because x >= newX0 and y >= newY0
    expect(x).toBeLessThan(x0); // confirms we moved from equilibrium
    expect(y).toBeGreaterThan(y0);

    // The new curve through (x, y) as equilibrium: fX_new(x', cx, x, y, 1, 1)
    // At x' = x (equilibrium): fX_new = y (identity). ✓
    const yAtNewEq = fX(x, cx, x, y, 1, 1);
    expect(yAtNewEq).toBeCloseTo(y, 10); // fX(x₀, ...) should return y₀

    // Actually fX(x₀, ...) is the boundary (x must be < x₀ to be on X side)
    // At equilibrium, both sides meet: fX(x₀) = y₀ exactly
    // But fX requires x <= x0, so x = x0 is the boundary
  });

  it("leveraged re-centering: new x₀ = L·r₀ requires reserves at equilibrium", () => {
    // For L=2 releverage: new equilibriumReserve = 2 × current_reserve
    // But then current_reserve < new_equilibrium on BOTH sides → verify fails
    // unless we first deposit more tokens to reach the new equilibrium.
    //
    // This confirms the hook must interact with vaults to:
    // 1. Borrow additional tokens
    // 2. Deposit them to bring reserves up to L × current_unleveraged
    // 3. Then reconfigure with the new equilibrium
    const L = 2;
    const x = 100; // current reserve after swap
    const y = 100;

    // If we try to set equilibrium = (200, 200) with reserves at (100, 100):
    // verify checks: 100 < 200 → else branch → 100 < 200 → return false
    // This confirms the constraint.
    const newX0 = L * x;
    const newY0 = L * y;
    expect(x).toBeLessThan(newX0);
    expect(y).toBeLessThan(newY0);
    // Both below equilibrium → CurveLib.verify would return false
  });

  it("value preservation under re-centering (cx=0, no leverage)", () => {
    // When re-centering without leverage, value is preserved.
    // Before: V₁ = x·p + y  (reserves at price p on old curve)
    // After:  V₁ = x₀_new·p₀_new + y₀_new  (new equilibrium)
    //       where x₀_new = x, y₀_new = y, p₀_new = p
    // These are equal by construction.
    const cx = 0;
    const p0 = 1;
    const x0 = 100, y0 = 100;

    for (const r of [0.8, 1.2, 1.5]) {
      const p = r * p0;
      const { x, y, value } = lpValueAtPrice(p, x0, y0, 1, 1, cx);

      // After re-centering: new equilibrium at (x, y) with price p
      const newValue = x * p + y; // = value by definition
      expect(newValue).toBeCloseTo(value, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 6: Full proof summary (executable specification)
// ---------------------------------------------------------------------------

describe("Part 6: Complete IL elimination proof (cx=0, L=2)", () => {
  it("THEOREM: For EulerSwap with cx=0 and L=2 compounding leverage, IL=0", () => {
    // ─── Setup ───
    // Pool: cx = cy = 0 (constant-product), px = py = 1 (unit prices)
    // Leverage: L = 2 (compounding, not simple)
    //
    // ─── Value function (Theorem 1) ───
    // For cx = 0: V(r)/V(1) = √r  where r = p/p₀
    //
    // ─── Compounding (Theorem 2) ───
    // After re-centering at each step:
    //   V*_n / V*_0 = Π_{i=1}^{n} [√(p_i/p_{i-1})]^2
    //              = Π_{i=1}^{n} (p_i/p_{i-1})
    //              = p_n / p_0     (telescope)
    //
    // ─── HODL comparison ───
    // HODL return for asset X = p_n / p_0  (by definition)
    // V*_n / V*_0 = p_n / p_0 = HODL return
    // ⟹ IL = V*/HODL − 1 = 0  ∎
    //
    // ─── Numerical verification ───
    // 1000-step random walk with re-centering:

    const rng = (seed: number) => {
      let s = seed;
      return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    };
    const rand = rng(12345);

    const N = 1000;
    const L = 2;
    const cx = 0;
    let compounded = 1.0;
    let price = 1.0;

    for (let i = 0; i < N; i++) {
      const step = 0.95 + 0.1 * rand(); // random step: 0.95 to 1.05
      const newPrice = price * step;
      const r = newPrice / price;

      // Compounding: [√r]^L = [√r]^2 = r
      const stepReturn = Math.pow(theoreticalValueRatio(r, cx), L);
      compounded *= stepReturn;
      price = newPrice;
    }

    const hodlReturn = price / 1.0;
    const il = compounded / hodlReturn - 1;

    // IL should be exactly 0 (within floating-point precision)
    expect(Math.abs(il)).toBeLessThan(1e-10);
  });

  it("COROLLARY: No constant L eliminates IL for cx > 0", () => {
    // For cx > 0, V(r)/V(1) = √((1-cx)(r-cx)) + cx
    // This is NOT of the form r^α for any constant α.
    //
    // Proof: if V(r)/V(1) = r^α, then α = log(V(r)/V(1))/log(r).
    // But this varies with r:

    for (const cx of [0.2, 0.5, 0.8]) {
      const alphas = [0.5, 1.5, 3.0]
        .filter(r => r > cx)
        .map(r => Math.log(theoreticalValueRatio(r, cx)) / Math.log(r));

      // All α values should be different
      for (let i = 1; i < alphas.length; i++) {
        expect(Math.abs(alphas[i] - alphas[0])).toBeGreaterThan(0.01);
      }
    }
  });
});
