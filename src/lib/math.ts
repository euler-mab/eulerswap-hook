// ============================================================================
// EulerSwap AMM curve math
// All functions derived from the Desmos specification
// ============================================================================
//
// OVERVIEW
// --------
// EulerSwap is a concentrated-liquidity AMM integrated with a lending market.
// The pool holds two primary assets X and Y, with an optional third exogenous
// asset Z used only for lending (not traded on the AMM curve).
//
// The AMM has two "sides":
//   X side: price of X drops → X flows into the pool, Y flows out (x decreases from x0)
//   Y side: price of X rises → Y flows into the pool, X flows out (y decreases from y0)
//
// Each side has its own curve, concentration parameter, and price range.
// The curves meet at the equilibrium point (x0, y0).
//
// COORDINATE SYSTEM
// -----------------
// Virtual (boosted) reserves:  x0, y0  — what the AMM "sees" (amplified liquidity)
// Real reserves:               xr, yr  — actual deposited tokens
// Range boundaries:            xb, yb  — lower limits of each reserve within the range
//
// The relationship:  x0 = xr * b_XC * b_XL  (similarly for y0)
// where b_XC is concentration boost and b_XL is leverage boost.
//
// AMM CURVES
// ----------
// For x ∈ (0, x0]:  y = fX(x)  = y0 + (px/py)(x0-x)(cx + (1-cx)(x0/x))
// For x ≥ x0:       y = fY(x)  — inverse of gY, solved via quadratic on cy
// For y ∈ (0, y0]:  x = gY(y)  = x0 + (py/px)(y0-y)(cy + (1-cy)(y0/y))
// For y ≥ y0:       x = gX(y)  — inverse of fX, solved via quadratic on cx
//
// The inverse functions (fY, gX) solve cy·y² + By·y − Cy = 0 (or cx variant).
// Two forms are used depending on the sign of B for numerical stability:
//   B ≤ 0:  standard   (-B + √disc) / (2A)    — sums two positives
//   B > 0:  citardauq  2C / (B + √disc)        — avoids catastrophic cancellation
//
// cx, cy ∈ [0, 1) control concentration. The parameter interpolates between
// two classic AMM curve shapes:
//
//   c=0  (constant-product, xy=k):
//     fX(x) = y0 + (px/py)·x0²/x − (px/py)·x0
//     With px=py and x0=y0 this gives y = x0²/x, i.e. x·y = x0² = k.
//     Marginal price varies as (x0/x)² — wide price impact per unit traded.
//     The inverse functions (fY, gX) use a simplified y0²/denom form (special-
//     cased in code since the quadratic term Ay or Ax is zero).
//
//   c→1  (constant-sum, x+y=k):
//     fX(x) = y0 + (px/py)(x0−x) — linear, constant marginal price = px/py.
//     All liquidity is concentrated at equilibrium; zero price impact until
//     one asset is depleted. On the inverse side fY returns 0 immediately
//     (Cy=0 → no Y remaining once price moves past equilibrium).
//     c=1 is excluded from the domain because it makes the range degenerate:
//     sx = sqrt((1+rx)/(1−1)) → ∞, and the boundary xb collapses to x0.
//
// Higher cx = tighter liquidity around equilibrium (less price impact, narrower range).
//
// PRICE CONVENTIONS
// -----------------
// px, py          — external oracle prices (in common numeraire, e.g. USD)
// px/py           — Y per X exchange rate (how many Y is one X worth)
// py/px           — X per Y exchange rate
// pXxy(x)         — marginal price at x: Y per X = -fXd(x)
// pXyx(x)         — marginal price at x: X per Y = 1/(-fXd(x))
// pYxy(y)         — marginal price at y: Y per X = 1/(-gYd(y))
// pYyx(y)         — marginal price at y: X per Y = -gYd(y)
// pzx             — value of Z in X units = 1/pxz
// pzy             — value of Z in Y units = pzx * (px/py)
// pXyxb           — X per Y at the X-side boundary (x = xb)
// pYxyb           — Y per X at the Y-side boundary (y = yb)
//
// LLTV (Liquidation Loan-to-Value) NAMING
// ----------------------------------------
// v_{collateral}{debt} — the LLTV when `collateral` is pledged against `debt`.
//   vyx  — Y collateral on X debt       vxy  — X collateral on Y debt
//   vxz  — X collateral on Z debt       vyz  — Y collateral on Z debt
//   vzx  — Z collateral on X debt       vzy  — Z collateral on Y debt
//
// PHASES (X side, as x decreases from x0 toward xb)
// --------------------------------------------------
// The AMM curve determines how much X flows in and Y flows out as x drops.
// As x decreases:
//   1. Near equilibrium (x > xXYdebt): Y debt (DXY) is still partially outstanding.
//      Collateral = remaining X (CXX) + Y reserves + Y surplus from swap (CXY).
//      Health is H_XY = (vxy*CXX + vzy*zr*pzx + R_XY) / (DXY * pXyx).
//
//   2. Past xXYdebt (x ≤ xXYdebt): Y debt fully repaid by swap delta.
//      Now X debt (DXX) accumulates as swap delta exceeds real X reserves.
//      Health is H_XX = (vyx*CXY*pXyx + vzx*zr*pzx + R_XX) / DXX.
//
//   3. Dead zone: between phase boundaries, both debts can be zero.
//      Health = Infinity (position is safe, no debt outstanding).
//
// When Z is the debt asset (zd > 0), DXX=DXY=0 and a single formula H_XZ applies.
// The Y side is symmetric with gY replacing fX.
//
// DEBT CONSTRAINT
// ---------------
// The lending market allows exactly ONE debt asset at a time:
//   - xd > 0: X is the debt asset (yd=0, zd=0)
//   - yd > 0: Y is the debt asset (xd=0, zd=0)
//   - zd > 0: Z is the debt asset (xd=0, yd=0)
// This is enforced by the UI (radio buttons) and validated by validateParams().
// Note: even with a single initial debt asset, the AMM alternates between
// debt phases (e.g. X debt ↔ Y debt) as the price moves through boundaries.
//
// BOOST
// -----
// Virtual reserves are amplified beyond real deposits via two multipliers:
//
//   b_XC = s_X / (s_X - 1)    — concentration boost (from price range narrowing)
//     where s_X = sqrt((1 + rx - cx) / (1 - cx))
//     Higher cx or lower rx → higher b_XC. Always ≥ 1.
//
//   b_XL                       — leverage boost (from the lending market)
//     The lending market's collateral/debt structure allows virtual reserves to
//     exceed real deposits while maintaining health ≥ 1 within the range.
//     For X/Y debt: calibrated at x = xb (boundary).
//     For Z debt (bZL01): calibrated at x = x0-xr (CXX transition point),
//       which is the tighter constraint — CXY*pXyx has a valley there because
//       CXY shrinks faster than pXyx grows, and CXX is still zero. The
//       boundary H ends up > 1. When vyz*(yr+pxy*xr) < ZXD*pxy, no boost
//       can achieve H=1 at the transition point (fundamental limitation).
//
//     The health equation at xb has max() terms for collateral and debt that
//     can be zero or positive depending on the boost level. This creates 4
//     candidate solutions corresponding to which max() branches are active.
//     Each candidate is computed algebraically, then checked for validity
//     (the assumed-active terms are actually positive, assumed-zero terms
//     are actually ≤ 0). The candidates are mutually exclusive.
//
//     X/Y debt candidates (b_XL):
//       b_XL10 (bXL ≤ 1, yXdelta > yd): CXX active, in H_XX phase → solve H_XX = 1
//       b_XL11 (bXL > 1, yXdelta > yd): CXX = 0,    in H_XX phase → solve H_XX = 1
//       b_XL01 (bXL > 1, yXdelta ≤ yd): CXX = 0,    in H_XY phase → solve H_XY = 1
//         Uses vzy/rXY (not vyx/vzx/rXX) because xb falls where Y debt governs.
//       b_XL00 = 1 (fallback, concentration boost only, no leverage)
//
//     Z debt candidates (b_ZL):
//       b_ZL01 (bZL ≥ 1): X coll inactive, Y coll active.
//         Two calibrations: boundary (H=1 at xb) and transition-point
//         (H=1 at x0-xr). The stricter (higher bZL) wins. The transition-
//         point calibration solves a quadratic A·t²+B·t+C = 0 where
//         t = bXC·bXL - 1, using citardauq form for numerical stability.
//       b_ZL11 (0 < bZL < 1): both active → solve H_XZ = 1
//       b_ZL10: DEAD BRANCH — validity requires (px/py)*xr*bZL*PX ≤ 0,
//         always false with positive parameters. Omitted from code.
//       b_ZL00 = 1 (fallback)
//
// NAV (Net Asset Value)
// ---------------------
// n_XX = CXX + CXY*pXyx + CXZ*pzx - DXX - DXY*pXyx - DXZ*pzx + E_XC - E_XD
// All values converted to X units. E_XC/E_XD are exogenous collateral/debt.
// ============================================================================

export interface Params {
  // LLTV for X collateral on Y debt and vice versa
  vyx: number; // v_yx
  vxy: number; // v_xy
  // LLTV for X, Y collateral on exogenous debt in third asset Z
  vxz: number; // v_xz
  vyz: number; // v_yz
  // LLTV for exogenous collateral Z on X, Y
  vzx: number; // v_zx
  vzy: number; // v_zy
  // Price parameters
  px: number;
  py: number;
  pxz: number; // price of Z per X
  // Price range (% diff from equilibrium, 0.1 = 10% increase)
  rx: number;
  ry: number;
  // Concentration
  cx: number;
  cy: number;
  // Real deposits at equilibrium
  xr: number;
  yr: number;
  zr: number;
  // Real debts at equilibrium (only one of xd, yd, zd can be non-zero)
  xd: number;
  yd: number;
  zdebt: number; // raw z debt input
  // Risk-adjusted external collateral (X-side health)
  rXX: number;
  rXY: number;
  rXZ: number;
  // Risk-adjusted external collateral (Y-side health)
  rYX: number;
  rYY: number;
  rYZ: number;
  // Exogenous collateral/debt for NAV
  eXC: number;
  eXD: number;
  eYC: number;
  eYD: number;
}

/** Validate parameter constraints. Returns list of problems (empty = valid). */
export function validateParams(p: Params): string[] {
  const w: string[] = [];
  if (p.xd > 0 && p.yd > 0) w.push("xd and yd are both nonzero — only one debt asset allowed");
  if (p.xd > 0 && p.zdebt > 0) w.push("xd and zdebt are both nonzero — only one debt asset allowed");
  if (p.yd > 0 && p.zdebt > 0) w.push("yd and zdebt are both nonzero — only one debt asset allowed");
  if (p.px <= 0) w.push("px must be positive");
  if (p.py <= 0) w.push("py must be positive");
  if (p.pxz <= 0) w.push("pxz must be positive");
  if (p.cx >= 1) w.push("cx must be < 1");
  if (p.cy >= 1) w.push("cy must be < 1");
  if (p.rx <= 0) w.push("rx must be positive");
  if (p.ry <= 0) w.push("ry must be positive");
  const sx = computeSx(p.rx, p.cx);
  const sy = computeSy(p.ry, p.cy);
  if (!isFinite(sx) || sx <= 1) w.push(`Degenerate X boost: sx=${sx?.toFixed(4)} — check rx and cx`);
  if (!isFinite(sy) || sy <= 1) w.push(`Degenerate Y boost: sy=${sy?.toFixed(4)} — check ry and cy`);
  return w;
}

/** Effective Z debt — only active when xd=0 and yd=0 (mutual exclusion). */
export function computeZd(p: Params): number {
  if (p.xd > 0 || p.yd > 0) return 0;
  return p.zdebt;
}

/** Price of X in Y units: px/py. */
export function computePxy(p: Params): number { if (p.py === 0) return NaN; return p.px / p.py; }
/** Price of Y in X units: py/px. */
export function computePyx(p: Params): number { if (p.px === 0) return NaN; return p.py / p.px; }
/** Price of Z in X units: 1/pxz. */
export function computePzx(p: Params): number { if (p.pxz === 0) return NaN; return 1 / p.pxz; }

export const defaultParams: Params = {
  vyx: 0.9,
  vxy: 0.9,
  vxz: 0.599,
  vyz: 0.582,
  vzx: 0,
  vzy: 0,
  px: 1,
  py: 1,
  pxz: 1,
  rx: 1,
  ry: 1,
  cx: 0.502,
  cy: 0.502,
  xr: 10,
  yr: 10,
  zr: 0,
  xd: 0,
  yd: 0,
  zdebt: 10,
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

// --- Boost helpers ---

/** Range scale factor: s_X = sqrt((1 + rx - cx) / (1 - cx)). Must be > 1. */
export function computeSx(rx: number, cx: number): number {
  if (cx >= 1) return NaN;
  const inner = (1 + rx - cx) / (1 - cx);
  if (inner < 0) return NaN;
  return Math.sqrt(inner);
}
/** Range scale factor: s_Y = sqrt((1 + ry - cy) / (1 - cy)). Must be > 1. */
export function computeSy(ry: number, cy: number): number {
  if (cy >= 1) return NaN;
  const inner = (1 + ry - cy) / (1 - cy);
  if (inner < 0) return NaN;
  return Math.sqrt(inner);
}

/** Concentration boost: b_XC = s_X / (s_X - 1). Always >= 1 when sx > 1. */
export function computeBxc(sx: number): number {
  if (!isFinite(sx) || sx <= 1) {
    return NaN;
  }
  return sx / (sx - 1);
}
/** Concentration boost: b_YC = s_Y / (s_Y - 1). Always >= 1 when sy > 1. */
export function computeByc(sy: number): number {
  if (!isFinite(sy) || sy <= 1) {
    return NaN;
  }
  return sy / (sy - 1);
}

/** Price factor at X boundary: P_X = cx + (1 - cx) * s_X. */
export function computePX(cx: number, sx: number): number {
  return cx + (1 - cx) * sx;
}
/** Price factor at Y boundary: P_Y = cy + (1 - cy) * s_Y. */
export function computePY(cy: number, sy: number): number {
  return cy + (1 - cy) * sy;
}

// --- Boosted (virtual) reserves via leverage boost ---
// x_0 = x_r * b_XC * b_XL
// Solve health = 1 at x = x_b to find b_XL.
// 4 candidates for X/Y debt, 4 candidates for Z debt.

function computeBoostX(p: Params): number {
  const { px, py, xr, yr, xd, yd, vyx, vzx, vxz, vyz, vzy, zr, rx, cx, rXX, rXY, rXZ } = p;
  const zd = computeZd(p);
  const pzx = computePzx(p);
  const sx = computeSx(rx, cx);
  const bXC = computeBxc(sx);
  const PX = computePX(cx, sx);
  // p_Xyxb = boundary marginal price (X per Y at x_b) = 1 / ((px/py)(1+rx))
  const pXyxb = 1 / ((px / py) * (1 + rx));

  if (zd > 0) {
    // Z debt case: solve for b_ZL
    const ZXD = zd * pzx - rXZ;
    if (ZXD <= 0) return bXC; // no effective Z debt

    // b_ZL10 omitted: dead branch — validity requires (px/py)*xr*bZL10*PX ≤ 0,
    // which is always false with positive parameters.

    // Transition-point calibration: H=1 at x=x0-xr where CXX first becomes 0.
    // CXY*pXyx has a valley there, so this is the tighter constraint.
    // Quadratic: AQ·t² + BQ·t + CQ = 0 where t = bXC·bXL - 1, giving
    // bXL = (t+1)/bXC. Uses citardauq form for numerical stability.
    const pxy = px / py;
    const m = 1 - cx;
    const aTP = yr + pxy * xr;
    const AQ = vyz * aTP - ZXD * pxy;
    const BQ = pxy * m * (vyz * xr - 2 * ZXD);
    const CQ = -ZXD * pxy * m;
    const disc = BQ * BQ - 4 * AQ * CQ;
    let bZL01_tp = NaN;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      let t: number;
      if (Math.abs(AQ) < 1e-12 * Math.max(Math.abs(BQ), Math.abs(CQ), 1e-30)) {
        // Near-linear: AQ negligible relative to BQ/CQ → BQ·t + CQ = 0
        t = BQ !== 0 ? -CQ / BQ : NaN;
      } else if (BQ <= 0) {
        // Standard form: sums two positives in numerator
        t = (-BQ + sqrtDisc) / (2 * AQ);
      } else {
        // Citardauq form: avoids cancellation when BQ > 0
        t = (2 * CQ) / (-BQ - sqrtDisc);
      }
      if (isFinite(t) && t > 0) {
        bZL01_tp = (t + 1) / bXC;
      }
    }

    // Boundary calibration (original): H=1 at x=xb
    // b_ZL01: X coll inactive, Y coll active
    const denom01 = xr * vyz * pXyxb * (px / py) * PX;
    const bZL01_b = denom01 > 0 ? (ZXD - vyz * yr * pXyxb) / denom01 : NaN;

    // Take the stricter constraint (higher boost)
    const bZL01 = Math.max(
      isFinite(bZL01_b) ? bZL01_b : -Infinity,
      isFinite(bZL01_tp) ? bZL01_tp : -Infinity
    );
    const vZL01 = (bZL01 >= 1 && (px / py) * xr * bZL01 * PX > 0) ? 1 : 0;

    // b_ZL11: both active
    const denom11 = xr * (vyz * pXyxb * (px / py) * PX - vxz);
    const bZL11 = denom11 !== 0 ? (ZXD - vxz * xr - vyz * yr * pXyxb) / denom11 : NaN;
    const vZL11 = (bZL11 > 0 && bZL11 < 1 && (px / py) * xr * bZL11 * PX > 0) ? 1 : 0;

    // Pick valid candidate (prefer highest boost)
    if (vZL01 && isFinite(bZL01)) return bXC * bZL01;
    if (vZL11 && isFinite(bZL11)) return bXC * bZL11;
    // fallback: b_ZL00 (no leverage boost needed)
    return bXC;
  }

  // X/Y debt case
  const ZXC = vzx * zr * pzx + rXX;

  // b_XL10: collateral max active, debt max inactive
  const denom10 = xr * vyx * pXyxb * (px / py) * PX;
  const bXL10 = denom10 > 0 ? (xd - ZXC + vyx * pXyxb * (yd - yr)) / denom10 : NaN;
  const vXL10 = ((px / py) * xr * bXL10 * PX > yd && bXL10 <= 1) ? 1 : 0;

  // b_XL01: collateral max inactive (bXL > 1), in H_XY phase (yXdelta ≤ yd)
  // Solve H_XY = 1: (vzy*zr*pzx + rXY) / ((yd - yXdelta) * pXyxb) = 1
  const ZXY = vzy * zr * pzx + rXY;
  const denom01 = (px / py) * xr * PX * pXyxb;
  const bXL01 = denom01 > 0 ? (yd * pXyxb - ZXY) / denom01 : NaN;
  const vXL01 = ((px / py) * xr * bXL01 * PX <= yd && bXL01 > 1) ? 1 : 0;

  // b_XL11: both active
  const denom11 = xr * (vyx * pXyxb * (px / py) * PX - 1);
  const bXL11 = denom11 !== 0 ? (xd - xr - vyx * (yr - yd) * pXyxb - ZXC) / denom11 : NaN;
  const vXL11 = ((px / py) * xr * bXL11 * PX > yd && bXL11 > 1) ? 1 : 0;

  // Pick valid candidate (prefer highest valid boost)
  if (vXL11 && isFinite(bXL11)) return bXC * bXL11;
  if (vXL01 && isFinite(bXL01)) return bXC * bXL01;
  if (vXL10 && isFinite(bXL10)) return bXC * bXL10;
  // b_XL00: no boost beyond concentration
  return bXC;
}

function computeBoostY(p: Params): number {
  const { px, py, xr, yr, xd, yd, vxy, vzy, vzx, vxz, vyz, zr, ry, cy, rYX, rYY, rYZ } = p;
  const zd = computeZd(p);
  const pzx = computePzx(p);
  const pzy = pzx * (px / py); // p_zy = p_zx * p_xy
  const sy = computeSy(ry, cy);
  const bYC = computeByc(sy);
  const PY = computePY(cy, sy);
  // p_Yxyb = boundary marginal price (Y per X at y_b) = 1 / ((py/px)(1+ry))
  const pYxyb = 1 / ((py / px) * (1 + ry));

  if (zd > 0) {
    const ZYD = zd * pzy - rYZ;
    if (ZYD <= 0) return bYC;

    // Transition-point calibration: H=1 at y=y0-yr where CYY first becomes 0.
    // Symmetric to X-side: quadratic AQ·t² + BQ·t + CQ = 0, t = bYC·bYL - 1.
    const pyx = py / px;
    const mY = 1 - cy;
    const aTP_Y = xr + pyx * yr;
    const AQ_Y = vxz * aTP_Y - ZYD * pyx;
    const BQ_Y = pyx * mY * (vxz * yr - 2 * ZYD);
    const CQ_Y = -ZYD * pyx * mY;
    const disc_Y = BQ_Y * BQ_Y - 4 * AQ_Y * CQ_Y;
    let bZL01_tp = NaN;
    if (disc_Y >= 0) {
      const sqrtDisc = Math.sqrt(disc_Y);
      let t: number;
      if (Math.abs(AQ_Y) < 1e-15) {
        t = BQ_Y !== 0 ? -CQ_Y / BQ_Y : NaN;
      } else if (BQ_Y <= 0) {
        t = (-BQ_Y + sqrtDisc) / (2 * AQ_Y);
      } else {
        t = (2 * CQ_Y) / (-BQ_Y - sqrtDisc);
      }
      if (isFinite(t) && t > 0) {
        bZL01_tp = (t + 1) / bYC;
      }
    }

    // Boundary calibration (original): H=1 at y=yb
    const denom01 = yr * vxz * pYxyb * (py / px) * PY;
    const bZL01_b = denom01 > 0 ? (ZYD - vxz * xr * pYxyb) / denom01 : NaN;

    // Take the stricter constraint (higher boost)
    const bZL01 = Math.max(
      isFinite(bZL01_b) ? bZL01_b : -Infinity,
      isFinite(bZL01_tp) ? bZL01_tp : -Infinity
    );
    const vZL01 = (bZL01 >= 1 && (py / px) * yr * bZL01 * PY > 0) ? 1 : 0;

    const denom11 = yr * (vxz * pYxyb * (py / px) * PY - vyz);
    const bZL11 = denom11 !== 0 ? (ZYD - vyz * yr - vxz * xr * pYxyb) / denom11 : NaN;
    const vZL11 = (bZL11 > 0 && bZL11 < 1 && (py / px) * yr * bZL11 * PY > 0) ? 1 : 0;

    // b_ZL10 omitted: dead branch — validity requires (py/px)*yr*bZL10*PY ≤ 0,
    // which is always false with positive parameters.

    if (vZL01 && isFinite(bZL01)) return bYC * bZL01;
    if (vZL11 && isFinite(bZL11)) return bYC * bZL11;
    return bYC;
  }

  const ZYC = vzy * zr * pzy + rYY;

  const denom10 = yr * vxy * pYxyb * (py / px) * PY;
  const bYL10 = denom10 > 0 ? (yd - ZYC + vxy * pYxyb * (xd - xr)) / denom10 : NaN;
  const vYL10 = ((py / px) * yr * bYL10 * PY > xd && bYL10 <= 1) ? 1 : 0;

  // b_YL01: collateral max inactive (bYL > 1), in H_YX phase (xYdelta ≤ xd)
  // Solve H_YX = 1: (vzx*zr*pzy + rYX) / ((xd - xYdelta) * pYxyb) = 1
  const ZYX = vzx * zr * pzy + rYX;
  const denom01 = (py / px) * yr * PY * pYxyb;
  const bYL01 = denom01 > 0 ? (xd * pYxyb - ZYX) / denom01 : NaN;
  const vYL01 = ((py / px) * yr * bYL01 * PY <= xd && bYL01 > 1) ? 1 : 0;

  const denom11 = yr * (vxy * pYxyb * (py / px) * PY - 1);
  const bYL11 = denom11 !== 0 ? (yd - yr - vxy * (xr - xd) * pYxyb - ZYC) / denom11 : NaN;
  const vYL11 = ((py / px) * yr * bYL11 * PY > xd && bYL11 > 1) ? 1 : 0;

  if (vYL11 && isFinite(bYL11)) return bYC * bYL11;
  if (vYL01 && isFinite(bYL01)) return bYC * bYL01;
  if (vYL10 && isFinite(bYL10)) return bYC * bYL10;
  return bYC;
}

/** Virtual (boosted) X reserve at equilibrium: x0 = xr * b_XC * b_XL. */
export function computeX0(p: Params): number {
  if (p.xr <= 0) return 0;
  return p.xr * computeBoostX(p);
}

/** Virtual (boosted) Y reserve at equilibrium: y0 = yr * b_YC * b_YL. */
export function computeY0(p: Params): number {
  if (p.yr <= 0) return 0;
  return p.yr * computeBoostY(p);
}

// --- Range boundaries ---

/** Lower boundary of virtual X reserve: xb = v / s_X. Works for both x0 and xr. */
export function computeXb(v: number, rx: number, cx: number): number {
  return v / Math.sqrt((1 + rx - cx) / (1 - cx));
}

/** Lower boundary of virtual Y reserve: yb = v / s_Y. Works for both y0 and yr. */
export function computeYb(v: number, ry: number, cy: number): number {
  return v / Math.sqrt((1 + ry - cy) / (1 - cy));
}

// --- AMM Curves ---
// These are generic: pass (x0,y0) for boosted or (xr,yr) for real reserves.

/** X-side curve: y = y0 + (px/py)(x0−x)(cx + (1−cx)(x0/x)) for x ∈ (0, x0]. */
export function fX(x: number, cx: number, x0: number, y0: number, px: number, py: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  return y0 + ratio * (x0 - x) * (cx + (1 - cx) * (x0 / x));
}

/** Y-side curve: x = x0 + (py/px)(y0−y)(cy + (1−cy)(y0/y)) for y ∈ (0, y0]. */
export function gY(y: number, cy: number, y0: number, x0: number, px: number, py: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  return x0 + ratio * (y0 - y) * (cy + (1 - cy) * (y0 / y));
}

// --- Inverse AMM curves (citardauq form for numerical stability) ---

/**
 * Inverse Y-side curve for x >= x0. Solves cy·y² + By·y − Cy = 0.
 * Uses citardauq form when B > 0 to avoid catastrophic cancellation.
 */
export function fY(x: number, cy: number, x0: number, y0: number, px: number, py: number): number {
  if (x < x0) return NaN;
  const Ay = cy;
  const By = (px / py) * (x - x0) - (2 * cy - 1) * y0;
  const Cy = (1 - cy) * y0 * y0;

  if (Ay === 0) {
    // cy = 0: simple form
    const denom = (px / py) * (x - x0) + y0;
    if (denom <= 0) return NaN;
    return (y0 * y0) / denom;
  }

  const disc = Math.max(By * By + 4 * Ay * Cy, 0);
  const sqrtDisc = Math.sqrt(disc);

  if (By <= 0) {
    // Standard quadratic form: (-By + √disc) / (2·Ay)
    return (-By + sqrtDisc) / (2 * Ay);
  } else {
    // Citardauq form: 2C / (B + sqrt(B^2 + 4AC)) — numerically stable when B > 0
    return (2 * Cy) / (By + sqrtDisc);
  }
}

/**
 * Inverse X-side curve for y >= y0. Solves cx·x² + Bx·x − Cx = 0.
 * Uses citardauq form when B > 0 to avoid catastrophic cancellation.
 */
export function gX(y: number, cx: number, y0: number, x0: number, px: number, py: number): number {
  if (y < y0) return NaN;
  const Ax = cx;
  const Bx = (py / px) * (y - y0) - (2 * cx - 1) * x0;
  const Cx = (1 - cx) * x0 * x0;

  if (Ax === 0) {
    const denom = (py / px) * (y - y0) + x0;
    if (denom <= 0) return NaN;
    return (x0 * x0) / denom;
  }

  const disc = Math.max(Bx * Bx + 4 * Ax * Cx, 0);
  const sqrtDisc = Math.sqrt(disc);

  if (Bx <= 0) {
    // Standard quadratic form: (-Bx + √disc) / (2·Ax)
    return (-Bx + sqrtDisc) / (2 * Ax);
  } else {
    return (2 * Cx) / (Bx + sqrtDisc);
  }
}

// --- Derivatives ---

/** X-side derivative: fX'(x) = −(px/py)(cx + (1−cx)(x0/x)²). Always negative. */
export function fXd(x: number, cx: number, x0: number, px: number, py: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  const r = x0 / x;
  return -ratio * (cx + (1 - cx) * r * r);
}

/** Y-side derivative: gY'(y) = −(py/px)(cy + (1−cy)(y0/y)²). Always negative. */
export function gYd(y: number, cy: number, y0: number, px: number, py: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  const r = y0 / y;
  return -ratio * (cy + (1 - cy) * r * r);
}

// --- Marginal prices ---

/** Marginal price on X side: Y per X = −fX'(x). */
export function pXxy(x: number, cx: number, x0: number, px: number, py: number): number {
  return -fXd(x, cx, x0, px, py);
}

/** Marginal price on Y side: Y per X = 1/(−gY'(y)). */
export function pYxy(y: number, cy: number, y0: number, px: number, py: number): number {
  const d = -gYd(y, cy, y0, px, py);
  if (d <= 0) return NaN;
  return 1 / d;
}

/** Marginal price on Y side: X per Y = −gY'(y). */
export function pYyx(y: number, cy: number, y0: number, px: number, py: number): number {
  return -gYd(y, cy, y0, px, py);
}

/** Marginal price on X side: X per Y = 1/(−fX'(x)). */
export function pXyx(x: number, cx: number, x0: number, px: number, py: number): number {
  const d = -fXd(x, cx, x0, px, py);
  if (d <= 0) return NaN;
  return 1 / d;
}

// --- Boundary prices ---

/** Marginal price (Y per X) at the X-side boundary x=xb. Upper price bound. */
export function priceAtXb(x0: number, rx: number, cx: number, px: number, py: number): number {
  const xb = computeXb(x0, rx, cx);
  return -fXd(xb, cx, x0, px, py);
}

/** Marginal price (Y per X) at the Y-side boundary y=yb. Lower price bound. */
export function priceAtYb(y0: number, ry: number, cy: number, px: number, py: number): number {
  const yb = computeYb(y0, ry, cy);
  const d = -gYd(yb, cy, y0, px, py); // X per Y
  if (d <= 0) return NaN;
  return 1 / d; // Y per X (same unit convention as priceAtXb)
}

// --- Order book functions ---
// The independent variable (x or y) is **price increase from equilibrium**.
// x=0 means at equilibrium price; x=rx means at the X-side boundary.

/** Cumulative same-asset liquidity: X remaining at price delta x from equilibrium. */
export function LXX(x: number, cx: number, x0: number): number {
  if (x < 0) return NaN;
  return computeXb(x0, x, cx);
}

/** Cumulative same-asset liquidity: Y remaining at price delta y from equilibrium. */
export function LYY(y: number, cy: number, y0: number): number {
  if (y < 0) return NaN;
  return computeYb(y0, y, cy);
}

/** Liquidity density of X per unit price delta: −dL_XX/dx. */
export function lXX(x: number, cx: number, x0: number): number {
  if (x < 0 || cx >= 1) return NaN;
  const inner = 1 + x - cx;
  if (inner <= 0) return NaN;
  return (x0 * Math.sqrt(1 - cx)) / (2 * Math.pow(inner, 1.5));
}

/** Liquidity density of Y per unit price delta: −dL_YY/dy. */
export function lYY(y: number, cy: number, y0: number): number {
  if (y < 0 || cy >= 1) return NaN;
  const inner = 1 + y - cy;
  if (inner <= 0) return NaN;
  return (y0 * Math.sqrt(1 - cy)) / (2 * Math.pow(inner, 1.5));
}

/** Liquidity fingerprint: density ratio vs c=0 baseline. F_X = l_XX(cx) / l_XX(0). */
export function FX(x: number, cx: number): number {
  if (x < 0 || cx >= 1) return NaN;
  const a = 1 + x;
  const b = 1 + x - cx;
  if (b <= 0) return NaN;
  return Math.sqrt(1 - cx) * Math.pow(a, 1.5) / Math.pow(b, 1.5);
}

/** Liquidity fingerprint: density ratio vs c=0 baseline. F_Y = l_YY(cy) / l_YY(0). */
export function FY(y: number, cy: number): number {
  if (y < 0 || cy >= 1) return NaN;
  const a = 1 + y;
  const b = 1 + y - cy;
  if (b <= 0) return NaN;
  return Math.sqrt(1 - cy) * Math.pow(a, 1.5) / Math.pow(b, 1.5);
}

/** Cross-asset cumulative: Y amount available at price delta x (X side). */
export function LXY(x: number, cx: number, x0: number, y0: number, px: number, py: number): number {
  const xPos = LXX(x, cx, x0);
  if (!isFinite(xPos)) return NaN;
  return fX(xPos, cx, x0, y0, px, py);
}

/** Cross-asset cumulative: X amount available at price delta y (Y side). */
export function LYX(y: number, cy: number, y0: number, x0: number, px: number, py: number): number {
  const yPos = LYY(y, cy, y0);
  if (!isFinite(yPos)) return NaN;
  return gY(yPos, cy, y0, x0, px, py);
}

/** Cross-asset density: Y per unit price delta on X side. l_XY = pXxy · l_XX. */
export function lXY(x: number, cx: number, x0: number, y0: number, px: number, py: number): number {
  const xPos = LXX(x, cx, x0);
  if (!isFinite(xPos)) return NaN;
  const price = pXxy(xPos, cx, x0, px, py);
  const dens = lXX(x, cx, x0);
  if (!isFinite(price) || !isFinite(dens)) return NaN;
  return price * dens;
}

/** Cross-asset density: X per unit price delta on Y side. l_YX = pYyx · l_YY. */
export function lYX(y: number, cy: number, y0: number, x0: number, px: number, py: number): number {
  const yPos = LYY(y, cy, y0);
  if (!isFinite(yPos)) return NaN;
  const price = pYyx(yPos, cy, y0, px, py);
  const dens = lYY(y, cy, y0);
  if (!isFinite(price) || !isFinite(dens)) return NaN;
  return price * dens;
}

// --- Order book point generation ---

/** A single point on the order book: cumulative/density liquidity at a given price delta. */
export interface OrderBookPoint {
  priceDelta: number;
  cumSame: number;
  cumCross: number;
  densSame: number;
  densCross: number;
  fingerprint: number;
}

/** Generate n order book points on the X side (price rising from equilibrium to boundary). */
export function generateOrderBookPointsX(
  x0: number, y0: number, cx: number, rx: number, px: number, py: number, n = 200
): OrderBookPoint[] {
  const points: OrderBookPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const x = rx * (i / n);
    const cumSame = LXX(x, cx, x0);
    const cumCross = LXY(x, cx, x0, y0, px, py);
    const densSame = lXX(x, cx, x0);
    const densCross = lXY(x, cx, x0, y0, px, py);
    const fingerprint = FX(x, cx);
    if ([cumSame, cumCross, densSame, densCross, fingerprint].some(v => !isFinite(v))) continue;
    points.push({ priceDelta: x, cumSame, cumCross, densSame, densCross, fingerprint });
  }
  return points;
}

/** Generate n order book points on the Y side (price dropping from equilibrium to boundary). */
export function generateOrderBookPointsY(
  x0: number, y0: number, cy: number, ry: number, px: number, py: number, n = 200
): OrderBookPoint[] {
  const points: OrderBookPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const y = ry * (i / n);
    const cumSame = LYY(y, cy, y0);
    const cumCross = LYX(y, cy, y0, x0, px, py);
    const densSame = lYY(y, cy, y0);
    const densCross = lYX(y, cy, y0, x0, px, py);
    const fingerprint = FY(y, cy);
    if ([cumSame, cumCross, densSame, densCross, fingerprint].some(v => !isFinite(v))) continue;
    points.push({ priceDelta: y, cumSame, cumCross, densSame, densCross, fingerprint });
  }
  return points;
}

// --- Generate curve points for plotting ---

/** A point on the AMM curve (x, y). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Generate n points on the fX curve (x ≤ equilibrium). Pass x0/y0 for boosted or xr/yr for real. */
export function generateFXPoints(eqX: number, eqY: number, px: number, py: number, cx: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMin = eqX * 0.01;
  for (let i = 0; i <= n; i++) {
    const x = xMin + (eqX - xMin) * (i / n);
    const y = fX(x, cx, eqX, eqY, px, py);
    if (isFinite(y)) points.push({ x, y });
  }
  return points;
}

/** Generate n points on the fY curve (x ≥ equilibrium, inverse/quadratic side). */
export function generateFYPoints(eqX: number, eqY: number, px: number, py: number, cy: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMax = eqX * 3;
  for (let i = 0; i <= n; i++) {
    const x = eqX + (xMax - eqX) * (i / n);
    const y = fY(x, cy, eqX, eqY, px, py);
    if (isFinite(y) && y > 0) points.push({ x, y });
  }
  return points;
}

/** Generate fX curve points shifted so range boundary is at origin. */
export function generateShiftedFXPoints(
  eqX: number, eqY: number, px: number, py: number, cx: number, cy: number, rx: number, ry: number, n = 200
): CurvePoint[] {
  const xb = computeXb(eqX, rx, cx);
  const yb = computeYb(eqY, ry, cy);
  const points: CurvePoint[] = [];
  const xMax = eqX - xb;
  if (xMax <= 0) return points;
  for (let i = 1; i <= n; i++) {
    const x = xMax * (i / n);
    const y = fX(x + xb, cx, eqX, eqY, px, py) - yb;
    if (isFinite(y) && y >= 0) points.push({ x, y });
  }
  return points;
}

/** Generate gY curve points shifted so range boundary is at origin. */
export function generateShiftedGYPoints(
  eqX: number, eqY: number, px: number, py: number, cx: number, cy: number, rx: number, ry: number, n = 200
): CurvePoint[] {
  const xb = computeXb(eqX, rx, cx);
  const yb = computeYb(eqY, ry, cy);
  const points: CurvePoint[] = [];
  const yMax = eqY - yb;
  if (yMax <= 0) return points;
  for (let i = 1; i <= n; i++) {
    const y = yMax * (i / n);
    const x = gY(y + yb, cy, eqY, eqX, px, py) - xb;
    if (isFinite(x) && x >= 0) points.push({ x, y });
  }
  return points;
}

// --- Collateral and Debt on X side ---
// Swap deltas: x_Xdelta = x0 - x, y_Xdelta = fX(x) - y0

/** Virtual x where real X reserves are fully depleted (C_XX = 0). */
export function xXXdebt(x0: number, xr: number): number {
  return x0 - xr;
}

/** Virtual x where Y debt is fully repaid by swap (D_XY = 0). Solves fX(x)−y0 = yd. */
export function xXYdebt(x0: number, cx: number, yd: number, px: number, py: number): number {
  if (yd <= 0) return x0;
  const kX = yd * py / px;
  if (cx === 0) {
    return (x0 * x0) / (kX + x0);
  }
  const A = kX - x0 * (2 * cx - 1);
  const disc = A * A + 4 * cx * (1 - cx) * x0 * x0;
  if (disc < 0) return NaN;
  return (x0 * (2 * cx - 1) - kX + Math.sqrt(disc)) / (2 * cx);
}

/** X collateral on X side: max(xr − (x0−x), 0). Zero when X reserves are depleted. */
export function CXX(x: number, x0: number, xr: number): number {
  return Math.max(xr - (x0 - x), 0);
}

/** Y collateral on X side. Includes yr plus Y gained from swap, minus Y debt if applicable. */
export function CXY_fn(x: number, cx: number, x0: number, y0: number, px: number, py: number, yr: number, yd: number, zd: number): number {
  const fxVal = fX(x, cx, x0, y0, px, py);
  if (!isFinite(fxVal)) return NaN;
  const yXdelta = fxVal - y0;
  if (zd > 0) {
    return yr + Math.max(yXdelta, 0);
  }
  return yr + Math.max(yXdelta - yd, 0);
}

/** X debt on X side: xd plus excess swap delta beyond xr. Zero when Z debt or outside phase. */
export function DXX(x: number, x0: number, xr: number, xd: number, xXXd: number, xXYd: number, zd: number): number {
  if (zd > 0) return 0;
  if (x > xXXd || x > xXYd) return 0;
  return xd + Math.max((x0 - x) - xr, 0);
}

/** Y debt on X side: remaining yd not yet repaid by swap delta. Zero when Z debt or past xXYdebt. */
export function DXY(x: number, cx: number, x0: number, y0: number, px: number, py: number, yd: number, xXYd: number, zd: number): number {
  if (zd > 0) return 0;
  if (x < xXYd) return 0;
  const fxVal = fX(x, cx, x0, y0, px, py);
  if (!isFinite(fxVal)) return NaN;
  return Math.max(yd - (fxVal - y0), 0);
}

// CXZ = zr (constant, doesn't change with swaps)
// DXZ = zd (constant, doesn't change with swaps)

// --- Health scores on X side (three branches) ---

/**
 * Health score on X side at virtual reserve x.
 * Three branches: H_XZ (Z debt), H_XX (X debt phase), H_XY (Y debt phase).
 * Returns Infinity when no debt is outstanding in the current phase.
 */
export function computeHX(
  x: number, p: Params, x0: number, y0: number
): number {
  if (x <= 0 || x > x0) return NaN;
  const { cx, px, py, xr, yr, xd, yd, zr, vyx, vxy, vzx, vzy, vxz, vyz, rXX, rXY, rXZ, pxz } = p;
  const zd = computeZd(p);
  const pzx = 1 / pxz;
  const xXXd = xXXdebt(x0, xr);
  const xXYd = xXYdebt(x0, cx, yd, px, py);

  // Marginal price pXyx at x (1/(-fXd))
  const pXyxVal = pXyx(x, cx, x0, px, py);
  if (!isFinite(pXyxVal) || pXyxVal <= 0) return NaN;

  const cxx = CXX(x, x0, xr);
  const cxy = CXY_fn(x, cx, x0, y0, px, py, yr, yd, zd);

  if (zd > 0) {
    // H_XZ: Z debt active
    const dxz = zd;
    if (dxz <= 0 || pxz <= 0) return NaN;
    return (vxz * cxx + vyz * cxy * pXyxVal + rXZ) / (dxz * pzx);
  }

  // X/Y debt — pick branch based on phase
  if (x <= xXYd) {
    // H_XX: X debt active (Y debt fully repaid, X debt accumulating)
    const dxx = DXX(x, x0, xr, xd, xXXd, xXYd, zd);
    if (dxx <= 0) return Infinity; // no debt in this region — position is safe
    return (vyx * cxy * pXyxVal + vzx * zr * pzx + rXX) / dxx;
  } else {
    // H_XY: Y debt active
    const dxy = DXY(x, cx, x0, y0, px, py, yd, xXYd, zd);
    if (dxy <= 0) return Infinity; // no debt in this region — position is safe
    return (vxy * cxx + vzy * zr * pzx + rXY) / (dxy * pXyxVal);
  }
}

// --- Collateral and Debt on Y side (symmetric to X side) ---

/** Virtual y where real Y reserves are fully depleted (C_YY = 0). */
export function yYYdebt(y0: number, yr: number): number {
  return y0 - yr;
}

/** Virtual y where X debt is fully repaid by swap (D_YX = 0). Solves gY(y)−x0 = xd. */
export function yYXdebt(y0: number, cy: number, xd: number, px: number, py: number): number {
  if (xd <= 0) return y0;
  const kY = xd * px / py;
  if (cy === 0) {
    return (y0 * y0) / (kY + y0);
  }
  const A = kY - y0 * (2 * cy - 1);
  const disc = A * A + 4 * cy * (1 - cy) * y0 * y0;
  if (disc < 0) return NaN;
  return (y0 * (2 * cy - 1) - kY + Math.sqrt(disc)) / (2 * cy);
}

/** Y collateral on Y side: max(yr − (y0−y), 0). Zero when Y reserves are depleted. */
export function CYY(y: number, y0: number, yr: number): number {
  return Math.max(yr - (y0 - y), 0);
}

/** X collateral on Y side. Includes xr plus X gained from swap, minus X debt if applicable. */
export function CYX_fn(y: number, cy: number, y0: number, x0: number, px: number, py: number, xr: number, xd: number, zd: number): number {
  const gyVal = gY(y, cy, y0, x0, px, py);
  if (!isFinite(gyVal)) return NaN;
  const xYdelta = gyVal - x0;
  if (zd > 0) {
    return xr + Math.max(xYdelta, 0);
  }
  return xr + Math.max(xYdelta - xd, 0);
}

/** Y debt on Y side: yd plus excess swap delta beyond yr. Zero when Z debt or outside phase. */
export function DYY(y: number, y0: number, yr: number, yd: number, yYYd: number, yYXd: number, zd: number): number {
  if (zd > 0) return 0;
  if (y > yYYd || y > yYXd) return 0;
  return yd + Math.max((y0 - y) - yr, 0);
}

/** X debt on Y side: remaining xd not yet repaid by swap delta. Zero when Z debt or past yYXdebt. */
export function DYX(y: number, cy: number, y0: number, x0: number, px: number, py: number, xd: number, yYXd: number, zd: number): number {
  if (zd > 0) return 0;
  if (y < yYXd) return 0;
  const gyVal = gY(y, cy, y0, x0, px, py);
  if (!isFinite(gyVal)) return NaN;
  return Math.max(xd - (gyVal - x0), 0);
}

/**
 * Health score on Y side at virtual reserve y.
 * Three branches: H_YZ (Z debt), H_YY (Y debt phase), H_YX (X debt phase).
 * Returns Infinity when no debt is outstanding in the current phase.
 */
export function computeHY(
  y: number, p: Params, x0: number, y0: number
): number {
  if (y <= 0 || y > y0) return NaN;
  const { cy, px, py, xr, yr, xd, yd, zr, vyx, vxy, vzx, vzy, vxz, vyz, rYX, rYY, rYZ, pxz } = p;
  const zd = computeZd(p);
  const pzx = 1 / pxz;
  const pzy = pzx * (px / py);
  const yYYd = yYYdebt(y0, yr);
  const yYXd = yYXdebt(y0, cy, xd, px, py);

  // Marginal price pYxy at y (1/(-gYd))
  const pYxyVal = pYxy(y, cy, y0, px, py);
  if (!isFinite(pYxyVal) || pYxyVal <= 0) return NaN;

  const cyy = CYY(y, y0, yr);
  const cyx = CYX_fn(y, cy, y0, x0, px, py, xr, xd, zd);

  if (zd > 0) {
    // H_YZ: Z debt active
    const dyz = zd;
    if (dyz <= 0 || pxz <= 0) return NaN;
    return (vyz * cyy + vxz * cyx * pYxyVal + rYZ) / (dyz * pzy);
  }

  if (y <= yYXd) {
    // H_YY: Y debt active
    const dyy = DYY(y, y0, yr, yd, yYYd, yYXd, zd);
    if (dyy <= 0) return Infinity; // no debt in this region — position is safe
    return (vxy * cyx * pYxyVal + vzy * zr * pzy + rYY) / dyy;
  } else {
    // H_YX: X debt active
    const dyx = DYX(y, cy, y0, x0, px, py, xd, yYXd, zd);
    if (dyx <= 0) return Infinity; // no debt in this region — position is safe
    return (vyx * cyy + vzx * zr * pzy + rYX) / (dyx * pYxyVal);
  }
}

/** Net Asset Value in X units on X side. Collateral minus debt, all converted to X. */
export function computeNAV_X(x: number, p: Params, x0: number, y0: number): number {
  if (x <= 0 || x > x0) return NaN;
  const { cx, px, py, xr, yr, xd, yd, zr, pxz, eXC, eXD } = p;
  const zd = computeZd(p);
  const pzx = 1 / pxz;
  const xXXd = xXXdebt(x0, xr);
  const xXYd = xXYdebt(x0, cx, yd, px, py);

  const pXyxVal = pXyx(x, cx, x0, px, py);
  if (!isFinite(pXyxVal)) return NaN;

  const cxx = CXX(x, x0, xr);
  const cxy = CXY_fn(x, cx, x0, y0, px, py, yr, yd, zd);
  const dxx = DXX(x, x0, xr, xd, xXXd, xXYd, zd);
  const dxy = DXY(x, cx, x0, y0, px, py, yd, xXYd, zd);

  return cxx + cxy * pXyxVal + zr * pzx - dxx - dxy * pXyxVal - zd * pzx + eXC - eXD;
}

/** Net Asset Value in Y units on Y side. Collateral minus debt, all converted to Y. */
export function computeNAV_Y(y: number, p: Params, x0: number, y0: number): number {
  if (y <= 0 || y > y0) return NaN;
  const { cy, px, py, xr, yr, xd, yd, zr, pxz, eYC, eYD } = p;
  const zd = computeZd(p);
  const pzx = 1 / pxz;
  const pzy = pzx * (px / py);
  const yYYd = yYYdebt(y0, yr);
  const yYXd = yYXdebt(y0, cy, xd, px, py);

  const pYxyVal = pYxy(y, cy, y0, px, py);
  if (!isFinite(pYxyVal)) return NaN;

  const cyy = CYY(y, y0, yr);
  const cyx = CYX_fn(y, cy, y0, x0, px, py, xr, xd, zd);
  const dyy = DYY(y, y0, yr, yd, yYYd, yYXd, zd);
  const dyx = DYX(y, cy, y0, x0, px, py, xd, yYXd, zd);

  return cyy + cyx * pYxyVal + zr * pzy - dyy - dyx * pYxyVal - zd * pzy + eYC - eYD;
}

// --- Generate collateral/debt/health points ---

/** Collateral, debt, health, and NAV at a single virtual reserve position. */
export interface MultiPoint {
  x: number;
  cxx?: number;
  cxy?: number; // C_XY on X side (Y collateral)
  dxx?: number;
  dxy?: number; // D_XY on X side (Y debt)
  dxz?: number; // D_XZ (Z debt, constant)
  hx?: number;
  navx?: number;
  cyy?: number;
  cyx?: number; // C_YX on Y side (X collateral)
  dyy?: number;
  dyx?: number; // D_YX on Y side (X debt)
  dyz?: number;
  hy?: number;
  navy?: number;
}

/** Generate n collateral/debt/health/NAV points across the X-side range. ext > 1 extends past boundary. */
export function generateCollateralDebtPoints(p: Params, n = 300, ext = 1.0): MultiPoint[] {
  const { cx, rx, xr, yd, px, py } = p;
  const zd = computeZd(p);
  const x0 = computeX0(p);
  const y0 = computeY0(p);
  const xb = computeXb(x0, rx, cx);
  const xXXd = xXXdebt(x0, xr);
  const xXYd = xXYdebt(x0, cx, yd, px, py);

  const points: MultiPoint[] = [];
  const xRange = x0 - xb;
  if (xRange <= 0) return points;
  const xExtend = xRange * (ext - 1); // extra range past boundary
  const xTotal = xRange + xExtend;

  for (let i = 0; i <= n; i++) {
    const xShifted = -xExtend + xTotal * (i / n);
    const xVirtual = xShifted + xb;
    if (xVirtual <= 0 || xVirtual > x0) continue;

    const cxx = CXX(xVirtual, x0, xr);
    const cxy = CXY_fn(xVirtual, cx, x0, y0, px, py, p.yr, yd, zd);
    const dxx = DXX(xVirtual, x0, xr, p.xd, xXXd, xXYd, zd);
    const dxy = DXY(xVirtual, cx, x0, y0, px, py, yd, xXYd, zd);
    const hx = computeHX(xVirtual, p, x0, y0);
    const navx = computeNAV_X(xVirtual, p, x0, y0);

    const pt: MultiPoint = { x: xShifted };
    if (isFinite(cxx)) pt.cxx = cxx;
    if (isFinite(cxy)) pt.cxy = cxy;
    if (isFinite(dxx) && dxx > 0) pt.dxx = dxx;
    if (isFinite(dxy) && dxy > 0) pt.dxy = dxy;
    if (zd > 0) pt.dxz = zd;
    if (isFinite(hx) && hx > 0) pt.hx = hx;
    if (isFinite(navx)) pt.navx = navx;
    points.push(pt);
  }
  return points;
}

/** Generate n collateral/debt/health/NAV points across the Y-side range. ext > 1 extends past boundary. */
export function generateCollateralDebtPointsY(p: Params, n = 300, ext = 1.0): MultiPoint[] {
  const { cy, ry, yr, xd, px, py } = p;
  const zd = computeZd(p);
  const x0 = computeX0(p);
  const y0 = computeY0(p);
  const yb = computeYb(y0, ry, cy);
  const yYYd = yYYdebt(y0, yr);
  const yYXd = yYXdebt(y0, cy, xd, px, py);

  const points: MultiPoint[] = [];
  const yRange = y0 - yb;
  if (yRange <= 0) return points;
  const yExtend = yRange * (ext - 1); // extra range past boundary
  const yTotal = yRange + yExtend;

  for (let i = 0; i <= n; i++) {
    const yShifted = -yExtend + yTotal * (i / n);
    const yVirtual = yShifted + yb;
    if (yVirtual <= 0 || yVirtual > y0) continue;

    const cyy = CYY(yVirtual, y0, yr);
    const cyx = CYX_fn(yVirtual, cy, y0, x0, px, py, p.xr, xd, zd);
    const dyy = DYY(yVirtual, y0, yr, p.yd, yYYd, yYXd, zd);
    const dyx = DYX(yVirtual, cy, y0, x0, px, py, xd, yYXd, zd);
    const hy = computeHY(yVirtual, p, x0, y0);
    const navy = computeNAV_Y(yVirtual, p, x0, y0);

    const pt: MultiPoint = { x: yShifted };
    if (isFinite(cyy)) pt.cyy = cyy;
    if (isFinite(cyx)) pt.cyx = cyx;
    if (isFinite(dyy) && dyy > 0) pt.dyy = dyy;
    if (isFinite(dyx) && dyx > 0) pt.dyx = dyx;
    if (zd > 0) pt.dyz = zd;
    if (isFinite(hy) && hy > 0) pt.hy = hy;
    if (isFinite(navy)) pt.navy = navy;
    points.push(pt);
  }
  return points;
}

