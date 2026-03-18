/**
 * Calibrate USDC/USDT pool parameters for V7 hook deployment.
 *
 * Given equity, LTV, and a chosen range (rx/ry), compute:
 *   - eq0, eq1 (virtual equilibrium reserves) via additive boost
 *   - min0, min1 (boundary reserves where h=1)
 *   - Health verification at boundary
 *
 * Usage: npx tsx scripts/calibrate-usdc-usdt.ts
 */
import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  computeHX, computeHY,
  computeSx,
} from '../src/lib/math';

// ─── On-chain state ─────────────────────────────────────────────────
// Pool: 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8
// Asset0 = USDC, Asset1 = USDT (both 6 decimals)
// Supply vault 0 (USDC): 381.55 USDC deposited, 0 debt
// Supply vault 1 (USDT): 118.97 USDT deposited, 0 debt
// Total equity: ~$500.52
// LTV (both directions, symmetric): borrow 94%, liquidation 96%

const EQUITY_USDC = 381.55;  // xr
const EQUITY_USDT = 118.97;  // yr
const LLTV = 0.96;           // liquidation LTV (symmetric)

// Price: USDC/USDT ≈ 1:1
// On-chain priceX = 999824470000, priceY = 1000052900000
// Oracle: ~0.99983 (V4 pool)
// For calibration purposes, treat as 1:1
const PX = 1;
const PY = 1;

// ─── Sweep range values ─────────────────────────────────────────────
// cx = cy = 0 throughout. We concentrate via range (rx/ry) only.

const RANGES = [0.001, 0.002, 0.003, 0.005, 0.01, 0.02, 0.05, 0.10];

console.log('=== USDC/USDT Pool Calibration ===');
console.log(`Equity: ${EQUITY_USDC} USDC + ${EQUITY_USDT} USDT = $${(EQUITY_USDC + EQUITY_USDT).toFixed(2)}`);
console.log(`LLTV: ${LLTV}`);
console.log(`Concentration: cx=0, cy=0`);
console.log('');

console.log('range(bps) | eq0(USDC)  | eq1(USDT)  | min0       | min1       | depth/side | hX@bound | hY@bound | sx');
console.log('-'.repeat(110));

for (const r of RANGES) {
  const params: Params = {
    vyx: LLTV, vxy: LLTV,
    vxz: 0, vyz: 0, vzx: 0, vzy: 0,
    px: PX, py: PY, pxz: 1,
    rx: r, ry: r,
    cx: 0, cy: 0,
    xr: EQUITY_USDC, yr: EQUITY_USDT,
    zr: 0, xd: 0, yd: 0, zdebt: 0,
    rXX: 0, rXY: 0, rXZ: 0,
    rYX: 0, rYY: 0, rYZ: 0,
    eXC: 0, eXD: 0, eYC: 0, eYD: 0,
  };

  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  const xb = computeXb(x0, r, 0);
  const yb = computeYb(y0, r, 0);
  const sx = computeSx(r, 0);

  // Verify health at boundary
  const hX = computeHX(xb + 0.001, params, x0, y0);
  const hY = computeHY(yb + 0.001, params, x0, y0);

  const rangeBps = (r * 10000).toFixed(1).padStart(8);
  const depthPerSide = Math.min(x0 - xb, y0 - yb);

  console.log(
    `${rangeBps}  | ${x0.toFixed(0).padStart(10)} | ${y0.toFixed(0).padStart(10)} | ${xb.toFixed(0).padStart(10)} | ${yb.toFixed(0).padStart(10)} | ${depthPerSide.toFixed(0).padStart(10)} | ${(hX ?? NaN).toFixed(4).padStart(8)} | ${(hY ?? NaN).toFixed(4).padStart(8)} | ${sx.toFixed(6)}`
  );
}

// ─── Detailed output for chosen range ───────────────────────────────
console.log('\n=== Detailed: r = 0.003 (30 bps) ===');
const r = 0.003;
const params: Params = {
  vyx: LLTV, vxy: LLTV,
  vxz: 0, vyz: 0, vzx: 0, vzy: 0,
  px: PX, py: PY, pxz: 1,
  rx: r, ry: r,
  cx: 0, cy: 0,
  xr: EQUITY_USDC, yr: EQUITY_USDT,
  zr: 0, xd: 0, yd: 0, zdebt: 0,
  rXX: 0, rXY: 0, rXZ: 0,
  rYX: 0, rYY: 0, rYZ: 0,
  eXC: 0, eXD: 0, eYC: 0, eYD: 0,
};

const x0 = computeX0Additive(params);
const y0 = computeY0Additive(params);
const xb = computeXb(x0, r, 0);
const yb = computeYb(y0, r, 0);

console.log(`eq0 (USDC): ${x0.toFixed(2)}`);
console.log(`eq1 (USDT): ${y0.toFixed(2)}`);
console.log(`min0: ${xb.toFixed(2)}`);
console.log(`min1: ${yb.toFixed(2)}`);
console.log(`Max drain X: ${(x0 - xb).toFixed(2)} USDC`);
console.log(`Max drain Y: ${(y0 - yb).toFixed(2)} USDT`);
console.log(`Health at X boundary: ${computeHX(xb + 0.001, params, x0, y0)?.toFixed(6)}`);
console.log(`Health at Y boundary: ${computeHY(yb + 0.001, params, x0, y0)?.toFixed(6)}`);

// Convert to on-chain values (6 decimals)
const scale = 1e6;
console.log('\n--- On-chain values (uint112, 6 decimals) ---');
console.log(`equilibriumReserve0: ${Math.round(x0 * scale)}`);
console.log(`equilibriumReserve1: ${Math.round(y0 * scale)}`);
console.log(`minReserve0: ${Math.round(xb * scale)}`);
console.log(`minReserve1: ${Math.round(yb * scale)}`);

// recenterRange in WAD
console.log(`\nrecenterRange (WAD): ${BigInt(Math.round(r * 1e18))}`);

// Sanity: what swap size moves to boundary?
console.log(`\nMax single-swap capacity (approx): $${Math.min(x0 - xb, y0 - yb).toFixed(0)}`);
