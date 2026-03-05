/**
 * Boost integration test: TS boost computation vs on-chain health.
 *
 * For each randomized parameter set, the test:
 *   1. Computes boost / x0 / y0 in TypeScript
 *   2. Checks health at the range boundary in TypeScript (should be ≥ 1)
 *   3. Runs a forge test that deploys a real EulerSwap pool with full Euler
 *      infrastructure and swaps to the boundary — if the EVC health check
 *      passes, the swap succeeds
 *
 * This catches discrepancies between the TS health model and the actual
 * on-chain health enforcement via the EVC.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { execSync } from "child_process";
import { join } from "path";
import {
  computeX0,
  computeY0,
  computeXb,
  computeYb,
  computeHX,
  computeHY,
  validateParams,
  type Params,
} from "./math";

// ============================================================================
// Constants
// ============================================================================

const CONTRACTS_DIR = join(__dirname, "../../contracts");

/** Token decimals — the test base uses 18-decimal tokens. */
const DECIMALS = 18;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);

/** Holder deposits 10 tokens of each asset in EulerSwapTestBase.setUp(). */
const HOLDER_DEPOSIT = 10;

// ============================================================================
// Helpers
// ============================================================================

/** Convert float to WAD-scaled bigint (for prices and concentration). */
function toWad(x: number): bigint {
  return BigInt(Math.round(x * 1e18));
}

/** Convert a token-unit float to its on-chain representation (with decimals). */
function toTokenUnits(x: number): bigint {
  return BigInt(Math.round(x * Number(ONE_TOKEN)));
}

/**
 * Build a constrained Params object matching EulerSwapTestBase defaults.
 *
 * Fixed values (from the test base):
 *   - xr = yr = 10 (holder deposits 10e18 of each token)
 *   - vyx = vxy = 0.9 (LTVs set in setUp)
 *   - vzx = 0.9 (eTST3 collateral on eTST debt)
 *   - All other LTVs = 0
 *   - Z-debt = 0 (deferred to future work)
 */
function buildParams(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  xd: number,
  yd: number,
): Params {
  return {
    vyx: 0.9,
    vxy: 0.9,
    vxz: 0,
    vyz: 0,
    vzx: 0.9,
    vzy: 0,
    px,
    py,
    pxz: 1,
    rx,
    ry,
    cx,
    cy,
    xr: HOLDER_DEPOSIT,
    yr: HOLDER_DEPOSIT,
    zr: 0,
    xd,
    yd,
    zdebt: 0,
    rXX: 0,
    rXY: 0,
    rXZ: 0,
    rYX: 0,
    rYY: 0,
    rYZ: 0,
    eXC: 0,
    eXD: 0,
    eYC: 0,
    eYD: 0,
  };
}

// ============================================================================
// Arbitraries
// ============================================================================

const arbPrice = fc.double({ min: 0.5, max: 2.0, noNaN: true });
const arbConc = fc.double({ min: 0.01, max: 0.9, noNaN: true });
const arbRange = fc.double({ min: 0.1, max: 2.0, noNaN: true });
const arbDebt = fc.double({ min: 0, max: 5, noNaN: true });

/** Generate a param set with either X debt or Y debt (not both). */
const arbParams = fc
  .tuple(arbPrice, arbPrice, arbConc, arbConc, arbRange, arbRange, arbDebt, fc.boolean())
  .map(([px, py, cx, cy, rx, ry, debt, isXDebt]) => {
    const xd = isXDebt ? debt : 0;
    const yd = isXDebt ? 0 : debt;
    return buildParams(px, py, cx, cy, rx, ry, xd, yd);
  });

// ============================================================================
// Test suite
// ============================================================================

describe("Boost integration: TS boost vs on-chain health", () => {
  beforeAll(() => {
    // Ensure contracts are compiled
    execSync("forge build", { cwd: CONTRACTS_DIR, stdio: "pipe" });
  }, 60_000);

  // --------------------------------------------------------------------------
  // TS-only health check at boundary (fast, many cases)
  // --------------------------------------------------------------------------

  describe("TS health at boundary", () => {
    it("health should be ≥ 1.0 at near-boundary for valid params", () => {
      fc.assert(
        fc.property(arbParams, (p) => {
          const warnings = validateParams(p);
          fc.pre(warnings.length === 0);

          const x0 = computeX0(p);
          const y0 = computeY0(p);
          fc.pre(isFinite(x0) && x0 > 0 && isFinite(y0) && y0 > 0);

          const xb = computeXb(x0, p.rx, p.cx);
          const yb = computeYb(y0, p.ry, p.cy);
          fc.pre(xb > 0 && xb < x0 && yb > 0 && yb < y0);

          // Check health slightly inside the boundary (1% margin)
          const xTest = xb + (x0 - xb) * 0.01;
          const yTest = yb + (y0 - yb) * 0.01;

          const hx = computeHX(xTest, p, x0, y0);
          const hy = computeHY(yTest, p, x0, y0);

          // Health should be ≥ 1.0 within the range (boost calibrates H=1 at boundary)
          if (isFinite(hx) && !isNaN(hx) && hx !== Infinity) {
            expect(hx, `HX at x=${xTest}: ${hx}`).toBeGreaterThanOrEqual(0.99);
          }
          if (isFinite(hy) && !isNaN(hy) && hy !== Infinity) {
            expect(hy, `HY at y=${yTest}: ${hy}`).toBeGreaterThanOrEqual(0.99);
          }
        }),
        { numRuns: 500 }
      );
    }, 30_000);
  });

  // --------------------------------------------------------------------------
  // On-chain verification via forge test (slower, fewer cases)
  // --------------------------------------------------------------------------

  describe("Solidity boundary swap", () => {
    it("forge test should pass for TS-computed boost params (X boundary)", () => {
      fc.assert(
        fc.property(arbParams, (p) => {
          const warnings = validateParams(p);
          fc.pre(warnings.length === 0);

          const x0 = computeX0(p);
          const y0 = computeY0(p);
          fc.pre(isFinite(x0) && x0 > 0 && isFinite(y0) && y0 > 0);

          // Skip extreme boosts that would exceed borrow liquidity
          // (depositor has 100e18 + 1000e18 extra = 1100e18 per token)
          const maxReserve = 1100;
          fc.pre(x0 < maxReserve && y0 < maxReserve);

          // Scale to on-chain values
          const X0 = toTokenUnits(x0);
          const Y0 = toTokenUnits(y0);
          const PX = toWad(p.px);
          const PY = toWad(p.py);
          const CX = toWad(p.cx);
          const CY = toWad(p.cy);

          // Sanity: values must fit their Solidity types
          fc.pre(X0 > 0n && X0 < (1n << 112n));
          fc.pre(Y0 > 0n && Y0 < (1n << 112n));
          fc.pre(PX > 0n && PX < (1n << 80n));
          fc.pre(PY > 0n && PY < (1n << 80n));
          fc.pre(CX >= 0n && CX < (1n << 64n));
          fc.pre(CY >= 0n && CY < (1n << 64n));

          const RX = toWad(p.rx);
          const RY = toWad(p.ry);

          const env = {
            ...process.env,
            X0: X0.toString(),
            Y0: Y0.toString(),
            PX: PX.toString(),
            PY: PY.toString(),
            CX: CX.toString(),
            CY: CY.toString(),
            RX: RX.toString(),
            RY: RY.toString(),
          };

          try {
            execSync(
              "forge test --match-test test_xBoundary --match-contract BoostVerifyTest --no-match-path 'eulerswap/**'",
              { cwd: CONTRACTS_DIR, stdio: "pipe", env, timeout: 30_000 }
            );
          } catch (e: unknown) {
            const err = e as { stderr?: Buffer; stdout?: Buffer };
            const stderr = err.stderr?.toString() ?? "";
            const stdout = err.stdout?.toString() ?? "";
            // If the forge test failed, report the details
            throw new Error(
              `forge test_xBoundary failed.\n` +
              `Params: px=${p.px} py=${p.py} cx=${p.cx} cy=${p.cy} rx=${p.rx} ry=${p.ry} ` +
              `xd=${p.xd} yd=${p.yd}\n` +
              `x0=${x0} y0=${y0}\n` +
              `X0=${X0} Y0=${Y0} PX=${PX} PY=${PY} CX=${CX} CY=${CY}\n` +
              `stderr: ${stderr.slice(-500)}\n` +
              `stdout: ${stdout.slice(-500)}`
            );
          }
        }),
        { numRuns: 20 }
      );
    }, 300_000); // 5 min timeout for ~20 forge invocations

    it("forge test should pass for TS-computed boost params (Y boundary)", () => {
      fc.assert(
        fc.property(arbParams, (p) => {
          const warnings = validateParams(p);
          fc.pre(warnings.length === 0);

          const x0 = computeX0(p);
          const y0 = computeY0(p);
          fc.pre(isFinite(x0) && x0 > 0 && isFinite(y0) && y0 > 0);

          const maxReserve = 1100;
          fc.pre(x0 < maxReserve && y0 < maxReserve);

          const X0 = toTokenUnits(x0);
          const Y0 = toTokenUnits(y0);
          const PX = toWad(p.px);
          const PY = toWad(p.py);
          const CX = toWad(p.cx);
          const CY = toWad(p.cy);

          fc.pre(X0 > 0n && X0 < (1n << 112n));
          fc.pre(Y0 > 0n && Y0 < (1n << 112n));
          fc.pre(PX > 0n && PX < (1n << 80n));
          fc.pre(PY > 0n && PY < (1n << 80n));
          fc.pre(CX >= 0n && CX < (1n << 64n));
          fc.pre(CY >= 0n && CY < (1n << 64n));

          const RX = toWad(p.rx);
          const RY = toWad(p.ry);

          const env = {
            ...process.env,
            X0: X0.toString(),
            Y0: Y0.toString(),
            PX: PX.toString(),
            PY: PY.toString(),
            CX: CX.toString(),
            CY: CY.toString(),
            RX: RX.toString(),
            RY: RY.toString(),
          };

          try {
            execSync(
              "forge test --match-test test_yBoundary --match-contract BoostVerifyTest --no-match-path 'eulerswap/**'",
              { cwd: CONTRACTS_DIR, stdio: "pipe", env, timeout: 30_000 }
            );
          } catch (e: unknown) {
            const err = e as { stderr?: Buffer; stdout?: Buffer };
            const stderr = err.stderr?.toString() ?? "";
            const stdout = err.stdout?.toString() ?? "";
            throw new Error(
              `forge test_yBoundary failed.\n` +
              `Params: px=${p.px} py=${p.py} cx=${p.cx} cy=${p.cy} rx=${p.rx} ry=${p.ry} ` +
              `xd=${p.xd} yd=${p.yd}\n` +
              `x0=${x0} y0=${y0}\n` +
              `X0=${X0} Y0=${Y0} PX=${PX} PY=${PY} CX=${CX} CY=${CY}\n` +
              `stderr: ${stderr.slice(-500)}\n` +
              `stdout: ${stdout.slice(-500)}`
            );
          }
        }),
        { numRuns: 20 }
      );
    }, 300_000);
  });
});
