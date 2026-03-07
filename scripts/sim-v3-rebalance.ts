/**
 * V3 Exposure-Based Rebalancing Simulation
 *
 * Tests the V3 hook strategy: trigger auctions when directional exposure
 * reaches 50% of real NAV, clearing all exposure (debt + wrong-side deposits)
 * to return to 100% USDC deposits.
 *
 * Key differences from sim-recenter.ts (V2):
 * - Trigger: exposure > triggerPct * NAV (not fixed debt threshold)
 * - Clearing: reserves return to eq (full exposure reversal)
 * - Target: clear ALL directional exposure, not just debt
 * - Boundaries: 5% price range from off-centre reserves post-auction
 *
 * Compares V3 exposure-rebalancing against:
 * - V2 debt-threshold (recenter every 24h, clear debt only)
 * - No rebalancing (static pool, no auctions)
 *
 * Usage: npx tsx scripts/sim-v3-rebalance.ts
 */
import {
  type Params,
  computeX0Additive, computeY0Additive,
  computeXb, computeYb,
  fX, gY,
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
  rx: 0.05, ry: 0.05,   // 5% range
  cx: 0, cy: 0,
  xr: 3611,       // USDC deposited (real capital)
  yr: 0,          // No WETH deposits (target: 100% USDC)
  zr: 0,
  xd: 0,          // No USDC debt
  yd: 0,          // No WETH debt
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
  stepsPerDay: 24,    // hourly steps
  seed: 42,
};

// ─── V3 Rebalancing config ──────────────────────────────────────────

const V3_CONFIG = {
  triggerPct: 0.50,        // trigger at 50% of NAV exposure
  auctionDeltaBps: 100,    // off-market shift (100 bps)
  startFeeBps: 200,        // auction start fee
  decayBpsPerMinute: 2,    // fee decay rate
  uniFee: 0.0005,          // external fee (Uni V3 5 bps)
  gasCostUSD: 0.03,
  maxAuctionMinutes: 120,
  boundaryFactor: 0.9759,  // 5% price range: 1 - 1/sqrt(1.05)
};

// ─── V2 Comparison config ───────────────────────────────────────────

const V2_CONFIG = {
  recenterEverySteps: 24,  // recenter every 24 hours
  debtThresholdUSD: 100,   // minimum debt to trigger auction
  auctionDeltaBps: 100,
  startFeeBps: 200,
  decayBpsPerMinute: 2,
  uniFee: 0.0005,
  gasCostUSD: 0.03,
  maxAuctionMinutes: 120,
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
  xr: number;  // real USDC deposits
  yr: number;  // real WETH deposits
  xd: number;  // USDC debt
  yd: number;  // WETH debt
}

/** Compute vault state at position (curX, curY) given eq (x0, y0) and vault state at eq. */
function vaultStateAt(curX: number, curY: number, x0: number, y0: number, initState: VaultState): VaultState {
  const { xr, yr, xd, yd } = initState;
  if (curX <= x0) {
    const consumed = x0 - curX;
    return {
      xr: Math.max(xr - consumed, 0),
      yr: yr + (curY - y0),
      xd: xd + Math.max(consumed - xr, 0),
      yd: Math.max(yd - (curY - y0), 0),
    };
  } else {
    const consumed = y0 - curY;
    return {
      xr: xr + (curX - x0),
      yr: Math.max(yr - consumed, 0),
      xd: Math.max(xd - (curX - x0), 0),
      yd: yd + Math.max(consumed - yr, 0),
    };
  }
}

/** Compute NAV in USDC terms from vault state */
function computeNAV(vault: VaultState, ethPrice: number): number {
  return vault.xr + vault.yr * ethPrice - vault.xd - vault.yd * ethPrice;
}

/** Compute directional exposure in USDC terms.
 *  = absolute net WETH position × price.
 *  USDC components don't create directional exposure (USDC is the target asset). */
function computeExposure(vault: VaultState, ethPrice: number): number {
  return Math.abs(vault.yr - vault.yd) * ethPrice;
}

// ─── Auction simulation (simplified) ────────────────────────────────

interface AuctionResult {
  triggered: boolean;
  direction: 'attract_usdc' | 'attract_weth' | 'none';
  exposureBefore: number;
  exposureAfter: number;
  netCostUSDC: number;
  numTrades: number;
  clearingTimeMin: number;
}

/**
 * Simulate the V3 auction: attract the needed asset until exposure ≈ 0.
 * Uses the same fee-decay auction mechanism as V2.
 *
 * Returns the vault state after the auction.
 */
function runV3Auction(
  vault: VaultState, x0: number, y0: number, params: Params,
  marketPy: number, config: typeof V3_CONFIG,
): AuctionResult & { finalVault: VaultState } {
  const ethPrice = marketPy;
  const exposureBefore = computeExposure(vault, ethPrice);
  const wethNet = (vault.yr - vault.yd) * ethPrice;

  // Determine direction: which asset to attract
  const attractUsdc = wethNet >= 0;  // ETH-long → attract USDC
  const direction = attractUsdc ? 'attract_usdc' as const : 'attract_weth' as const;

  // Compute delta: shift priceY off-market
  const delta = config.auctionDeltaBps / 10000;
  const pyOff = attractUsdc
    ? marketPy / (1 + delta)   // decrease py → overprices WETH → arbers sell USDC
    : marketPy * (1 + delta);  // increase py → underprices WETH → arbers sell WETH

  // Set up off-market pool params (eq = current reserves)
  const offParams: Params = {
    ...params, py: pyOff,
    xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd,
  };
  const x0Off = computeX0Additive(offParams);
  const y0Off = computeY0Additive(offParams);

  if (x0Off < 1 || y0Off < 1e-8) {
    return {
      triggered: false, direction: 'none', exposureBefore, exposureAfter: exposureBefore,
      netCostUSDC: 0, numTrades: 0, clearingTimeMin: 0, finalVault: vault,
    };
  }

  // Simulate arb trades with fee decay
  let curVault = { ...vault };
  let numTrades = 0;
  let totalCostUSDC = 0;
  let totalFeeUSDC = 0;
  let clearTime = 0;

  const { startFeeBps, decayBpsPerMinute, maxAuctionMinutes, uniFee } = config;

  if (attractUsdc) {
    // Y-side arb: arbers buy WETH (cheap) with USDC → USDC comes in, WETH goes out
    const ybOff = computeYb(y0Off, offParams.ry, offParams.cy);
    let yCur = y0Off;

    for (let min = 0; min <= maxAuctionMinutes; min++) {
      const feeFrac = Math.max((startFeeBps - decayBpsPerMinute * min) / 10000, 0);
      const offset = (1 + delta) * (yCur / y0Off) ** 2 - 1;
      if (offset < 1e-8) break;
      if (offset <= feeFrac + uniFee) { if (feeFrac <= 0) break; continue; }

      const denom = (1 - uniFee) * (1 - feeFrac) * (1 + delta);
      if (denom <= 0) continue;
      const yEnd = Math.max(y0Off / Math.sqrt(denom), ybOff);
      if (yEnd >= yCur - 1e-8) continue;

      const dyOut = yCur - yEnd;
      const xEnd = gY(yEnd, 0, y0Off, x0Off, 1, pyOff);
      const xCurVal = (yCur >= y0Off - 1e-8) ? x0Off : gY(yCur, 0, y0Off, x0Off, 1, pyOff);
      const dxIn = xEnd - xCurVal;
      if (dxIn < 0.01) continue;

      const feeUSDC = dxIn * feeFrac / (1 - feeFrac);
      const totalUsdcIn = dxIn + feeUSDC;  // full input deposited to vault

      // Update vault: USDC comes in (repay debt first), WETH goes out (reduce deposits)
      const usdcRepaid = Math.min(totalUsdcIn, curVault.xd);
      const yrUsed = Math.min(dyOut, curVault.yr);
      curVault = {
        xr: curVault.xr + (totalUsdcIn - usdcRepaid),
        yr: curVault.yr - yrUsed,
        xd: curVault.xd - usdcRepaid,
        yd: curVault.yd + (dyOut - yrUsed),
      };

      totalCostUSDC += dyOut * marketPy - dxIn;  // WETH given at market - USDC received
      totalFeeUSDC += feeUSDC;
      numTrades++;
      clearTime = min;
      yCur = yEnd;

      // V3 clearing: WETH deposits drained (ETH-long exposure cleared)
      if (curVault.yr < 1e-6) { curVault.yr = 0; break; }
      // Safety: stop if we created WETH debt (overshoot into opposite exposure)
      if (curVault.yd > 1e-8) break;
      if (feeFrac <= 0) break;
    }
  } else {
    // X-side arb: arbers sell WETH, buy USDC (cheap) → WETH comes in, USDC goes out
    const xbOff = computeXb(x0Off, offParams.rx, offParams.cx);
    let xCur = x0Off;

    for (let min = 0; min <= maxAuctionMinutes; min++) {
      const feeFrac = Math.max((startFeeBps - decayBpsPerMinute * min) / 10000, 0);
      const offset = (1 + delta) * (xCur / x0Off) ** 2 - 1;
      if (offset < 1e-8) break;
      if (offset <= feeFrac + uniFee) { if (feeFrac <= 0) break; continue; }

      const denom = (1 - uniFee) * (1 - feeFrac) * (1 + delta);
      if (denom <= 0) continue;
      const xEnd = Math.max(x0Off / Math.sqrt(denom), xbOff);
      if (xEnd >= xCur - 0.01) continue;

      const dxOut = xCur - xEnd;
      const yEnd = fX(xEnd, 0, x0Off, y0Off, 1, pyOff);
      const yCurVal = (xCur >= x0Off - 0.01) ? y0Off : fX(xCur, 0, x0Off, y0Off, 1, pyOff);
      const dyIn = yEnd - yCurVal;
      if (dyIn < 1e-12) continue;

      const feeWETH = dyIn * feeFrac / (1 - feeFrac);
      const totalWethIn = dyIn + feeWETH;  // full input deposited to vault

      // Update vault: WETH comes in (repay debt first), USDC goes out (reduce deposits)
      const wethRepaid = Math.min(totalWethIn, curVault.yd);
      const xrUsed = Math.min(dxOut, curVault.xr);
      curVault = {
        xr: curVault.xr - xrUsed,
        yr: curVault.yr + (totalWethIn - wethRepaid),
        xd: curVault.xd + (dxOut - xrUsed),
        yd: curVault.yd - wethRepaid,
      };

      totalCostUSDC += dxOut - dyIn * marketPy;  // USDC given - WETH received at market
      totalFeeUSDC += feeWETH * marketPy;
      numTrades++;
      clearTime = min;
      xCur = xEnd;

      // V3 clearing: WETH debt repaid (ETH-short exposure cleared)
      if (curVault.yd < 1e-8) { curVault.yd = 0; break; }
      if (feeFrac <= 0) break;
    }
  }

  const exposureAfter = computeExposure(curVault, ethPrice);

  return {
    triggered: true, direction, exposureBefore, exposureAfter,
    netCostUSDC: totalCostUSDC - totalFeeUSDC,
    numTrades, clearingTimeMin: clearTime, finalVault: curVault,
  };
}

// ─── Pool state tracker ─────────────────────────────────────────────

interface PoolState {
  x0: number;
  y0: number;
  curX: number;
  curY: number;
  params: Params;
  vault: VaultState;
}

function initPool(): PoolState {
  const params = { ...BASE_PARAMS };
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return {
    x0, y0, curX: x0, curY: y0, params,
    vault: { xr: BASE_PARAMS.xr, yr: BASE_PARAMS.yr, xd: BASE_PARAMS.xd, yd: BASE_PARAMS.yd },
  };
}

/** Arb pool to external price, return new position */
function arbToPrice(pool: PoolState, extPrice: number): { curX: number, curY: number, inRange: boolean } {
  const { x0, y0, params } = pool;
  const { px, py, cx, cy, rx, ry } = params;
  const pEquil = px / py;
  const xb = computeXb(x0, rx, cx);
  const yb = computeYb(y0, ry, cy);

  if (x0 < 1 || y0 < 1e-8) return { curX: pool.curX, curY: pool.curY, inRange: false };

  if (extPrice >= pEquil) {
    const solved = solveXForPrice(extPrice, cx, x0, px, py, xb);
    if (solved !== null) {
      return { curX: solved, curY: fX(solved, cx, x0, y0, px, py), inRange: true };
    }
    return { curX: xb, curY: fX(xb, cx, x0, y0, px, py), inRange: false };
  } else {
    const solved = solveYForPrice(extPrice, cy, y0, px, py, yb);
    if (solved !== null) {
      return { curX: gY(solved, cy, y0, x0, px, py), curY: solved, inRange: true };
    }
    return { curX: gY(yb, cy, y0, x0, px, py), curY: yb, inRange: false };
  }
}

/** Recenter pool: recompute x0/y0 from current vault state at new price */
function recenterPool(vault: VaultState, newPy: number): PoolState {
  const params: Params = {
    ...BASE_PARAMS,
    py: newPy,
    xr: vault.xr, yr: vault.yr, xd: vault.xd, yd: vault.yd,
  };
  const x0 = computeX0Additive(params);
  const y0 = computeY0Additive(params);
  return { x0, y0, curX: x0, curY: y0, params, vault: { ...vault } };
}

// ─── Strategy runners ───────────────────────────────────────────────

interface StrategyResult {
  name: string;
  finalNAV: number;
  initialNAV: number;
  totalAuctions: number;
  totalAuctionCost: number;
  totalExposureCleared: number;
  maxExposurePct: number;     // peak exposure as % of NAV
  avgExposurePct: number;     // average exposure as % of NAV
  finalVault: VaultState;
  log: string[];
}

/** V3: exposure-based trigger, auction until reserves return to eq */
function runV3Strategy(pricePath: number[]): StrategyResult {
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const log: string[] = [];

  let totalAuctions = 0;
  let totalAuctionCost = 0;
  let totalExposureCleared = 0;
  let maxExposurePct = 0;
  let sumExposurePct = 0;

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i]; // Y per X (WETH per USDC = 1/ETH_price)
    const ethPrice = 1 / extPrice; // ETH price in USDC

    // Arb to external price
    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    // Compute vault state at current position
    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    // V3 trigger: exposure > 50% of NAV
    if (exposurePct > V3_CONFIG.triggerPct) {
      const newPy = 1 / extPrice;
      // Update vault in pool state before auction
      pool.vault = vault;

      const auction = runV3Auction(
        vault, pool.x0, pool.y0, pool.params,
        newPy, V3_CONFIG,
      );

      if (auction.triggered && auction.numTrades > 0) {
        totalAuctions++;
        totalAuctionCost += auction.netCostUSDC;
        totalExposureCleared += auction.exposureBefore - auction.exposureAfter;

        log.push(
          `Day ${t.toFixed(1).padStart(5)} ETH=$${ethPrice.toFixed(0)} ` +
          `exp=${(exposurePct * 100).toFixed(0)}%NAV=$${exposure.toFixed(0)} ` +
          `${auction.direction} trades=${auction.numTrades} ` +
          `cost=$${auction.netCostUSDC.toFixed(2)} ` +
          `cleared=$${(auction.exposureBefore - auction.exposureAfter).toFixed(0)}`
        );

        // Recenter from post-auction vault state
        pool = recenterPool(auction.finalVault, newPy);
      }
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  return {
    name: 'V3 (exposure-based)',
    finalNAV, initialNAV, totalAuctions, totalAuctionCost,
    totalExposureCleared, maxExposurePct,
    avgExposurePct: sumExposurePct / n,
    finalVault, log,
  };
}

/** V2: fixed-interval recenter with debt-threshold auction */
function runV2Strategy(pricePath: number[]): StrategyResult {
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);
  const log: string[] = [];

  let totalAuctions = 0;
  let totalAuctionCost = 0;
  let totalExposureCleared = 0;
  let maxExposurePct = 0;
  let sumExposurePct = 0;

  for (let i = 1; i <= n; i++) {
    const t = i / SIM_CONFIG.stepsPerDay;
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;

    // Arb to external price
    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    // Compute vault state and exposure
    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    // V2: recenter every 24 steps (daily), auction only on debt threshold
    if (i % V2_CONFIG.recenterEverySteps === 0) {
      pool.vault = vault;
      const newPy = 1 / extPrice;

      const ydUSD = vault.yd * ethPrice;
      const xdUSD = vault.xd;
      const debtUSD = Math.max(ydUSD, xdUSD);

      if (debtUSD > V2_CONFIG.debtThresholdUSD) {
        // V2 auction: clear debt only
        const auction = runV3Auction(
          vault, pool.x0, pool.y0, pool.params,
          newPy, { ...V3_CONFIG, ...V2_CONFIG },
        );

        if (auction.triggered && auction.numTrades > 0) {
          totalAuctions++;
          totalAuctionCost += auction.netCostUSDC;
          totalExposureCleared += auction.exposureBefore - auction.exposureAfter;

          log.push(
            `Day ${t.toFixed(1).padStart(5)} ETH=$${ethPrice.toFixed(0)} ` +
            `debt=$${debtUSD.toFixed(0)} ` +
            `${auction.direction} trades=${auction.numTrades} ` +
            `cost=$${auction.netCostUSDC.toFixed(2)}`
          );

          pool = recenterPool(auction.finalVault, newPy);
        } else {
          pool = recenterPool(vault, newPy);
        }
      } else {
        pool = recenterPool(vault, newPy);
      }
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  return {
    name: 'V2 (debt-threshold)',
    finalNAV, initialNAV, totalAuctions, totalAuctionCost,
    totalExposureCleared, maxExposurePct,
    avgExposurePct: sumExposurePct / n,
    finalVault, log,
  };
}

/** No rebalancing: static pool with daily recenter (no auctions) */
function runStaticStrategy(pricePath: number[]): StrategyResult {
  const n = SIM_CONFIG.durationDays * SIM_CONFIG.stepsPerDay;
  let pool = initPool();
  const initialNAV = computeNAV(pool.vault, pool.params.py);

  let maxExposurePct = 0;
  let sumExposurePct = 0;

  for (let i = 1; i <= n; i++) {
    const extPrice = pricePath[i];
    const ethPrice = 1 / extPrice;

    const arbed = arbToPrice(pool, extPrice);
    pool.curX = arbed.curX;
    pool.curY = arbed.curY;

    const vault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
    const nav = computeNAV(vault, ethPrice);
    const exposure = computeExposure(vault, ethPrice);
    const exposurePct = nav > 0 ? exposure / nav : 0;

    if (exposurePct > maxExposurePct) maxExposurePct = exposurePct;
    sumExposurePct += exposurePct;

    // Daily recenter (no auction, just recompute curve)
    if (i % 24 === 0) {
      pool.vault = vault;
      pool = recenterPool(vault, 1 / extPrice);
    }
  }

  const finalVault = vaultStateAt(pool.curX, pool.curY, pool.x0, pool.y0, pool.vault);
  const finalNAV = computeNAV(finalVault, pool.params.py);

  return {
    name: 'Static (no auctions)',
    finalNAV, initialNAV, totalAuctions: 0, totalAuctionCost: 0,
    totalExposureCleared: 0, maxExposurePct,
    avgExposurePct: sumExposurePct / n,
    finalVault, log: [],
  };
}

// ─── Main ───────────────────────────────────────────────────────────

function printResults(result: StrategyResult) {
  console.log(`  ${result.name.padEnd(25)} NAV: $${result.initialNAV.toFixed(0)} → $${result.finalNAV.toFixed(0).padStart(8)} (${((result.finalNAV / result.initialNAV - 1) * 100).toFixed(1).padStart(7)}%)  auctions=${String(result.totalAuctions).padStart(3)}  cost=$${result.totalAuctionCost.toFixed(0).padStart(5)}  maxExp=${(result.maxExposurePct * 100).toFixed(0).padStart(4)}%  avgExp=${(result.avgExposurePct * 100).toFixed(0).padStart(4)}%`);
}

function runAtVol(vol: number, showLog: boolean = false) {
  SIM_CONFIG.vol = vol;
  const pEquil = BASE_PARAMS.px / BASE_PARAMS.py;
  const pricePath = generatePricePath(pEquil);
  const ethPriceStart = 1 / pricePath[0];
  const ethPriceEnd = 1 / pricePath[pricePath.length - 1];

  console.log(`\n─── Vol=${(vol * 100).toFixed(0)}%, ${SIM_CONFIG.durationDays}d, ETH $${ethPriceStart.toFixed(0)}→$${ethPriceEnd.toFixed(0)} ───`);

  const v3 = runV3Strategy(pricePath);
  const v2 = runV2Strategy(pricePath);
  const stat = runStaticStrategy(pricePath);

  printResults(v3);
  printResults(v2);
  printResults(stat);

  if (showLog && v3.log.length > 0) {
    console.log(`\n  V3 first 20 auctions:`);
    for (const line of v3.log.slice(0, 20)) console.log(`    ${line}`);
    if (v3.log.length > 20) console.log(`    ... (${v3.log.length - 20} more)`);
  }
}

function run() {
  console.log('=== V3 Exposure-Based Rebalancing Simulation ===');
  console.log(`Pool: USDC/WETH, rx=ry=${BASE_PARAMS.rx}, cx=cy=0, real=$${BASE_PARAMS.xr}`);
  console.log(`Trigger: ${V3_CONFIG.triggerPct * 100}% NAV, delta=${V3_CONFIG.auctionDeltaBps}bps, fee=${V3_CONFIG.startFeeBps}→0 bps`);

  for (const vol of [0.30, 0.45, 0.60]) {
    runAtVol(vol, vol === 0.60);
  }
}

run();
