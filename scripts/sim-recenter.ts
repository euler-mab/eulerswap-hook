/**
 * Recentering simulation: tests the additive boost formula under GBM price changes.
 *
 * Simulates a leveraged USDC/WETH pool that periodically recenters at the new
 * market price. After each recenter, the vault state has changed (real deposits
 * and debts differ from initial). The additive boost formula computes new x0/y0
 * from the current vault state — unlike the multiplicative formula, this works
 * even when one side's real deposits hit zero.
 *
 * Usage: npx tsx scripts/sim-recenter.ts
 */
import {
  type Params,
  computeX0, computeY0, computeX0Additive, computeY0Additive,
  computeXb, computeYb, computeHX, computeHY,
  computeSx, computeSy, fX, gY,
} from '../src/lib/math';
import { mulberry32, boxMuller, solveXForPrice, solveYForPrice } from '../src/lib/simulate';

// ─── Pool configuration ─────────────────────────────────────────────

const BASE_PARAMS: Params = {
  vyx: 0.84,   // WETH collateral on USDC debt (borrow LTV)
  vxy: 0.85,   // USDC collateral on WETH debt
  vxz: 0, vyz: 0, vzx: 0, vzy: 0,
  px: 1,
  py: 1986,    // initial WETH price
  pxz: 1,
  rx: 0.05, ry: 0.05,
  cx: 0, cy: 0,
  xr: 3611,       // USDC deposited
  yr: 0.000394,   // WETH deposited
  zr: 0,
  xd: 0,
  yd: 0.32,       // WETH debt
  zdebt: 0,
  rXX: 0, rXY: 0, rXZ: 0,
  rYX: 0, rYY: 0, rYZ: 0,
  eXC: 0, eXD: 0, eYC: 0, eYD: 0,
};

// ─── Simulation config ──────────────────────────────────────────────

const SIM_CONFIG = {
  vol: 0.60,          // 60% annualized vol
  drift: 0.0,
  durationDays: 30,
  stepsPerDay: 24,    // hourly
  recenterEverySteps: 24,  // recenter once per day
  seed: 42,
};

// ─── GBM price path ─────────────────────────────────────────────────

function generatePricePath(startPrice: number): number[] {
  const { vol, drift, durationDays, stepsPerDay, seed } = SIM_CONFIG;
  const rng = mulberry32(seed);
  const n = durationDays * stepsPerDay;
  const dt = 1 / (365 * stepsPerDay);
  const driftTerm = (drift - 0.5 * vol * vol) * dt;
  const diffusion = vol * Math.sqrt(dt);

  const prices = new Array<number>(n + 1);
  prices[0] = startPrice;
  for (let i = 1; i <= n; i++) {
    prices[i] = prices[i - 1] * Math.exp(driftTerm + diffusion * boxMuller(rng));
  }
  return prices;
}

// ─── Vault state tracker ────────────────────────────────────────────

interface VaultState {
  xr: number;  // real X deposits
  yr: number;  // real Y deposits
  xd: number;  // X debt
  yd: number;  // Y debt
}

/**
 * Compute vault state at position (curX, curY) given pool params and eq (x0, y0).
 * This tracks how vault deposits/debts change as the pool moves from equilibrium.
 */
function vaultStateAt(curX: number, curY: number, x0: number, y0: number, initState: VaultState): VaultState {
  const { xr, yr, xd, yd } = initState;
  if (curX <= x0) {
    // X side: X flows out, Y flows in
    const consumed = x0 - curX;
    return {
      xr: Math.max(xr - consumed, 0),
      yr: yr + (curY - y0),
      xd: xd + Math.max(consumed - xr, 0),
      yd: Math.max(yd - (curY - y0), 0),
    };
  } else {
    // Y side: Y flows out, X flows in
    const consumed = y0 - curY;
    return {
      xr: xr + (curX - x0),
      yr: Math.max(yr - consumed, 0),
      xd: Math.max(xd - (curX - x0), 0),
      yd: yd + Math.max(consumed - yr, 0),
    };
  }
}

// ─── Recenter using additive boost ──────────────────────────────────

interface RecenterResult {
  x0: number;
  y0: number;
  params: Params;
  vaultState: VaultState;
  healthXb: number;
  healthYb: number;
  multX0: number;  // multiplicative for comparison
  multY0: number;
}

function recenterAdditive(currentVault: VaultState, newPy: number): RecenterResult {
  const params: Params = {
    ...BASE_PARAMS,
    py: newPy,
    xr: currentVault.xr,
    yr: currentVault.yr,
    xd: currentVault.xd,
    yd: currentVault.yd,
  };

  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);

  // Multiplicative for comparison (will give 0 when xr or yr = 0)
  const multX0 = computeX0(params);
  const multY0 = computeY0(params);

  // Health at boundaries
  const xb = computeXb(x0, params.rx, params.cx);
  const yb = computeYb(y0, params.ry, params.cy);
  const healthXb = x0 > 0 ? computeHX(xb + 1e-6, params, x0, y0) : Infinity;
  const healthYb = y0 > 0 ? computeHY(yb + 1e-6, params, x0, y0) : Infinity;

  return {
    x0, y0, params,
    vaultState: currentVault,
    healthXb, healthYb,
    multX0, multY0,
  };
}

// ─── Main simulation loop ───────────────────────────────────────────

function run() {
  const pEquil = BASE_PARAMS.px / BASE_PARAMS.py;
  const pricePath = generatePricePath(pEquil);
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;

  // Initial boost
  const initX0add = computeX0Additive(BASE_PARAMS);
  const initY0add = computeY0Additive(BASE_PARAMS);
  const initX0mult = computeX0(BASE_PARAMS);
  const initY0mult = computeY0(BASE_PARAMS);

  console.log('=== Recentering Simulation ===');
  console.log(`Pool: USDC/WETH, rx=ry=${BASE_PARAMS.rx}, cx=cy=${BASE_PARAMS.cx}`);
  console.log(`Initial vault: xr=${BASE_PARAMS.xr}, yr=${BASE_PARAMS.yr}, xd=${BASE_PARAMS.xd}, yd=${BASE_PARAMS.yd}`);
  console.log(`Initial additive:       x0=${initX0add.toFixed(0)}, y0=${initY0add.toFixed(4)}`);
  console.log(`Initial multiplicative: x0=${initX0mult.toFixed(0)}, y0=${initY0mult.toFixed(4)}`);
  console.log(`Vol=${SIM_CONFIG.vol}, ${SIM_CONFIG.durationDays}d, recenter every ${SIM_CONFIG.recenterEverySteps}h`);
  console.log('');

  // Current pool state
  let x0 = initX0add;
  let y0 = initY0add;
  let curX = x0;
  let curY = y0;
  let params = { ...BASE_PARAMS };
  let vault: VaultState = { xr: BASE_PARAMS.xr, yr: BASE_PARAMS.yr, xd: BASE_PARAMS.xd, yd: BASE_PARAMS.yd };
  let recenterCount = 0;
  let healthViolations = 0;

  const recenterLog: string[] = [];

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i]; // Y per X
    const { px, py, cx, cy, rx, ry } = params;
    const pEquilCur = px / py;

    const xb = computeXb(x0, rx, cx);
    const yb = computeYb(y0, ry, cy);

    // Arb to external price (skip if pool is degenerate)
    if (x0 > 0 && y0 > 0) {
      if (extPrice >= pEquilCur) {
        const solved = solveXForPrice(extPrice, cx, x0, px, py, xb);
        if (solved !== null) {
          curX = solved;
          curY = fX(curX, cx, x0, y0, px, py);
        } else {
          curX = xb;
          curY = fX(xb, cx, x0, y0, px, py);
        }
      } else {
        const solved = solveYForPrice(extPrice, cy, y0, px, py, yb);
        if (solved !== null) {
          curY = solved;
          curX = gY(curY, cy, y0, x0, px, py);
        } else {
          curY = yb;
          curX = gY(yb, cy, y0, x0, px, py);
        }
      }
    }

    // Recenter?
    if (i % SIM_CONFIG.recenterEverySteps === 0) {
      // Compute vault state at current position
      vault = vaultStateAt(curX, curY, x0, y0, vault);

      const newPy = 1 / extPrice;  // extPrice = pEquil = px/py, so py = px/extPrice = 1/extPrice
      const result = recenterAdditive(vault, newPy);

      recenterCount++;
      const xrZero = vault.xr < 0.01;
      const yrZero = vault.yr < 0.01;
      const healthOk = result.healthXb >= 0.999 && result.healthYb >= 0.999;
      if (!healthOk) healthViolations++;

      const multFailed = (xrZero && result.multX0 < 1) || (yrZero && result.multY0 < 1);
      const oneSided = result.x0 < 1 || result.y0 < 1e-6;

      // NAV in USDC (equity = deposits - debt, valued at current price)
      const equity = vault.xr + vault.yr * newPy - vault.xd - vault.yd * newPy;

      const line = [
        `Day ${t.toFixed(1).padStart(5)}`,
        `ETH=$${newPy.toFixed(0).padStart(5)}`,
        `equity=$${equity.toFixed(0).padStart(8)}`,
        `vault(xr=${vault.xr.toFixed(0).padStart(7)}, yr=${vault.yr.toFixed(3).padStart(8)},`,
        `xd=${vault.xd.toFixed(0).padStart(6)}, yd=${vault.yd.toFixed(3).padStart(7)})`,
        `→ x0=${result.x0.toFixed(0).padStart(10)}, y0=${result.y0.toFixed(2).padStart(10)}`,
        `H_xb=${result.healthXb.toFixed(3)}, H_yb=${result.healthYb.toFixed(3)}`,
        multFailed ? '  MULT=0' : '',
        oneSided ? '  ONE-SIDED' : '',
        !healthOk ? '  !! H<1 !!' : '',
      ].join('  ');

      recenterLog.push(line);

      // Apply recenter
      x0 = result.x0;
      y0 = result.y0;
      curX = x0;
      curY = y0;
      params = result.params;
      // After recenter, vault state is the equilibrium for the new pool
      // (reconfigure doesn't move tokens, so vault stays the same)
    }
  }

  console.log('─── Recenter log ───');
  for (const line of recenterLog) {
    console.log(line);
  }

  console.log('');
  console.log(`Total recenters: ${recenterCount}`);
  console.log(`Health violations (H < 1): ${healthViolations}`);
  console.log(`Final vault: xr=${vault.xr.toFixed(2)}, yr=${vault.yr.toFixed(4)}, xd=${vault.xd.toFixed(2)}, yd=${vault.yd.toFixed(4)}`);
  console.log(`Final x0=${x0.toFixed(0)}, y0=${y0.toFixed(4)}`);
}

run();
