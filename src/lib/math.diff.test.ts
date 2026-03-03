/**
 * Differential tests: TypeScript math vs Solidity CurveLib
 *
 * Spins up a local anvil node, deploys the CurveHarness wrapper contract,
 * then uses fast-check to feed identical inputs to both implementations
 * and assert outputs match within tolerance.
 *
 * Mapping:
 *   Solidity f(x, px, py, x0, y0, cx)        ↔  TS fX(x, cx, x0, y0, px, py)    [X-side forward]
 *   Solidity f(y, py, px, y0, x0, cy)         ↔  TS gY(y, cy, y0, x0, px, py)    [Y-side forward]
 *   Solidity fInverse(y, px, py, x0, y0, cx)  ↔  TS gX(y, cx, y0, x0, px, py)    [X-side inverse]
 *   Solidity fInverse(x, py, px, y0, x0, cy)  ↔  TS fY(x, cy, x0, y0, px, py)    [Y-side inverse]
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { execSync, spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { fX, gY, fY, gX } from "./math";

// ============================================================================
// Constants
// ============================================================================

const WAD = 10n ** 18n;
const MAX_UINT112 = (1n << 112n) - 1n;

// Anvil's default pre-funded account
const ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// ============================================================================
// Helpers
// ============================================================================

/** Wait for anvil to respond to JSON-RPC requests. */
async function waitForAnvil(url: string, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Anvil not ready after ${timeout}ms`);
}

/**
 * Assert Solidity (bigint) and TypeScript (number) results are close.
 *
 * Tolerance: max(3, |sol| * 1e-9).
 *   - The 3 absolute accounts for Solidity's round-up (≤2 wei) plus 1 margin.
 *   - The 1e-9 relative accounts for IEEE 754 float accumulation.
 */
function assertClose(solVal: bigint, tsVal: number, label: string): void {
  const solNum = Number(solVal);
  const diff = Math.abs(solNum - tsVal);
  const tol = Math.max(3, Math.abs(solNum) * 1e-9);
  expect(
    diff,
    `${label}: sol=${solNum}, ts=${tsVal}, diff=${diff}, tol=${tol}`
  ).toBeLessThanOrEqual(tol);
}

/** Convert float to WAD-scaled bigint (for prices and concentration). */
function toWad(x: number): bigint {
  return BigInt(Math.round(x * 1e18));
}

// ============================================================================
// Arbitraries
// ============================================================================

/** Concentration: [0, 0.99] — excludes 1.0 (degenerate in TS). */
const arbConc = fc.double({ min: 0, max: 0.99, noNaN: true });

/** Price: [0.01, 100]. */
const arbPrice = fc.double({ min: 0.01, max: 100, noNaN: true });

/** Equilibrium reserve: integer [100, 1e9]. Keep below 1e12 for float safety. */
const arbEq = fc.integer({ min: 100, max: 1_000_000_000 });

/** Fraction of x0 for test point x: (0, 1]. */
const arbFrac = fc.double({ min: 0.001, max: 1.0, noNaN: true });

// ============================================================================
// Test suite
// ============================================================================

describe("Differential: TypeScript vs Solidity CurveLib", () => {
  let publicClient: PublicClient<Transport, Chain>;
  let anvilProcess: ChildProcess;
  let harnessAddress: `0x${string}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let abi: any[];

  // --- Solidity call wrappers ---

  async function solF(
    x: bigint,
    px: bigint,
    py: bigint,
    x0: bigint,
    y0: bigint,
    c: bigint
  ): Promise<bigint> {
    return publicClient.readContract({
      address: harnessAddress,
      abi,
      functionName: "f",
      args: [x, px, py, x0, y0, c],
    }) as Promise<bigint>;
  }

  async function solFInverse(
    y: bigint,
    px: bigint,
    py: bigint,
    x0: bigint,
    y0: bigint,
    cx: bigint
  ): Promise<bigint> {
    return publicClient.readContract({
      address: harnessAddress,
      abi,
      functionName: "fInverse",
      args: [y, px, py, x0, y0, cx],
    }) as Promise<bigint>;
  }

  // --- Setup / teardown ---

  beforeAll(async () => {
    // Compile harness
    const contractsDir = join(__dirname, "../../contracts");
    execSync("forge build", { cwd: contractsDir, stdio: "pipe" });

    // Start anvil on a random port to avoid conflicts
    const port = 8546 + Math.floor(Math.random() * 1000);
    anvilProcess = spawn("anvil", ["--port", String(port), "--silent"], {
      stdio: "ignore",
      detached: false,
    });

    const rpcUrl = `http://127.0.0.1:${port}`;
    await waitForAnvil(rpcUrl);

    // Read compiled artifact
    const artifact = JSON.parse(
      readFileSync(
        join(contractsDir, "out/CurveHarness.sol/CurveHarness.json"),
        "utf8"
      )
    );
    abi = artifact.abi;
    const bytecode = artifact.bytecode.object as `0x${string}`;

    // Create clients
    const account = privateKeyToAccount(ANVIL_KEY);
    const transport = http(rpcUrl);

    const walletClient = createWalletClient({
      account,
      chain: foundry,
      transport,
    });
    publicClient = createPublicClient({ chain: foundry, transport });

    // Deploy harness
    const hash = await walletClient.deployContract({ abi, bytecode });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    harnessAddress = receipt.contractAddress!;
  }, 30_000);

  afterAll(() => {
    anvilProcess?.kill();
  });

  // ========================================================================
  // 1. Forward curve (X-side): Solidity f() vs TypeScript fX()
  // ========================================================================

  describe("f forward curve (X-side): fX", () => {
    it("should match for random inputs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEq,
          arbEq,
          arbFrac,
          arbPrice,
          arbPrice,
          arbConc,
          async (x0Num, y0Num, xFrac, px, py, cx) => {
            const x0 = BigInt(x0Num);
            const y0 = BigInt(y0Num);
            const x = BigInt(Math.max(1, Math.round(x0Num * xFrac)));
            const pxWad = toWad(px);
            const pyWad = toWad(py);
            const cxWad = toWad(cx);

            const ySol = await solF(x, pxWad, pyWad, x0, y0, cxWad);
            fc.pre(ySol <= MAX_UINT112); // skip overflows

            const yTs = fX(Number(x), cx, Number(x0), Number(y0), px, py);
            fc.pre(isFinite(yTs) && !isNaN(yTs));

            assertClose(ySol, yTs, "f X-side");
          }
        ),
        { numRuns: 200 }
      );
    }, 120_000);
  });

  // ========================================================================
  // 2. Forward curve (Y-side): Solidity f(y, py, px, y0, x0, cy) vs TS gY()
  // ========================================================================

  describe("f forward curve (Y-side): gY", () => {
    it("should match for random inputs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEq,
          arbEq,
          arbFrac,
          arbPrice,
          arbPrice,
          arbConc,
          async (x0Num, y0Num, yFrac, px, py, cy) => {
            const x0 = BigInt(x0Num);
            const y0 = BigInt(y0Num);
            const y = BigInt(Math.max(1, Math.round(y0Num * yFrac)));
            const pxWad = toWad(px);
            const pyWad = toWad(py);
            const cyWad = toWad(cy);

            // Note: swap prices and equilibria for Y-side
            const xSol = await solF(y, pyWad, pxWad, y0, x0, cyWad);
            fc.pre(xSol <= MAX_UINT112);

            const xTs = gY(Number(y), cy, Number(y0), Number(x0), px, py);
            fc.pre(isFinite(xTs) && !isNaN(xTs));

            assertClose(xSol, xTs, "f Y-side");
          }
        ),
        { numRuns: 200 }
      );
    }, 120_000);
  });

  // ========================================================================
  // 3. Inverse curve (X-side): Solidity fInverse() vs TypeScript gX()
  //    Feed y from Solidity f() to ensure valid input.
  // ========================================================================

  describe("fInverse (X-side): gX", () => {
    it("should match for random inputs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEq,
          arbEq,
          arbFrac,
          arbPrice,
          arbPrice,
          arbConc,
          async (x0Num, y0Num, xFrac, px, py, cx) => {
            fc.pre(cx >= 0.001); // fInverse needs non-zero concentration

            const x0 = BigInt(x0Num);
            const y0 = BigInt(y0Num);
            const x = BigInt(Math.max(1, Math.round(x0Num * xFrac)));
            const pxWad = toWad(px);
            const pyWad = toWad(py);
            const cxWad = toWad(cx);

            // Get a valid y >= y0 from the forward curve
            const ySol = await solF(x, pxWad, pyWad, x0, y0, cxWad);
            fc.pre(ySol <= MAX_UINT112);

            // Inverse: Solidity
            const xBackSol = await solFInverse(
              ySol,
              pxWad,
              pyWad,
              x0,
              y0,
              cxWad
            );

            // Inverse: TypeScript (use the Solidity y to test same input)
            const xBackTs = gX(
              Number(ySol),
              cx,
              Number(y0),
              Number(x0),
              px,
              py
            );
            fc.pre(isFinite(xBackTs) && !isNaN(xBackTs));

            assertClose(xBackSol, xBackTs, "fInverse X-side");
          }
        ),
        { numRuns: 200 }
      );
    }, 120_000);
  });

  // ========================================================================
  // 4. Inverse curve (Y-side): Solidity fInverse(x, py, px, y0, x0, cy)
  //    vs TypeScript fY()
  // ========================================================================

  describe("fInverse (Y-side): fY", () => {
    it("should match for random inputs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEq,
          arbEq,
          arbFrac,
          arbPrice,
          arbPrice,
          arbConc,
          async (x0Num, y0Num, yFrac, px, py, cy) => {
            fc.pre(cy >= 0.001);

            const x0 = BigInt(x0Num);
            const y0 = BigInt(y0Num);
            const y = BigInt(Math.max(1, Math.round(y0Num * yFrac)));
            const pxWad = toWad(px);
            const pyWad = toWad(py);
            const cyWad = toWad(cy);

            // Get valid x >= x0 from the Y-side forward curve
            const xSol = await solF(y, pyWad, pxWad, y0, x0, cyWad);
            fc.pre(xSol <= MAX_UINT112);

            // Inverse Y-side: Solidity (swap prices and equilibria)
            const yBackSol = await solFInverse(
              xSol,
              pyWad,
              pxWad,
              y0,
              x0,
              cyWad
            );

            // Inverse Y-side: TypeScript
            const yBackTs = fY(
              Number(xSol),
              cy,
              Number(x0),
              Number(y0),
              px,
              py
            );
            fc.pre(isFinite(yBackTs) && !isNaN(yBackTs));

            assertClose(yBackSol, yBackTs, "fInverse Y-side");
          }
        ),
        { numRuns: 200 }
      );
    }, 120_000);
  });

  // ========================================================================
  // 5. Equilibrium: f(x0) == y0 in both implementations
  // ========================================================================

  describe("equilibrium", () => {
    it("f(x0) should return y0", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEq,
          arbEq,
          arbPrice,
          arbPrice,
          arbConc,
          async (x0Num, y0Num, px, py, cx) => {
            const x0 = BigInt(x0Num);
            const y0 = BigInt(y0Num);
            const pxWad = toWad(px);
            const pyWad = toWad(py);
            const cxWad = toWad(cx);

            const ySol = await solF(x0, pxWad, pyWad, x0, y0, cxWad);
            expect(ySol).toBe(y0);

            const yTs = fX(Number(x0), cx, Number(x0), Number(y0), px, py);
            expect(yTs).toBe(Number(y0));
          }
        ),
        { numRuns: 50 }
      );
    }, 60_000);
  });
});
