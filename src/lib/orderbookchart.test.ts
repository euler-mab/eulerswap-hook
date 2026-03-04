/**
 * Fuzz tests for OrderBookChart x-axis mapping correctness.
 *
 * Verifies that the depth chart's priceDelta→logPrice mapping
 * (xLogP / yLogP) matches the actual marginal price from the AMM curve,
 * and that swap input/output amounts and effective prices are consistent.
 */

import { describe, it, expect } from "vitest";
import {
  Params, defaultParams,
  computeX0, computeY0, computeXb, computeYb,
  computeSx, computeSy,
  pXxy, pXyx, pYxy, pYyx,
  priceAtXb, priceAtYb,
  fX, gY, fY, gX,
  LXX, LYY, LXY, LYX,
  generateOrderBookPointsX, generateOrderBookPointsY,
  computeZd,
} from "./math";

// ─── helpers ────────────────────────────────────────────────────────

/** The new xLogP: actual marginal price for X side */
function xLogP(d: number, logEq: number) {
  return logEq + Math.log(1 + d);
}

/** The new yLogP: actual marginal price for Y side */
function yLogP(d: number, logEq: number) {
  return logEq - Math.log(1 + d);
}

function approx(a: number, b: number, tol = 1e-6) {
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) < tol * (1 + Math.abs(a) + Math.abs(b));
}

/** Build params for testing with various cx/cy/rx/ry/px/py */
function makeParams(overrides: Partial<Params> = {}): Params {
  return {
    ...defaultParams,
    xd: 0, yd: 0, zdebt: 0, // no debt by default
    ...overrides,
  };
}

// ─── test cases ────────────────────────────────────────────────────

const cases: { name: string; p: Partial<Params> }[] = [
  { name: "cx=0, cy=0 (constant product)", p: { cx: 0, cy: 0 } },
  { name: "cx=0.5, cy=0.5 (moderate concentration)", p: { cx: 0.5, cy: 0.5 } },
  { name: "cx=0.8, cy=0.3 (asymmetric)", p: { cx: 0.8, cy: 0.3, rx: 0.5, ry: 2.0 } },
  { name: "px=2000, py=1 (ETH/USDC-like)", p: { px: 2000, py: 1, cx: 0.3, cy: 0.3 } },
  { name: "px=1, py=2000 (inverted)", p: { px: 1, py: 2000, cx: 0.4, cy: 0.4 } },
  { name: "narrow range rx=0.1", p: { rx: 0.1, ry: 0.1, cx: 0.7, cy: 0.7 } },
  { name: "wide range rx=5", p: { rx: 5, ry: 5, cx: 0, cy: 0 } },
  { name: "asymmetric deposits", p: { xr: 50, yr: 2, cx: 0.3, cy: 0.6 } },
  { name: "Z debt active", p: { zdebt: 10, cx: 0.5, cy: 0.5 } },
  { name: "X debt active", p: { xd: 5, zdebt: 0, cx: 0.3, cy: 0.3 } },
];

describe("xLogP/yLogP matches actual marginal price", () => {
  for (const { name, p: overrides } of cases) {
    describe(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      const pRatio = px / py;
      const logEq = Math.log(pRatio);

      it("X side: xLogP(d) = log(pXxy(x)) at sampled d values", () => {
        if (x0 <= 0) return;
        const nSamples = 20;
        for (let i = 1; i <= nSamples; i++) {
          const d = rx * (i / nSamples) * 0.99; // stay within boundary
          const x = computeXb(x0, d, cx);
          const marginalYperX = pXxy(x, cx, x0, px, py); // Y per X
          const logMarginal = Math.log(marginalYperX);
          const logChart = xLogP(d, logEq);
          expect(approx(logChart, logMarginal)).toBe(true);
        }
      });

      it("Y side: yLogP(d) = log(pYxy(y)) at sampled d values", () => {
        if (y0 <= 0) return;
        const nSamples = 20;
        for (let i = 1; i <= nSamples; i++) {
          const d = ry * (i / nSamples) * 0.99;
          const y = computeYb(y0, d, cy);
          const marginalYperX = pYxy(y, cy, y0, px, py); // Y per X
          const logMarginal = Math.log(marginalYperX);
          const logChart = yLogP(d, logEq);
          expect(approx(logChart, logMarginal)).toBe(true);
        }
      });
    });
  }
});

describe("boundary prices align with xLogP/yLogP at d=rx/ry", () => {
  for (const { name, p: overrides } of cases) {
    it(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      const pRatio = px / py;
      const logEq = Math.log(pRatio);

      // X boundary: xLogP(rx) should equal log(priceAtXb)
      const pXb = priceAtXb(x0, rx, cx, px, py);
      expect(approx(xLogP(rx, logEq), Math.log(pXb))).toBe(true);

      // Y boundary: yLogP(ry) should equal log(priceAtYb)
      const pYb = priceAtYb(y0, ry, cy, px, py);
      expect(approx(yLogP(ry, logEq), Math.log(pYb))).toBe(true);

      // X boundary should be ABOVE equilibrium
      expect(pXb).toBeGreaterThan(pRatio);
      // Y boundary should be BELOW equilibrium
      expect(pYb).toBeLessThan(pRatio);
    });
  }
});

describe("depth chart data: cumulative amounts match AMM curve", () => {
  for (const { name, p: overrides } of cases) {
    describe(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      it("X side: cumulative X sold matches x0 - LXX(d)", () => {
        const xPts = generateOrderBookPointsX(x0, y0, cx, rx, px, py, 50);
        for (const pt of xPts) {
          const d = pt.priceDelta;
          const expectedRemaining = computeXb(x0, d, cx);
          expect(approx(pt.cumSame, expectedRemaining)).toBe(true);
        }
      });

      it("Y side: cumulative Y sold matches y0 - LYY(d)", () => {
        const yPts = generateOrderBookPointsY(x0, y0, cy, ry, px, py, 50);
        for (const pt of yPts) {
          const d = pt.priceDelta;
          const expectedRemaining = computeYb(y0, d, cy);
          expect(approx(pt.cumSame, expectedRemaining)).toBe(true);
        }
      });
    });
  }
});

describe("swap input/output amounts & effective price", () => {
  for (const { name, p: overrides } of cases) {
    describe(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      const pRatio = px / py;
      const logEq = Math.log(pRatio);

      it("X side: selling X → receiving Y, effective price converges to marginal", () => {
        // At priceDelta d, virtual position is (x, y) = (LXX(d), fX(LXX(d)))
        // A small ε of X sold: dy/dx ≈ pXxy at that point
        const nSamples = 10;
        for (let i = 1; i <= nSamples; i++) {
          const d = rx * (i / nSamples) * 0.9;
          const x = LXX(d, cx, x0);
          const y = fX(x, cx, x0, y0, px, py);
          if (!isFinite(y)) continue;

          // Small perturbation
          const eps = x * 1e-6;
          const x2 = x - eps; // sell eps of X
          if (x2 <= 0) continue;
          const y2 = fX(x2, cx, x0, y0, px, py);
          if (!isFinite(y2)) continue;

          const deltaX = x - x2; // X sold (positive)
          const deltaY = y2 - y; // Y received (positive)
          const effectivePrice = deltaY / deltaX; // Y per X

          // Should match marginal price pXxy
          const marginal = pXxy(x, cx, x0, px, py);
          expect(approx(effectivePrice, marginal, 1e-4)).toBe(true);

          // And xLogP(d) should give log of this marginal price
          expect(approx(xLogP(d, logEq), Math.log(marginal), 1e-4)).toBe(true);
        }
      });

      it("Y side: selling Y → receiving X, effective price converges to marginal", () => {
        const nSamples = 10;
        for (let i = 1; i <= nSamples; i++) {
          const d = ry * (i / nSamples) * 0.9;
          const y = LYY(d, cy, y0);
          const x = gY(y, cy, y0, x0, px, py);
          if (!isFinite(x)) continue;

          const eps = y * 1e-6;
          const y2 = y - eps; // sell eps of Y
          if (y2 <= 0) continue;
          const x2 = gY(y2, cy, y0, x0, px, py);
          if (!isFinite(x2)) continue;

          const deltaY = y - y2; // Y sold (positive)
          const deltaX = x2 - x; // X received (positive)
          const effectivePriceYperX = deltaY / deltaX; // Y per X

          // pYxy gives Y per X at that position
          const marginalYperX = pYxy(y, cy, y0, px, py);
          expect(approx(effectivePriceYperX, marginalYperX, 1e-4)).toBe(true);

          // And yLogP(d) should give log of this marginal price
          expect(approx(yLogP(d, logEq), Math.log(marginalYperX), 1e-4)).toBe(true);
        }
      });

      it("cumulative cross-asset amounts match curve evaluation", () => {
        // LXY(d) = fX(LXX(d)) = total Y at position after selling X through d
        // Cumulative Y received from selling X = LXY(d) - y0
        const nSamples = 5;
        for (let i = 1; i <= nSamples; i++) {
          const d = rx * (i / nSamples) * 0.9;
          const xPos = LXX(d, cx, x0);
          const yFromCurve = fX(xPos, cx, x0, y0, px, py);
          const yFromLXY = LXY(d, cx, x0, y0, px, py);
          if (!isFinite(yFromCurve) || !isFinite(yFromLXY)) continue;
          expect(approx(yFromCurve, yFromLXY)).toBe(true);
        }
      });
    });
  }
});

describe("depletion price matches xLogP/yLogP at depletion d", () => {
  for (const { name, p: overrides } of cases) {
    it(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry, xr, yr } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      const xb = computeXb(x0, rx, cx);
      const yb = computeYb(y0, ry, cy);
      const pRatio = px / py;
      const logEq = Math.log(pRatio);

      // X depletion: CXX=0 at x = x0-xr
      const xDeplV = x0 - xr;
      if (xDeplV > xb && xDeplV < x0) {
        // Marginal price at depletion
        const marginal = pXxy(xDeplV, cx, x0, px, py);
        const logPXDepl = Math.log(marginal);

        // Find the d where LXX(d) = x0 - xr, i.e. computeXb(x0, d, cx) = x0 - xr
        // d = (1-cx)*((x0/(x0-xr))^2 - 1)
        const dDepl = (1 - cx) * ((x0 / (x0 - xr)) ** 2 - 1);
        const logFromXLogP = xLogP(dDepl, logEq);

        // These should match
        expect(approx(logFromXLogP, logPXDepl)).toBe(true);

        // Depletion should be between equilibrium and boundary
        expect(logPXDepl).toBeGreaterThan(logEq - 1e-9);
        const logPXb = Math.log(priceAtXb(x0, rx, cx, px, py));
        expect(logPXDepl).toBeLessThanOrEqual(logPXb + 1e-9);
      }

      // Y depletion: CYY=0 at y = y0-yr
      const yDeplV = y0 - yr;
      if (yDeplV > yb && yDeplV < y0) {
        const marginal = pYxy(yDeplV, cy, y0, px, py);
        const logPYDepl = Math.log(marginal);

        const dDepl = (1 - cy) * ((y0 / (y0 - yr)) ** 2 - 1);
        const logFromYLogP = yLogP(dDepl, logEq);

        expect(approx(logFromYLogP, logPYDepl)).toBe(true);

        // Depletion should be between equilibrium and boundary
        expect(logPYDepl).toBeLessThan(logEq + 1e-9);
        const logPYb = Math.log(priceAtYb(y0, ry, cy, px, py));
        expect(logPYDepl).toBeGreaterThanOrEqual(logPYb - 1e-9);
      }
    });
  }
});

describe("X side = ask (RIGHT), Y side = bid (LEFT) direction", () => {
  for (const { name, p: overrides } of cases) {
    it(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      const pRatio = px / py;
      const logEq = Math.log(pRatio);

      // X side (ask): xLogP should INCREASE from logEq
      const d1 = rx * 0.3;
      const d2 = rx * 0.6;
      expect(xLogP(d1, logEq)).toBeGreaterThan(logEq);
      expect(xLogP(d2, logEq)).toBeGreaterThan(xLogP(d1, logEq));

      // Y side (bid): yLogP should DECREASE from logEq
      expect(yLogP(d1, logEq)).toBeLessThan(logEq);
      expect(yLogP(d2, logEq)).toBeLessThan(yLogP(d1, logEq));
    });
  }
});

describe("effective price of finite-size swap", () => {
  // Verify that for a non-infinitesimal swap, the effective price
  // falls between the marginal prices at start and end of the swap.
  for (const { name, p: overrides } of cases) {
    describe(name, () => {
      const params = makeParams(overrides);
      const { px, py, cx, cy, rx, ry } = params;
      const x0 = computeX0(params);
      const y0 = computeY0(params);
      if (x0 <= 0 || y0 <= 0) return;

      it("X side: finite swap effective price is between start/end marginals", () => {
        const d1 = rx * 0.2;
        const d2 = rx * 0.5;
        const x1 = LXX(d1, cx, x0);
        const x2 = LXX(d2, cx, x0);
        const y1 = fX(x1, cx, x0, y0, px, py);
        const y2 = fX(x2, cx, x0, y0, px, py);
        if (!isFinite(y1) || !isFinite(y2)) return;

        const deltaX = x1 - x2; // X sold
        const deltaY = y2 - y1; // Y received
        if (deltaX <= 0 || deltaY <= 0) return;
        const effPrice = deltaY / deltaX; // Y per X

        const marginalStart = pXxy(x1, cx, x0, px, py);
        const marginalEnd = pXxy(x2, cx, x0, px, py);

        // Effective price should be between start and end marginals
        expect(effPrice).toBeGreaterThanOrEqual(marginalStart * (1 - 1e-9));
        expect(effPrice).toBeLessThanOrEqual(marginalEnd * (1 + 1e-9));
      });

      it("Y side: finite swap effective price is between start/end marginals", () => {
        const d1 = ry * 0.2;
        const d2 = ry * 0.5;
        const y1 = LYY(d1, cy, y0);
        const y2 = LYY(d2, cy, y0);
        const x1 = gY(y1, cy, y0, x0, px, py);
        const x2 = gY(y2, cy, y0, x0, px, py);
        if (!isFinite(x1) || !isFinite(x2)) return;

        const deltaY = y1 - y2; // Y sold
        const deltaX = x2 - x1; // X received
        if (deltaY <= 0 || deltaX <= 0) return;

        // Effective price in Y per X = deltaY / deltaX
        const effPriceYperX = deltaY / deltaX;

        const marginalStart = pYxy(y1, cy, y0, px, py);
        const marginalEnd = pYxy(y2, cy, y0, px, py);

        // Y side: marginal price DECREASES, so start > end
        // Effective price should be between end and start
        const lo = Math.min(marginalStart, marginalEnd);
        const hi = Math.max(marginalStart, marginalEnd);
        expect(effPriceYperX).toBeGreaterThanOrEqual(lo * (1 - 1e-9));
        expect(effPriceYperX).toBeLessThanOrEqual(hi * (1 + 1e-9));
      });
    });
  }
});

describe("Z debt: depletion at boundary when no leverage", () => {
  it("with Z debt and bxl=1, x depletes exactly at boundary", () => {
    // With Z debt, leverage boost bxl = 1, so x0 = xr * bxc
    // Depletion: x0 - xr = xr*(bxc-1) = xr/(sx-1) = xb
    const params = makeParams({
      xd: 0, yd: 0, zdebt: 10, // Z debt mode
      cx: 0.5, cy: 0.5,
      rx: 1, ry: 1,
      xr: 10, yr: 10,
    });

    const x0 = computeX0(params);
    const y0 = computeY0(params);
    const xb = computeXb(x0, params.rx, params.cx);
    const yb = computeYb(y0, params.ry, params.cy);

    // x0 - xr should equal xb (depletion = boundary)
    expect(approx(x0 - params.xr, xb, 1e-9)).toBe(true);
    expect(approx(y0 - params.yr, yb, 1e-9)).toBe(true);
  });
});
