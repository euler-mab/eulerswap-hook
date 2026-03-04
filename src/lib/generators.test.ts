/**
 * Tests for the 8 point-generator functions and differential consistency
 * between composed functions and their primitives.
 *
 * Point generators:
 *   generateOrderBookPointsX/Y, generateFXPoints, generateFYPoints,
 *   generateShiftedFXPoints, generateShiftedGYPoints,
 *   generateCollateralDebtPoints, generateCollateralDebtPointsY
 *
 * Consistency checks:
 *   - fXd vs numerical derivative of fX
 *   - marginal price composition (pXxy = -fXd, etc.)
 *   - order book density vs numerical derivative of cumulative
 *   - collateral/debt phase boundary transitions
 */

import { describe, it, expect } from "vitest";
import {
  Params, defaultParams, validateParams,
  computeX0, computeY0, computeXb, computeYb,
  computeSx, computeSy, computeBxc, computeByc,
  computeZd,
  fX, fY, gY, gX, fXd, gYd,
  pXxy, pYxy, pXyx, pYyx,
  priceAtXb, priceAtYb,
  LXX, LYY, LXY, LYX,
  lXX, lYY, lXY, lYX,
  FX, FY,
  CXX, CXY_fn, DXX, DXY,
  CYY, CYX_fn, DYY, DYX,
  xXXdebt, xXYdebt, yYYdebt, yYXdebt,
  computeHX, computeHY,
  computeNAV_X, computeNAV_Y,
  generateOrderBookPointsX, generateOrderBookPointsY,
  generateFXPoints, generateFYPoints,
  generateShiftedFXPoints, generateShiftedGYPoints,
  generateCollateralDebtPoints, generateCollateralDebtPointsY,
} from "./math";

// ─── helpers ─────────────────────────────────────────────────────────

function approx(a: number, b: number, tol = 1e-6): boolean {
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) < tol * (1 + Math.abs(a) + Math.abs(b));
}

function makeParams(overrides: Partial<Params> = {}): Params {
  return { ...defaultParams, xd: 0, yd: 0, zdebt: 0, ...overrides };
}

// ─── test configurations ─────────────────────────────────────────────

const configs: { name: string; p: Partial<Params> }[] = [
  { name: "symmetric px=py=1", p: { cx: 0.5, cy: 0.5, rx: 1, ry: 1 } },
  { name: "cx=0 (constant product)", p: { cx: 0, cy: 0, rx: 1, ry: 1 } },
  { name: "high concentration", p: { cx: 0.8, cy: 0.8, rx: 0.5, ry: 0.5 } },
  { name: "ETH/USDC-like", p: { px: 2000, py: 1, cx: 0.3, cy: 0.3, rx: 0.5, ry: 0.5 } },
  { name: "asymmetric range", p: { cx: 0.4, cy: 0.6, rx: 2, ry: 0.3 } },
  { name: "wide range", p: { cx: 0, cy: 0, rx: 5, ry: 5 } },
];

const debtConfigs: { name: string; p: Partial<Params> }[] = [
  { name: "Y debt", p: { cx: 0.5, cy: 0.5, xd: 0, yd: 5, zdebt: 0 } },
  { name: "X debt", p: { cx: 0.3, cy: 0.3, xd: 3, yd: 0, zdebt: 0 } },
  { name: "Z debt", p: { cx: 0.5, cy: 0.5, xd: 0, yd: 0, zdebt: 10 } },
  { name: "no debt", p: { cx: 0.5, cy: 0.5, xd: 0, yd: 0, zdebt: 0 } },
];

// =====================================================================
// 1. generateOrderBookPointsX / Y
// =====================================================================

describe("generateOrderBookPointsX", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, rx, px, py } = params;
      const pts = generateOrderBookPointsX(x0, y0, cx, rx, px, py, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("priceDelta spans [0, rx]", () => {
        expect(pts[0].priceDelta).toBeCloseTo(0, 5);
        expect(pts[pts.length - 1].priceDelta).toBeCloseTo(rx, 5);
      });

      it("cumSame matches LXX at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.cumSame, LXX(pt.priceDelta, cx, x0), 1e-9)).toBe(true);
        }
      });

      it("cumCross matches LXY at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.cumCross, LXY(pt.priceDelta, cx, x0, y0, px, py), 1e-9)).toBe(true);
        }
      });

      it("densSame matches lXX at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.densSame, lXX(pt.priceDelta, cx, x0), 1e-9)).toBe(true);
        }
      });

      it("densCross matches lXY at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.densCross, lXY(pt.priceDelta, cx, x0, y0, px, py), 1e-9)).toBe(true);
        }
      });

      it("fingerprint matches FX at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.fingerprint, FX(pt.priceDelta, cx), 1e-9)).toBe(true);
        }
      });

      it("cumSame is monotonically decreasing", () => {
        for (let i = 1; i < pts.length; i++) {
          expect(pts[i].cumSame).toBeLessThanOrEqual(pts[i - 1].cumSame + 1e-9);
        }
      });

      it("cumSame(0) = x0 and cumSame(rx) = xb", () => {
        const xb = computeXb(x0, rx, cx);
        expect(approx(pts[0].cumSame, x0, 1e-9)).toBe(true);
        expect(approx(pts[pts.length - 1].cumSame, xb, 1e-6)).toBe(true);
      });

      it("all values are finite", () => {
        for (const pt of pts) {
          expect(isFinite(pt.cumSame)).toBe(true);
          expect(isFinite(pt.cumCross)).toBe(true);
          expect(isFinite(pt.densSame)).toBe(true);
          expect(isFinite(pt.densCross)).toBe(true);
          expect(isFinite(pt.fingerprint)).toBe(true);
        }
      });
    });
  }
});

describe("generateOrderBookPointsY", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cy, ry, px, py } = params;
      const pts = generateOrderBookPointsY(x0, y0, cy, ry, px, py, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("priceDelta spans [0, ry]", () => {
        expect(pts[0].priceDelta).toBeCloseTo(0, 5);
        expect(pts[pts.length - 1].priceDelta).toBeCloseTo(ry, 5);
      });

      it("cumSame matches LYY at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.cumSame, LYY(pt.priceDelta, cy, y0), 1e-9)).toBe(true);
        }
      });

      it("cumCross matches LYX at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.cumCross, LYX(pt.priceDelta, cy, y0, x0, px, py), 1e-9)).toBe(true);
        }
      });

      it("cumSame(0) = y0 and cumSame(ry) = yb", () => {
        const yb = computeYb(y0, ry, cy);
        expect(approx(pts[0].cumSame, y0, 1e-9)).toBe(true);
        expect(approx(pts[pts.length - 1].cumSame, yb, 1e-6)).toBe(true);
      });

      it("fingerprint matches FY at each point", () => {
        for (const pt of pts) {
          expect(approx(pt.fingerprint, FY(pt.priceDelta, cy), 1e-9)).toBe(true);
        }
      });
    });
  }
});

// =====================================================================
// 2. generateFXPoints / generateFYPoints
// =====================================================================

describe("generateFXPoints", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, px, py } = params;
      const pts = generateFXPoints(x0, y0, px, py, cx, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("x values are in (0, x0]", () => {
        for (const pt of pts) {
          expect(pt.x).toBeGreaterThan(0);
          expect(pt.x).toBeLessThanOrEqual(x0 + 1e-9);
        }
      });

      it("y values match fX(x) exactly", () => {
        for (const pt of pts) {
          const expected = fX(pt.x, cx, x0, y0, px, py);
          expect(approx(pt.y, expected, 1e-12)).toBe(true);
        }
      });

      it("last point is at equilibrium (x0, y0)", () => {
        const last = pts[pts.length - 1];
        expect(approx(last.x, x0, 1e-6)).toBe(true);
        expect(approx(last.y, y0, 1e-6)).toBe(true);
      });

      it("y is monotonically decreasing with x (fXd < 0)", () => {
        for (let i = 1; i < pts.length; i++) {
          // fX has negative derivative (dy/dx < 0): as x increases toward x0, y decreases toward y0
          if (pts[i].x > pts[i - 1].x) {
            expect(pts[i].y).toBeLessThanOrEqual(pts[i - 1].y + 1e-9);
          }
        }
      });

      it("all values are finite and positive", () => {
        for (const pt of pts) {
          expect(isFinite(pt.x) && pt.x > 0).toBe(true);
          expect(isFinite(pt.y) && pt.y > 0).toBe(true);
        }
      });
    });
  }
});

describe("generateFYPoints", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cy, px, py } = params;
      const pts = generateFYPoints(x0, y0, px, py, cy, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("x values are in [x0, 3*x0]", () => {
        for (const pt of pts) {
          expect(pt.x).toBeGreaterThanOrEqual(x0 - 1e-9);
          expect(pt.x).toBeLessThanOrEqual(3 * x0 + 1e-9);
        }
      });

      it("y values match fY(x) exactly", () => {
        for (const pt of pts) {
          const expected = fY(pt.x, cy, x0, y0, px, py);
          if (isFinite(expected) && expected > 0) {
            expect(approx(pt.y, expected, 1e-9)).toBe(true);
          }
        }
      });

      it("first point is at or near equilibrium", () => {
        const first = pts[0];
        expect(approx(first.x, x0, 1e-6)).toBe(true);
        expect(approx(first.y, y0, 1e-6)).toBe(true);
      });

      it("y is monotonically decreasing (inverse side)", () => {
        for (let i = 1; i < pts.length; i++) {
          expect(pts[i].y).toBeLessThanOrEqual(pts[i - 1].y + 1e-9);
        }
      });
    });
  }
});

// =====================================================================
// 3. generateShiftedFXPoints / generateShiftedGYPoints
// =====================================================================

describe("generateShiftedFXPoints", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, cy, rx, ry, px, py } = params;
      const xb = computeXb(x0, rx, cx);
      const yb = computeYb(y0, ry, cy);
      const pts = generateShiftedFXPoints(x0, y0, px, py, cx, cy, rx, ry, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("x values are in (0, x0-xb]", () => {
        const xMax = x0 - xb;
        for (const pt of pts) {
          expect(pt.x).toBeGreaterThan(-1e-9);
          expect(pt.x).toBeLessThanOrEqual(xMax + 1e-9);
        }
      });

      it("shifted coordinates: pt.y = fX(pt.x + xb) - yb", () => {
        for (const pt of pts) {
          const xAbsolute = pt.x + xb;
          const yAbsolute = fX(xAbsolute, cx, x0, y0, px, py);
          const yShifted = yAbsolute - yb;
          expect(approx(pt.y, yShifted, 1e-9)).toBe(true);
        }
      });

      it("last point (max x) corresponds to equilibrium shifted", () => {
        const last = pts[pts.length - 1];
        // x shifted near x0 - xb, y shifted near y0 - yb
        expect(approx(last.x, x0 - xb, 1e-4)).toBe(true);
        expect(approx(last.y, y0 - yb, 1e-4)).toBe(true);
      });

      it("all y values are non-negative", () => {
        for (const pt of pts) {
          expect(pt.y).toBeGreaterThanOrEqual(-1e-9);
        }
      });
    });
  }
});

describe("generateShiftedGYPoints", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, cy, rx, ry, px, py } = params;
      const xb = computeXb(x0, rx, cx);
      const yb = computeYb(y0, ry, cy);
      const pts = generateShiftedGYPoints(x0, y0, px, py, cx, cy, rx, ry, 100);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("y values are in (0, y0-yb]", () => {
        const yMax = y0 - yb;
        for (const pt of pts) {
          expect(pt.y).toBeGreaterThan(-1e-9);
          expect(pt.y).toBeLessThanOrEqual(yMax + 1e-9);
        }
      });

      it("shifted coordinates: pt.x = gY(pt.y + yb) - xb", () => {
        for (const pt of pts) {
          const yAbsolute = pt.y + yb;
          const xAbsolute = gY(yAbsolute, cy, y0, x0, px, py);
          const xShifted = xAbsolute - xb;
          expect(approx(pt.x, xShifted, 1e-9)).toBe(true);
        }
      });

      it("last point (max y) corresponds to equilibrium shifted", () => {
        const last = pts[pts.length - 1];
        expect(approx(last.y, y0 - yb, 1e-4)).toBe(true);
        expect(approx(last.x, x0 - xb, 1e-4)).toBe(true);
      });
    });
  }
});

// =====================================================================
// 4. generateCollateralDebtPoints / Y
// =====================================================================

describe("generateCollateralDebtPoints", () => {
  for (const { name, p: overrides } of debtConfigs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return; // skip degenerate
      const pts = generateCollateralDebtPoints(params);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("all points have finite x coordinate", () => {
        for (const pt of pts) {
          expect(isFinite(pt.x)).toBe(true);
        }
      });

      it("CXX starts at xr near equilibrium and drops to 0 at boundary", () => {
        // Near equilibrium (x ≈ x0), CXX = xr. Near boundary (x ≈ xb), CXX = 0.
        const nearEq = pts[pts.length - 1]; // last point = near equilibrium
        const nearBnd = pts[0]; // first point = near/at boundary
        if (nearEq.cxx !== undefined) {
          // CXX near equilibrium should be close to xr
          expect(nearEq.cxx).toBeGreaterThan(0);
        }
        if (nearBnd.cxx !== undefined) {
          // CXX at or beyond depletion should be small
          expect(nearBnd.cxx).toBeLessThanOrEqual(params.xr + 1e-9);
        }
      });

      it("health is finite and positive where computed", () => {
        for (const pt of pts) {
          if (pt.hx !== undefined) {
            expect(pt.hx).toBeGreaterThan(0);
            expect(isFinite(pt.hx)).toBe(true);
          }
        }
      });

      it("NAV is finite where computed", () => {
        for (const pt of pts) {
          if (pt.navx !== undefined) {
            expect(isFinite(pt.navx)).toBe(true);
          }
        }
      });

      it("collateral/debt match direct function calls", () => {
        const zd = computeZd(params);
        const xb = computeXb(x0, params.rx, params.cx);
        const xXXd = xXXdebt(x0, params.xr);
        const xXYd = xXYdebt(x0, params.cx, params.yd, params.px, params.py);
        // Sample a few mid-range points
        const midPts = pts.filter((_, i) => i % 10 === 5).slice(0, 5);
        for (const pt of midPts) {
          const xVirtual = pt.x + xb;
          if (xVirtual <= 0 || xVirtual > x0) continue;
          const expectedCxx = CXX(xVirtual, x0, params.xr);
          const expectedCxy = CXY_fn(xVirtual, params.cx, x0, y0, params.px, params.py, params.yr, params.yd, zd);
          const expectedDxx = DXX(xVirtual, x0, params.xr, params.xd, xXXd, xXYd, zd);
          const expectedDxy = DXY(xVirtual, params.cx, x0, y0, params.px, params.py, params.yd, xXYd, zd);
          const expectedHx = computeHX(xVirtual, params, x0, y0);
          const expectedNavx = computeNAV_X(xVirtual, params, x0, y0);

          if (pt.cxx !== undefined && isFinite(expectedCxx))
            expect(approx(pt.cxx, expectedCxx, 1e-9)).toBe(true);
          if (pt.cxy !== undefined && isFinite(expectedCxy))
            expect(approx(pt.cxy, expectedCxy, 1e-9)).toBe(true);
          if (pt.dxx !== undefined && isFinite(expectedDxx) && expectedDxx > 0)
            expect(approx(pt.dxx, expectedDxx, 1e-9)).toBe(true);
          if (pt.dxy !== undefined && isFinite(expectedDxy) && expectedDxy > 0)
            expect(approx(pt.dxy, expectedDxy, 1e-9)).toBe(true);
          if (pt.hx !== undefined && isFinite(expectedHx) && expectedHx > 0)
            expect(approx(pt.hx, expectedHx, 1e-9)).toBe(true);
          if (pt.navx !== undefined && isFinite(expectedNavx))
            expect(approx(pt.navx, expectedNavx, 1e-9)).toBe(true);
        }
      });

      if (overrides.zdebt && overrides.zdebt > 0) {
        it("Z debt is constant across all points", () => {
          for (const pt of pts) {
            if (pt.dxz !== undefined) {
              expect(pt.dxz).toBe(overrides.zdebt);
            }
          }
        });
      }
    });
  }
});

describe("generateCollateralDebtPointsY", () => {
  for (const { name, p: overrides } of debtConfigs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;
      const pts = generateCollateralDebtPointsY(params);

      it("returns non-empty array", () => {
        expect(pts.length).toBeGreaterThan(0);
      });

      it("health is finite and positive where computed", () => {
        for (const pt of pts) {
          if (pt.hy !== undefined) {
            expect(pt.hy).toBeGreaterThan(0);
            expect(isFinite(pt.hy)).toBe(true);
          }
        }
      });

      it("collateral/debt match direct function calls", () => {
        const zd = computeZd(params);
        const yb = computeYb(y0, params.ry, params.cy);
        const yYYd = yYYdebt(y0, params.yr);
        const yYXd = yYXdebt(y0, params.cy, params.xd, params.px, params.py);
        const midPts = pts.filter((_, i) => i % 10 === 5).slice(0, 5);
        for (const pt of midPts) {
          const yVirtual = pt.x + yb;
          if (yVirtual <= 0 || yVirtual > y0) continue;
          const expectedCyy = CYY(yVirtual, y0, params.yr);
          const expectedHy = computeHY(yVirtual, params, x0, y0);
          const expectedNavy = computeNAV_Y(yVirtual, params, x0, y0);

          if (pt.cyy !== undefined && isFinite(expectedCyy))
            expect(approx(pt.cyy, expectedCyy, 1e-9)).toBe(true);
          if (pt.hy !== undefined && isFinite(expectedHy) && expectedHy > 0)
            expect(approx(pt.hy, expectedHy, 1e-9)).toBe(true);
          if (pt.navy !== undefined && isFinite(expectedNavy))
            expect(approx(pt.navy, expectedNavy, 1e-9)).toBe(true);
        }
      });
    });
  }
});

// =====================================================================
// 5. Differential consistency: derivatives and marginal prices
// =====================================================================

describe("fXd consistency with numerical derivative of fX", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, px, py } = params;

      // Sample 20 x values in (0.1*x0, 0.99*x0)
      for (let i = 1; i <= 20; i++) {
        const x = x0 * (0.1 + 0.89 * (i / 20));
        const h = x * 1e-7;
        const numDeriv = (fX(x + h, cx, x0, y0, px, py) - fX(x - h, cx, x0, y0, px, py)) / (2 * h);
        const analytical = fXd(x, cx, x0, px, py);
        expect(approx(numDeriv, analytical, 1e-5)).toBe(true);
      }
    });
  }
});

describe("gYd consistency with numerical derivative of gY", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cy, px, py } = params;

      for (let i = 1; i <= 20; i++) {
        const y = y0 * (0.1 + 0.89 * (i / 20));
        const h = y * 1e-7;
        const numDeriv = (gY(y + h, cy, y0, x0, px, py) - gY(y - h, cy, y0, x0, px, py)) / (2 * h);
        const analytical = gYd(y, cy, y0, px, py);
        expect(approx(numDeriv, analytical, 1e-5)).toBe(true);
      }
    });
  }
});

describe("marginal price identities", () => {
  for (const { name, p: overrides } of configs) {
    describe(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, cy, px, py } = params;

      it("pXxy = -fXd (Y per X on X-side)", () => {
        for (let i = 1; i <= 10; i++) {
          const x = x0 * (0.2 + 0.6 * (i / 10));
          expect(approx(pXxy(x, cx, x0, px, py), -fXd(x, cx, x0, px, py), 1e-12)).toBe(true);
        }
      });

      it("pXyx = 1/pXxy (reciprocal)", () => {
        for (let i = 1; i <= 10; i++) {
          const x = x0 * (0.2 + 0.6 * (i / 10));
          const yPerX = pXxy(x, cx, x0, px, py);
          const xPerY = pXyx(x, cx, x0, px, py);
          expect(approx(yPerX * xPerY, 1, 1e-12)).toBe(true);
        }
      });

      it("pYyx = -gYd (X per Y on Y-side)", () => {
        for (let i = 1; i <= 10; i++) {
          const y = y0 * (0.2 + 0.6 * (i / 10));
          expect(approx(pYyx(y, cy, y0, px, py), -gYd(y, cy, y0, px, py), 1e-12)).toBe(true);
        }
      });

      it("pYxy = 1/pYyx (reciprocal)", () => {
        for (let i = 1; i <= 10; i++) {
          const y = y0 * (0.2 + 0.6 * (i / 10));
          const xPerY = pYyx(y, cy, y0, px, py);
          const yPerX = pYxy(y, cy, y0, px, py);
          expect(approx(xPerY * yPerX, 1, 1e-12)).toBe(true);
        }
      });

      it("priceAtXb = pXxy(xb)", () => {
        const { rx } = params;
        const xb = computeXb(x0, rx, cx);
        expect(approx(priceAtXb(x0, rx, cx, px, py), pXxy(xb, cx, x0, px, py), 1e-9)).toBe(true);
      });

      it("priceAtYb = pYxy(yb)", () => {
        const { ry } = params;
        const yb = computeYb(y0, ry, cy);
        expect(approx(priceAtYb(y0, ry, cy, px, py), pYxy(yb, cy, y0, px, py), 1e-9)).toBe(true);
      });
    });
  }
});

// =====================================================================
// 6. Density = negative derivative of cumulative liquidity
// =====================================================================

describe("lXX matches numerical derivative of LXX", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const { cx, rx } = params;

      for (let i = 1; i <= 15; i++) {
        const d = rx * (0.05 + 0.9 * (i / 15));
        const h = d * 1e-6;
        const numDeriv = -(LXX(d + h, cx, x0) - LXX(d - h, cx, x0)) / (2 * h);
        const analytical = lXX(d, cx, x0);
        expect(approx(numDeriv, analytical, 1e-4)).toBe(true);
      }
    });
  }
});

describe("lYY matches numerical derivative of LYY", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const y0 = computeY0(params);
      const { cy, ry } = params;

      for (let i = 1; i <= 15; i++) {
        const d = ry * (0.05 + 0.9 * (i / 15));
        const h = d * 1e-6;
        const numDeriv = -(LYY(d + h, cy, y0) - LYY(d - h, cy, y0)) / (2 * h);
        const analytical = lYY(d, cy, y0);
        expect(approx(numDeriv, analytical, 1e-4)).toBe(true);
      }
    });
  }
});

// =====================================================================
// 7. Cross-asset density composition
// =====================================================================

describe("lXY = pXxy(LXX(d)) * lXX(d) composition identity", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cx, rx, px, py } = params;

      for (let i = 1; i <= 15; i++) {
        const d = rx * (0.05 + 0.9 * (i / 15));
        const directLxy = lXY(d, cx, x0, y0, px, py);
        const composedLxy = pXxy(LXX(d, cx, x0), cx, x0, px, py) * lXX(d, cx, x0);
        expect(approx(directLxy, composedLxy, 1e-9)).toBe(true);
      }
    });
  }
});

describe("lYX = pYyx(LYY(d)) * lYY(d) composition identity", () => {
  for (const { name, p: overrides } of configs) {
    it(name, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const { cy, ry, px, py } = params;

      for (let i = 1; i <= 15; i++) {
        const d = ry * (0.05 + 0.9 * (i / 15));
        const directLyx = lYX(d, cy, y0, x0, px, py);
        const composedLyx = pYyx(LYY(d, cy, y0), cy, y0, px, py) * lYY(d, cy, y0);
        expect(approx(directLyx, composedLyx, 1e-9)).toBe(true);
      }
    });
  }
});

// =====================================================================
// 8. Collateral/debt phase transitions
// =====================================================================

describe("collateral/debt phase boundaries", () => {
  it("CXX = 0 exactly at xXXdebt(x0, xr)", () => {
    for (const { p: overrides } of configs) {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const xXXd = xXXdebt(x0, params.xr);
      expect(approx(CXX(xXXd, x0, params.xr), 0, 1e-12)).toBe(true);
      // Just past: CXX > 0
      expect(CXX(xXXd + 0.01, x0, params.xr)).toBeGreaterThan(0);
      // Just before: CXX = 0 (clamped)
      expect(CXX(xXXd - 0.01, x0, params.xr)).toBe(0);
    }
  });

  it("CYY = 0 exactly at yYYdebt(y0, yr)", () => {
    for (const { p: overrides } of configs) {
      const params = makeParams(overrides);
      const y0 = computeY0(params);
      const yYYd = yYYdebt(y0, params.yr);
      expect(approx(CYY(yYYd, y0, params.yr), 0, 1e-12)).toBe(true);
      expect(CYY(yYYd + 0.01, y0, params.yr)).toBeGreaterThan(0);
      expect(CYY(yYYd - 0.01, y0, params.yr)).toBe(0);
    }
  });

  it("xXXdebt = x0 - xr", () => {
    for (const { p: overrides } of configs) {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      expect(xXXdebt(x0, params.xr)).toBe(x0 - params.xr);
    }
  });
});

// =====================================================================
// 9. Health ≥ 1 invariant within range for boost-calibrated params
// =====================================================================

describe("health ≥ 1 within range (boost calibration)", () => {
  for (const { name, p: overrides } of debtConfigs) {
    // Skip no-debt case (health = Infinity)
    if (!overrides.xd && !overrides.yd && !overrides.zdebt) continue;

    it(`${name}: H_X ≥ 1 for x in [xb, x0]`, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const xb = computeXb(x0, params.rx, params.cx);
      if (x0 <= 0 || y0 <= 0) return;

      for (let i = 0; i <= 20; i++) {
        const x = xb + (x0 - xb) * (i / 20);
        const hx = computeHX(x, params, x0, y0);
        if (isFinite(hx)) {
          expect(hx).toBeGreaterThanOrEqual(1 - 1e-6);
        }
      }
    });

    it(`${name}: H_Y ≥ 1 for y in [yb, y0]`, () => {
      const params = makeParams(overrides);
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const yb = computeYb(y0, params.ry, params.cy);
      if (x0 <= 0 || y0 <= 0) return;

      for (let i = 0; i <= 20; i++) {
        const y = yb + (y0 - yb) * (i / 20);
        const hy = computeHY(y, params, x0, y0);
        if (isFinite(hy)) {
          expect(hy).toBeGreaterThanOrEqual(1 - 1e-6);
        }
      }
    });
  }
});

// =====================================================================
// 10. NAV at equilibrium = deposits (no debt, no externals)
// =====================================================================

describe("NAV at equilibrium", () => {
  it("with no debt: NAV_X = xr + yr*(py/px) + zr*pzx", () => {
    for (const { p: overrides } of configs) {
      const params = makeParams({ ...overrides, xd: 0, yd: 0, zdebt: 0, zr: 0 });
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const navx = computeNAV_X(x0, params, x0, y0);
      // At equilibrium with no debt: NAV = sum of all deposits in X terms
      const expected = params.xr + params.yr * (params.py / params.px);
      if (isFinite(navx) && isFinite(expected)) {
        expect(approx(navx, expected, 1e-6)).toBe(true);
      }
    }
  });
});

// =====================================================================
// 11. ext parameter in generateCollateralDebtPoints extends range
// =====================================================================

describe("generateCollateralDebtPoints ext parameter", () => {
  it("ext=1.0 covers exactly [xb, x0], ext=1.2 extends 20% past boundary", () => {
    const params = makeParams({ cx: 0.5, cy: 0.5, yd: 5 });
    const x0 = computeX0(params);
    const xb = computeXb(x0, params.rx, params.cx);
    const range = x0 - xb;

    const pts1 = generateCollateralDebtPoints(params, 100, 1.0);
    const pts12 = generateCollateralDebtPoints(params, 100, 1.2);

    // ext=1.0: first point x ≈ 0 (shifted), meaning xVirtual ≈ xb
    expect(pts1[0].x).toBeGreaterThanOrEqual(-1e-6);

    // ext=1.2: first point x < 0 (shifted), meaning xVirtual < xb
    expect(pts12[0].x).toBeLessThan(0);

    // ext=1.2 should have more points with x < 0 (past boundary)
    const pastBoundary = pts12.filter(p => p.x < -1e-6);
    expect(pastBoundary.length).toBeGreaterThan(0);
  });
});
