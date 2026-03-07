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

// ─── Dutch auction config ───────────────────────────────────────────

const AUCTION_CONFIG = {
  enabled: true,
  debtThresholdUSD: 100,     // min debt (USDC equiv) to trigger auction
  startFeeBps: 200,          // start fee: 200 bps (2%)
  decayBpsPerMinute: 2,      // linear decay: 2 bps/min → reaches 0 at 100 min
  uniFee: 0.0005,            // Uni V3 5 bps fee (fraction)
  gasCostUSD: 0.03,          // negligible at current gas
  maxAuctionMinutes: 120,    // timeout
  maxDelta: 0.10,            // cap delta at 10% (safety)
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

// ─── Dutch auction sub-simulation ───────────────────────────────────

interface DutchAuctionResult {
  triggered: boolean;
  direction: 'repay_yd' | 'repay_xd' | 'none';
  debtBefore: number;        // native units (WETH for yd, USDC for xd)
  debtAfter: number;
  debtRepaid: number;        // native units
  debtRepaidUSDC: number;    // always in USDC for comparison
  numTrades: number;
  firstTradeFeeBps: number;
  clearingFeeBps: number;    // fee at last trade
  clearingTimeMin: number;
  lpCostUSDC: number;        // price improvement given to arbers
  feeRevenueUSDC: number;    // fees collected from arbers
  netCostUSDC: number;       // lpCost - feeRevenue
  directSwapCostUSDC: number;// comparison: debt * uniFee + gas
  finalVault: VaultState;
  delta: number;             // off-market offset used
}

const NO_AUCTION: DutchAuctionResult = {
  triggered: false, direction: 'none',
  debtBefore: 0, debtAfter: 0, debtRepaid: 0, debtRepaidUSDC: 0,
  numTrades: 0, firstTradeFeeBps: 0, clearingFeeBps: 0, clearingTimeMin: 0,
  lpCostUSDC: 0, feeRevenueUSDC: 0, netCostUSDC: 0, directSwapCostUSDC: 0,
  finalVault: { xr: 0, yr: 0, xd: 0, yd: 0 }, delta: 0,
};

/**
 * Repay WETH debt (yd) via X-side arb.
 * py_off > py_market → pool underprices USDC → arbers sell WETH, buy USDC.
 * WETH inflow repays yd via FundsLib deposit-first-repay.
 */
function runAuctionRepayYd(
  vault: VaultState, x0: number, params: Params,
  marketPy: number, config: typeof AUCTION_CONFIG,
): DutchAuctionResult {
  const debtBefore = vault.yd;
  const delta = Math.min(2 * debtBefore * marketPy / x0, config.maxDelta);
  const pyOff = marketPy * (1 + delta);

  const offParams: Params = {
    ...params, py: pyOff,
    xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd,
  };
  const x0Off = computeX0Additive(offParams);
  const y0Off = computeY0Additive(offParams);

  if (x0Off < 1) {
    // X-side auction needs x0 > 0 (y0 can be 0 — WETH appears as x decreases)
    return { ...NO_AUCTION, direction: 'repay_yd', debtBefore, debtAfter: debtBefore, finalVault: vault, delta };
  }

  const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
  let xCur = x0Off;
  let curVault = { ...vault };
  let totalUSDCOut = 0;
  let totalWETHOnCurve = 0;
  let totalFeeWETH = 0;
  let numTrades = 0;
  let firstFeeBps = 0;
  let lastFeeBps = 0;
  let clearTime = 0;

  const { startFeeBps, decayBpsPerMinute, maxAuctionMinutes, uniFee } = config;

  for (let min = 0; min <= maxAuctionMinutes; min++) {
    const feeFrac = Math.max((startFeeBps - decayBpsPerMinute * min) / 10000, 0);
    const offset = (1 + delta) * (xCur / x0Off) ** 2 - 1;
    if (offset < 1e-8) break;
    if (offset <= feeFrac + uniFee) { if (feeFrac <= 0) break; continue; }

    const denom = (1 - uniFee) * (1 - feeFrac) * (1 + delta);
    if (denom <= 0) continue;
    let xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
    if (xEnd >= xCur - 0.01) continue;

    const dxOut = xCur - xEnd;
    const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
    const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
    const dyOnCurve = yEnd - yCurVal;
    if (dyOnCurve < 1e-12) continue;

    const feeWETH = dyOnCurve * feeFrac / (1 - feeFrac);
    const repaid = Math.min(dyOnCurve, curVault.yd);
    const xrUsed = Math.min(dxOut, curVault.xr);

    curVault = {
      xr: curVault.xr - xrUsed,
      yr: curVault.yr + (dyOnCurve - repaid),
      xd: curVault.xd + (dxOut - xrUsed),
      yd: curVault.yd - repaid,
    };

    totalUSDCOut += dxOut;
    totalWETHOnCurve += dyOnCurve;
    totalFeeWETH += feeWETH;
    numTrades++;
    if (numTrades === 1) firstFeeBps = Math.round(feeFrac * 10000);
    lastFeeBps = Math.round(feeFrac * 10000);
    clearTime = min;
    xCur = xEnd;
    if (curVault.yd < 1e-8) { curVault.yd = 0; break; }
    if (feeFrac <= 0) break;
  }

  const lpCostUSDC = totalUSDCOut - totalWETHOnCurve * marketPy;
  const feeRevenueUSDC = totalFeeWETH * marketPy;
  const debtRepaid = debtBefore - curVault.yd;

  return {
    triggered: true, direction: 'repay_yd',
    debtBefore, debtAfter: curVault.yd, debtRepaid,
    debtRepaidUSDC: debtRepaid * marketPy,
    numTrades, firstTradeFeeBps: firstFeeBps,
    clearingFeeBps: lastFeeBps, clearingTimeMin: clearTime,
    lpCostUSDC, feeRevenueUSDC,
    netCostUSDC: lpCostUSDC - feeRevenueUSDC,
    directSwapCostUSDC: debtRepaid * marketPy * config.uniFee + config.gasCostUSD,
    finalVault: curVault, delta,
  };
}

/**
 * Repay USDC debt (xd) via Y-side arb.
 * py_off < py_market → pool overprices WETH → arbers buy WETH with USDC.
 * USDC inflow repays xd via FundsLib deposit-first-repay.
 */
function runAuctionRepayXd(
  vault: VaultState, y0: number, params: Params,
  marketPy: number, config: typeof AUCTION_CONFIG,
): DutchAuctionResult {
  const debtBefore = vault.xd;
  // USDC inflow ≈ py * y0 * delta / 2 → delta = 2 * xd / (py * y0)
  const delta = Math.min(2 * debtBefore / (marketPy * y0), config.maxDelta);
  const pyOff = marketPy / (1 + delta);

  const offParams: Params = {
    ...params, py: pyOff,
    xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd,
  };
  const x0Off = computeX0Additive(offParams);
  const y0Off = computeY0Additive(offParams);

  if (y0Off < 1e-8) {
    // Y-side auction needs y0 > 0 (x0 can be 0 — USDC appears as y decreases)
    return { ...NO_AUCTION, direction: 'repay_xd', debtBefore, debtAfter: debtBefore, finalVault: vault, delta };
  }

  const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
  let yCur = y0Off;
  let curVault = { ...vault };
  let totalWETHOut = 0;
  let totalUSDCOnCurve = 0;
  let totalFeeUSDC = 0;
  let numTrades = 0;
  let firstFeeBps = 0;
  let lastFeeBps = 0;
  let clearTime = 0;

  const { startFeeBps, decayBpsPerMinute, maxAuctionMinutes, uniFee } = config;

  for (let min = 0; min <= maxAuctionMinutes; min++) {
    const feeFrac = Math.max((startFeeBps - decayBpsPerMinute * min) / 10000, 0);
    // Symmetric offset formula: offset(y) = (1+delta)*(y/y0Off)² - 1
    const offset = (1 + delta) * (yCur / y0Off) ** 2 - 1;
    if (offset < 1e-8) break;
    if (offset <= feeFrac + uniFee) { if (feeFrac <= 0) break; continue; }

    const denom = (1 - uniFee) * (1 - feeFrac) * (1 + delta);
    if (denom <= 0) continue;
    let yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
    if (yEnd >= yCur - 1e-8) continue;

    const dyOut = yCur - yEnd;
    // USDC inflow via gY (c=0): x increases as y decreases
    const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
    const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
    const dxOnCurve = xEnd - xCurVal;
    if (dxOnCurve < 0.01) continue;

    const feeUSDC = dxOnCurve * feeFrac / (1 - feeFrac);
    const repaid = Math.min(dxOnCurve, curVault.xd);
    const yrUsed = Math.min(dyOut, curVault.yr);

    curVault = {
      xr: curVault.xr + (dxOnCurve - repaid),
      yr: curVault.yr - yrUsed,
      xd: curVault.xd - repaid,
      yd: curVault.yd + (dyOut - yrUsed),
    };

    totalWETHOut += dyOut;
    totalUSDCOnCurve += dxOnCurve;
    totalFeeUSDC += feeUSDC;
    numTrades++;
    if (numTrades === 1) firstFeeBps = Math.round(feeFrac * 10000);
    lastFeeBps = Math.round(feeFrac * 10000);
    clearTime = min;
    yCur = yEnd;
    if (curVault.xd < 0.01) { curVault.xd = 0; break; }
    if (feeFrac <= 0) break;
  }

  // LP cost = WETH given at market value - USDC received
  const lpCostUSDC = totalWETHOut * marketPy - totalUSDCOnCurve;
  const feeRevenueUSDC = totalFeeUSDC; // already USDC
  const debtRepaid = debtBefore - curVault.xd;

  return {
    triggered: true, direction: 'repay_xd',
    debtBefore, debtAfter: curVault.xd, debtRepaid,
    debtRepaidUSDC: debtRepaid, // xd is already USDC
    numTrades, firstTradeFeeBps: firstFeeBps,
    clearingFeeBps: lastFeeBps, clearingTimeMin: clearTime,
    lpCostUSDC, feeRevenueUSDC,
    netCostUSDC: lpCostUSDC - feeRevenueUSDC,
    directSwapCostUSDC: debtRepaid * config.uniFee + config.gasCostUSD,
    finalVault: curVault, delta,
  };
}

/**
 * Dispatcher: run dutch auction for whichever debt exceeds threshold.
 * Handles the larger debt (in USDC terms) first.
 */
function runDutchAuction(
  vault: VaultState, x0: number, y0: number, params: Params,
  marketPy: number, config: typeof AUCTION_CONFIG,
): DutchAuctionResult {
  if (!config.enabled) return { ...NO_AUCTION, finalVault: vault };

  const ydUSD = vault.yd * marketPy;
  const xdUSD = vault.xd;

  if (ydUSD >= xdUSD && ydUSD >= config.debtThresholdUSD && x0 > 0) {
    return runAuctionRepayYd(vault, x0, params, marketPy, config);
  }
  if (xdUSD >= config.debtThresholdUSD && y0 > 0) {
    return runAuctionRepayXd(vault, y0, params, marketPy, config);
  }

  return { ...NO_AUCTION, finalVault: vault };
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
  console.log(`Auction: ${AUCTION_CONFIG.enabled ? 'ON' : 'OFF'}, startFee=${AUCTION_CONFIG.startFeeBps}bps, decay=${AUCTION_CONFIG.decayBpsPerMinute}bps/min, uniFee=${AUCTION_CONFIG.uniFee * 10000}bps`);
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

  // Auction accumulators
  let totalAuctions = 0;
  let totalAuctionDebtRepaid = 0;
  let totalAuctionLPCost = 0;
  let totalAuctionFeeRevenue = 0;
  let totalAuctionNetCost = 0;
  let totalDirectSwapCost = 0;

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

      // ── Dutch auction: run before recenter if debt exists ──
      const preAuctionVault = { ...vault };
      const auction = runDutchAuction(vault, x0, y0, params, newPy, AUCTION_CONFIG);
      if (auction.triggered) {
        vault = auction.finalVault;
        totalAuctions++;
        totalAuctionDebtRepaid += auction.debtRepaidUSDC;
        totalAuctionLPCost += auction.lpCostUSDC;
        totalAuctionFeeRevenue += auction.feeRevenueUSDC;
        totalAuctionNetCost += auction.netCostUSDC;
        totalDirectSwapCost += auction.directSwapCostUSDC;
      }

      // ── Recenter from (post-auction) vault state ──
      const result = recenterAdditive(vault, newPy);

      recenterCount++;
      const xrZero = vault.xr < 0.01;
      const yrZero = vault.yr < 0.01;
      const healthOk = result.healthXb >= 0.999 && result.healthYb >= 0.999;
      if (!healthOk) healthViolations++;

      const multFailed = (xrZero && result.multX0 < 1) || (yrZero && result.multY0 < 1);
      const oneSided = result.x0 < 1 || result.y0 < 1e-6;

      // NAV in USDC (equity = deposits - debt, valued at current price)
      // Show pre-auction vault state for clarity
      const showVault = auction.triggered ? preAuctionVault : vault;
      const equity = vault.xr + vault.yr * newPy - vault.xd - vault.yd * newPy;

      const line = [
        `Day ${t.toFixed(1).padStart(5)}`,
        `ETH=$${newPy.toFixed(0).padStart(5)}`,
        `equity=$${equity.toFixed(0).padStart(8)}`,
        `vault(xr=${showVault.xr.toFixed(0).padStart(7)}, yr=${showVault.yr.toFixed(3).padStart(8)},`,
        `xd=${showVault.xd.toFixed(0).padStart(6)}, yd=${showVault.yd.toFixed(3).padStart(7)})`,
        `→ x0=${result.x0.toFixed(0).padStart(10)}, y0=${result.y0.toFixed(2).padStart(10)}`,
        `H_xb=${result.healthXb.toFixed(3)}, H_yb=${result.healthYb.toFixed(3)}`,
        multFailed ? '  MULT=0' : '',
        oneSided ? '  ONE-SIDED' : '',
        !healthOk ? '  !! H<1 !!' : '',
      ].join('  ');

      recenterLog.push(line);

      // Auction detail line
      if (auction.triggered) {
        const dir = auction.direction === 'repay_yd' ? 'yd' : 'xd';
        const repaidStr = auction.direction === 'repay_yd'
          ? `${auction.debtRepaid.toFixed(4)} WETH`
          : `$${auction.debtRepaid.toFixed(0)} USDC`;
        const aLine = [
          `       AUCTION(${dir})`,
          `δ=${(auction.delta * 10000).toFixed(0)}bps`,
          `trades=${auction.numTrades}`,
          `fee=${auction.firstTradeFeeBps}→${auction.clearingFeeBps}bps`,
          `t=${auction.clearingTimeMin}min`,
          `repaid=${repaidStr}`,
          `net=$${auction.netCostUSDC.toFixed(2)}`,
          `vs swap=$${auction.directSwapCostUSDC.toFixed(2)}`,
          auction.netCostUSDC < auction.directSwapCostUSDC ? '  AUCTION WINS' : `  +$${(auction.netCostUSDC - auction.directSwapCostUSDC).toFixed(2)} OVERPAY`,
          auction.debtAfter > (auction.direction === 'repay_yd' ? 0.001 : 1) ? `  residual=${auction.debtAfter.toFixed(auction.direction === 'repay_yd' ? 4 : 0)}` : '',
        ].join('  ');
        recenterLog.push(aLine);
      }

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

  if (totalAuctions > 0) {
    console.log('');
    console.log('─── Auction summary ───');
    console.log(`Auctions triggered: ${totalAuctions} / ${recenterCount} recenters`);
    console.log(`Total debt repaid (USDC equiv): $${totalAuctionDebtRepaid.toFixed(2)}`);
    console.log(`Total LP cost (price improvement): $${totalAuctionLPCost.toFixed(2)}`);
    console.log(`Total fee revenue:                 $${totalAuctionFeeRevenue.toFixed(2)}`);
    console.log(`Total net cost (LP cost - fees):   $${totalAuctionNetCost.toFixed(2)}`);
    console.log(`Total direct swap cost (comparison):$${totalDirectSwapCost.toFixed(2)}`);
    console.log(`Savings vs direct swap:            $${(totalDirectSwapCost - totalAuctionNetCost).toFixed(2)}`);
  }
}

run();
