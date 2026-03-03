// EulerSwap AMM curve math
// All functions derived from the Desmos specification

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
}

// Derived: zd is only active when xd=0 and yd=0
export function computeZd(p: Params): number {
  if (p.xd > 0 || p.yd > 0) return 0;
  return p.zdebt;
}

// Derived prices
export function computePxy(p: Params): number { return p.px / p.py; }
export function computePyx(p: Params): number { return p.py / p.px; }
export function computePzx(p: Params): number { return 1 / p.pxz; }

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
};

// --- Boosted (virtual) reserves ---
// x0 = xr * bx, y0 = yr * by
// The boost formula depends on the full EulerSwap lending integration.
// TODO: Replace with the actual boost formula when available.
// Current approximation: leverage = 1/(1 - lYX*lXY) applied to total collateral.

export function computeX0(p: Params): number {
  const { px, py, xr, yr, vyx, vxy, xd, yd } = p;
  const priceRatio = px / py;
  const leverage = 1 / (1 - vyx * vxy);
  const total = xr + xd + vyx * (yr + yd) / priceRatio;
  return total * leverage * priceRatio;
}

export function computeY0(p: Params): number {
  const { px, py, xr, yr, vyx, vxy, xd, yd } = p;
  const priceRatio = py / px;
  const leverage = 1 / (1 - vyx * vxy);
  const total = yr + yd + vxy * (xr + xd) / priceRatio;
  return total * leverage * priceRatio;
}

// --- Range boundaries ---
// xb(v) = v / sqrt((1 + rx - cx) / (1 - cx))  — works for both x0 and xr
export function computeXb(v: number, rx: number, cx: number): number {
  return v / Math.sqrt((1 + rx - cx) / (1 - cx));
}

// yb(v) = v / sqrt((1 + ry - cy) / (1 - cy))  — works for both y0 and yr
export function computeYb(v: number, ry: number, cy: number): number {
  return v / Math.sqrt((1 + ry - cy) / (1 - cy));
}

// --- AMM Curves ---
// These are generic: pass (x0,y0) for boosted or (xr,yr) for real reserves.

// fX(x, cx, x0, y0) = y0 + (px/py)(x0 - x)(cx + (1-cx)(x0/x))  {0 < x <= x0}
export function fX(x: number, cx: number, x0: number, y0: number, px: number, py: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  return y0 + ratio * (x0 - x) * (cx + (1 - cx) * (x0 / x));
}

// gY(y, cy, y0, x0) = x0 + (py/px)(y0 - y)(cy + (1-cy)(y0/y))  {0 < y <= y0}
export function gY(y: number, cy: number, y0: number, x0: number, px: number, py: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  return x0 + ratio * (y0 - y) * (cy + (1 - cy) * (y0 / y));
}

// --- Inverse AMM curves (citardauq form for numerical stability) ---
// fY(x, cy, x0, y0) for x >= x0
// Uses A_y = cy, B_y = (px/py)(x-x0) - (2cy-1)*y0, C_y = (1-cy)*y0^2
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
    // Standard quadratic form
    return (By + sqrtDisc) / (2 * Ay);
  } else {
    // Citardauq form: 2C / (B + sqrt(B^2 + 4AC)) — numerically stable when B > 0
    return (2 * Cy) / (By + sqrtDisc);
  }
}

// gX(y, cx, y0, x0) for y >= y0
// Uses A_x = cx, B_x = (py/px)(y-y0) - (2cx-1)*x0, C_x = (1-cx)*x0^2
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
    return (Bx + sqrtDisc) / (2 * Ax);
  } else {
    return (2 * Cx) / (Bx + sqrtDisc);
  }
}

// --- Derivatives ---
// fXd(x, cx, x0) = -(px/py)(cx + (1-cx)(x0/x)^2)  {0 < x <= x0}
export function fXd(x: number, cx: number, x0: number, px: number, py: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  const r = x0 / x;
  return -ratio * (cx + (1 - cx) * r * r);
}

// gYd(y, cy, y0) = -(py/px)(cy + (1-cy)(y0/y)^2)  {0 < y <= y0}
export function gYd(y: number, cy: number, y0: number, px: number, py: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  const r = y0 / y;
  return -ratio * (cy + (1 - cy) * r * r);
}

// --- Marginal prices ---
// Amount of Y per X (price for converting between X, Y)
// pXxy(x) = -fXd(x)  [on X side of curve]
// pYxy(y) = 1 / (-gYd(y))  [on Y side of curve]
export function pXxy(x: number, cx: number, x0: number, px: number, py: number): number {
  return -fXd(x, cx, x0, px, py);
}

export function pYxy(y: number, cy: number, y0: number, px: number, py: number): number {
  const d = -gYd(y, cy, y0, px, py);
  if (d <= 0) return NaN;
  return 1 / d;
}

// Amount of X per Y (price for converting between X, Y)
// pYyx(y) = -gYd(y)  [on Y side of curve]
// pXyx(x) = 1 / (-fXd(x))  [on X side of curve]
export function pYyx(y: number, cy: number, y0: number, px: number, py: number): number {
  return -gYd(y, cy, y0, px, py);
}

export function pXyx(x: number, cx: number, x0: number, px: number, py: number): number {
  const d = -fXd(x, cx, x0, px, py);
  if (d <= 0) return NaN;
  return 1 / d;
}

// --- Boundary prices ---
export function priceAtXb(x0: number, rx: number, cx: number, px: number, py: number): number {
  const xb = computeXb(x0, rx, cx);
  return -fXd(xb, cx, x0, px, py);
}

export function priceAtYb(y0: number, ry: number, cy: number, px: number, py: number): number {
  const yb = computeYb(y0, ry, cy);
  return -gYd(yb, cy, y0, px, py);
}

// --- Generate curve points for plotting ---

export interface CurvePoint {
  x: number;
  y: number;
}

// fX points (x <= equilibrium): pass x0,y0 for boosted or xr,yr for real
export function generateFXPoints(eqX: number, eqY: number, px: number, py: number, cx: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMin = eqX * 0.01;
  for (let i = 0; i <= n; i++) {
    const x = xMin + (eqX - xMin) * (i / n);
    const y = fX(x, cx, eqX, eqY, px, py);
    if (!isNaN(y) && isFinite(y)) points.push({ x, y });
  }
  return points;
}

// fY points (x >= equilibrium): inverse/quadratic side
export function generateFYPoints(eqX: number, eqY: number, px: number, py: number, cy: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMax = eqX * 3;
  for (let i = 0; i <= n; i++) {
    const x = eqX + (xMax - eqX) * (i / n);
    const y = fY(x, cy, eqX, eqY, px, py);
    if (!isNaN(y) && isFinite(y) && y > 0) points.push({ x, y });
  }
  return points;
}

// gY points (y <= equilibrium)
export function generateGYPoints(eqX: number, eqY: number, px: number, py: number, cy: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const yMin = eqY * 0.01;
  for (let i = 0; i <= n; i++) {
    const y = yMin + (eqY - yMin) * (i / n);
    const x = gY(y, cy, eqY, eqX, px, py);
    if (!isNaN(x) && isFinite(x)) points.push({ x, y });
  }
  return points;
}

// gX points (y >= equilibrium): inverse/quadratic side
export function generateGXPoints(eqX: number, eqY: number, px: number, py: number, cx: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const yMax = eqY * 3;
  for (let i = 0; i <= n; i++) {
    const y = eqY + (yMax - eqY) * (i / n);
    const x = gX(y, cx, eqY, eqX, px, py);
    if (!isNaN(x) && isFinite(x) && x > 0) points.push({ x, y });
  }
  return points;
}

// Shifted curve points (shifted so range boundary is at origin)
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
    if (!isNaN(y) && isFinite(y) && y >= 0) points.push({ x, y });
  }
  return points;
}

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
    if (!isNaN(x) && isFinite(x) && x >= 0) points.push({ x, y });
  }
  return points;
}

// --- Collateral and Debt on X side ---

// kX = yd * py / px
export function computeKx(yd: number, py: number, px: number): number {
  return yd * py / px;
}

// xc(x0): where Y debt gets fully repaid (solve fX(xc) = y0 + yd)
export function computeXc(x0: number, cx: number, kX: number): number {
  if (kX <= 0) return x0;
  if (cx === 0) {
    return (x0 * x0) / (x0 + kX);
  }
  const A = kX - x0 * (2 * cx - 1);
  const disc = A * A + 4 * cx * (1 - cx) * x0 * x0;
  if (disc < 0) return NaN;
  return (x0 * (2 * cx - 1) - kX + Math.sqrt(disc)) / (2 * cx);
}

// CXX(x, x0) = max(xr - (x0 - x), 0)
export function CXX(x: number, x0: number, xr: number): number {
  return Math.max(xr - (x0 - x), 0);
}

// CYX(x, x0) = yr + max(yXdelta - yd, 0), where yXdelta = fX(x) - y0
export function CYX(x: number, cx: number, x0: number, y0: number, px: number, py: number, yr: number, yd: number): number {
  const yXdelta = fX(x, cx, x0, y0, px, py) - y0;
  return yr + Math.max(yXdelta - yd, 0);
}

// DXX(x, x0) = (xd + max(xXdelta - xr, 0)) {x <= xc}
export function DXX(x: number, x0: number, xr: number, xd: number, xc: number): number {
  if (x > xc) return 0;
  return xd + Math.max((x0 - x) - xr, 0);
}

// DYX(x, x0) = max(yd - yXdelta, 0)
export function DYX(x: number, cx: number, x0: number, y0: number, px: number, py: number, yd: number): number {
  const yXdelta = fX(x, cx, x0, y0, px, py) - y0;
  return Math.max(yd - yXdelta, 0);
}

// Health score on X side
export function HX(
  x: number, cx: number, x0: number, y0: number, px: number, py: number,
  xr: number, yr: number, xd: number, yd: number, lYX: number, xc: number
): number {
  if (x <= 0 || x > x0) return NaN;
  if (x <= xc) {
    const dxx = DXX(x, x0, xr, xd, xc);
    if (dxx <= 0) return NaN;
    const cyx = CYX(x, cx, x0, y0, px, py, yr, yd);
    const price = -fXd(x, cx, x0, px, py);
    return lYX * (cyx / price) / dxx;
  } else {
    const dyx = DYX(x, cx, x0, y0, px, py, yd);
    if (dyx <= 0) return NaN;
    const cyx = CYX(x, cx, x0, y0, px, py, yr, yd);
    return lYX * cyx / dyx;
  }
}

// --- Collateral and Debt on Y side (symmetric) ---

export function computeKy(xd: number, px: number, py: number): number {
  return xd * px / py;
}

export function computeYc(y0: number, cy: number, kY: number): number {
  if (kY <= 0) return y0;
  if (cy === 0) {
    return (y0 * y0) / (y0 + kY);
  }
  const A = kY - y0 * (2 * cy - 1);
  const disc = A * A + 4 * cy * (1 - cy) * y0 * y0;
  if (disc < 0) return NaN;
  return (y0 * (2 * cy - 1) - kY + Math.sqrt(disc)) / (2 * cy);
}

export function CYY(y: number, y0: number, yr: number): number {
  return Math.max(yr - (y0 - y), 0);
}

export function CXY(y: number, cy: number, y0: number, x0: number, px: number, py: number, xr: number, xd: number): number {
  const xYdelta = gY(y, cy, y0, x0, px, py) - x0;
  return xr + Math.max(xYdelta - xd, 0);
}

export function DYY(y: number, y0: number, yr: number, yd: number, yc: number): number {
  if (y > yc) return 0;
  return yd + Math.max((y0 - y) - yr, 0);
}

export function DXY(y: number, cy: number, y0: number, x0: number, px: number, py: number, xd: number): number {
  const xYdelta = gY(y, cy, y0, x0, px, py) - x0;
  return Math.max(xd - xYdelta, 0);
}

export function HY(
  y: number, cy: number, y0: number, x0: number, px: number, py: number,
  xr: number, yr: number, xd: number, yd: number, lXY: number, yc: number
): number {
  if (y <= 0 || y > y0) return NaN;
  if (y <= yc) {
    const dyy = DYY(y, y0, yr, yd, yc);
    if (dyy <= 0) return NaN;
    const cxy = CXY(y, cy, y0, x0, px, py, xr, xd);
    const price = -gYd(y, cy, y0, px, py);
    return lXY * (cxy / price) / dyy;
  } else {
    const dxy = DXY(y, cy, y0, x0, px, py, xd);
    if (dxy <= 0) return NaN;
    const cxy = CXY(y, cy, y0, x0, px, py, xr, xd);
    return lXY * cxy / dxy;
  }
}

// --- Generate collateral/debt/health points ---

export interface MultiPoint {
  x: number;
  cxx?: number;
  cyx?: number;
  dxx?: number;
  dyx?: number;
  hx?: number;
  cyy?: number;
  cxy?: number;
  dyy?: number;
  dxy?: number;
  hy?: number;
}

export function generateCollateralDebtPoints(p: Params, n = 300): MultiPoint[] {
  const { px, py, cx, cy, rx, ry, xr, yr, xd, yd, vyx: lYX } = p;
  const x0 = computeX0(p);
  const y0 = computeY0(p);
  const xb = computeXb(x0, rx, cx);
  const kX = computeKx(yd, py, px);
  const xc = computeXc(x0, cx, kX);

  const points: MultiPoint[] = [];
  const xMax = x0 - xb;
  if (xMax <= 0) return points;

  for (let i = 0; i <= n; i++) {
    const xShifted = xMax * (i / n);
    const xVirtual = xShifted + xb;
    if (xVirtual <= 0 || xVirtual > x0) continue;

    const cxx = CXX(xVirtual, x0, xr);
    const cyx = CYX(xVirtual, cx, x0, y0, px, py, yr, yd);
    const dxx = DXX(xVirtual, x0, xr, xd, xc);
    const dyx = DYX(xVirtual, cx, x0, y0, px, py, yd);
    const hx = HX(xVirtual, cx, x0, y0, px, py, xr, yr, xd, yd, lYX, xc);

    const pt: MultiPoint = { x: xShifted };
    if (isFinite(cxx)) pt.cxx = cxx;
    if (isFinite(cyx)) pt.cyx = cyx;
    if (isFinite(dxx) && dxx > 0) pt.dxx = dxx;
    if (isFinite(dyx) && dyx > 0) pt.dyx = dyx;
    if (isFinite(hx) && hx > 0 && hx < 100) pt.hx = hx;
    points.push(pt);
  }
  return points;
}

export function generateCollateralDebtPointsY(p: Params, n = 300): MultiPoint[] {
  const { px, py, cy, ry, xr, yr, xd, yd, vxy: lXY } = p;
  const x0 = computeX0(p);
  const y0 = computeY0(p);
  const yb = computeYb(y0, ry, cy);
  const kY = computeKy(xd, px, py);
  const yc = computeYc(y0, cy, kY);

  const points: MultiPoint[] = [];
  const yMax = y0 - yb;
  if (yMax <= 0) return points;

  for (let i = 0; i <= n; i++) {
    const yShifted = yMax * (i / n);
    const yVirtual = yShifted + yb;
    if (yVirtual <= 0 || yVirtual > y0) continue;

    const cyy = CYY(yVirtual, y0, yr);
    const cxy = CXY(yVirtual, cy, y0, x0, px, py, xr, xd);
    const dyy = DYY(yVirtual, y0, yr, yd, yc);
    const dxy = DXY(yVirtual, cy, y0, x0, px, py, xd);
    const hy = HY(yVirtual, cy, y0, x0, px, py, xr, yr, xd, yd, lXY, yc);

    const pt: MultiPoint = { x: yShifted };
    if (isFinite(cyy)) pt.cyy = cyy;
    if (isFinite(cxy)) pt.cxy = cxy;
    if (isFinite(dyy) && dyy > 0) pt.dyy = dyy;
    if (isFinite(dxy) && dxy > 0) pt.dxy = dxy;
    if (isFinite(hy) && hy > 0 && hy < 100) pt.hy = hy;
    points.push(pt);
  }
  return points;
}

// --- Backward compat aliases for existing component imports ---
export const f1 = (x: number, x0: number, y0: number, px: number, py: number, cx: number) =>
  fX(x, cx, x0, y0, px, py);
export const g1 = (y: number, x0: number, y0: number, px: number, py: number, cy: number) =>
  gY(y, cy, y0, x0, px, py);
export const f1d = (x: number, x0: number, px: number, py: number, cx: number) =>
  fXd(x, cx, x0, px, py);
export const g1d = (y: number, y0: number, px: number, py: number, cy: number) =>
  gYd(y, cy, y0, px, py);
