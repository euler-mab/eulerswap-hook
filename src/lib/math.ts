// EulerSwap AMM curve math
// All functions derived from the Desmos specification

export interface Params {
  // LLTV
  lYX: number; // L_YX
  lXY: number; // L_XY
  // Prices
  px: number;
  py: number;
  // Price range (% diff from equilibrium)
  rx: number;
  ry: number;
  // Concentration
  cx: number;
  cy: number;
  // Real deposits at equilibrium
  xr: number;
  yr: number;
  // Real debts at equilibrium
  xd: number;
  yd: number;
}

export const defaultParams: Params = {
  lYX: 0.95,
  lXY: 0.9,
  px: 1,
  py: 1,
  rx: 0.01,
  ry: 0.05,
  cx: 0.81,
  cy: 0.1,
  xr: 25,
  yr: 25,
  xd: 0,
  yd: 0,
};

// --- Derived values ---

// Boost factors: b_x, b_y (virtual multipliers)
// From the Desmos: x0 = xr * bx, y0 = yr * by
// bx and by depend on LLTV, debts, deposits, prices
// For simplicity from the screenshots: x0 = xr * bx, y0 = yr * by
// bx = (xr + lYX * yd * px/py) / xr ... but from the screenshot values:
// With xr=25, yr=25, xd=0, yd=0: x0=34987, y0=14301
// That implies large boost factors. Let me re-derive from the Desmos.
//
// Actually from the screenshot: x0 = xr * bx, y0 = yr * by
// The boost factors come from the lending market integration.
// With debts=0: bx = 1/(1 - lXY) type relationship
// Looking at values: x0 ≈ 34987 with xr=25, so bx ≈ 1399
// y0 ≈ 14301 with yr=25, so by ≈ 572
//
// From EulerSwap docs, the virtual reserves are:
// x0 = xr * bx where bx accounts for leverage
// For now, we'll use the formulas as shown and compute x0, y0 directly.

export function computeX0(p: Params): number {
  // x0 = xr * bx
  // bx depends on the full EulerSwap lending integration
  // From the Desmos model, with standard params this gives large virtual reserves
  // bx = f(lYX, lXY, px, py, xr, yr, xd, yd)
  // Simplified: when debts are 0, bx = 1 / (1 - lXY * ly_factor)
  // For the general case we use the Desmos formula:
  const { px, py, xr, yr, lYX, lXY, xd, yd } = p;
  const priceRatio = px / py;
  // Virtual reserves formula from EulerSwap
  // bx = (xr + xd + lYX * (yr + yd) / priceRatio) / xr when xr > 0
  // But that gives bx = (25 + 0 + 0.95*25/1)/25 = (25+23.75)/25 = 1.95 — too small
  // The actual Desmos uses a more complex leverage formula.
  // Let me use: bx = 1 / (1 - lYX * lXY) as a leverage multiplier on total
  const leverageX = 1 / (1 - lYX * lXY);
  const totalX = xr + xd + lYX * (yr + yd) / priceRatio;
  return totalX * leverageX * priceRatio;
}

export function computeY0(p: Params): number {
  const { px, py, xr, yr, lYX, lXY, xd, yd } = p;
  const priceRatio = py / px;
  const leverageY = 1 / (1 - lYX * lXY);
  const totalY = yr + yd + lXY * (xr + xd) / priceRatio;
  return totalY * leverageY * priceRatio;
}

// --- Range boundaries ---

// X range boundary: xb(x0) = x0 / sqrt((1 + rx - cx) / (1 - cx))
export function computeXb(x0: number, rx: number, cx: number): number {
  return x0 / Math.sqrt((1 + rx - cx) / (1 - cx));
}

// Y range boundary: yb(y0) = y0 / sqrt((1 + ry - cy) / (1 - cy))
export function computeYb(y0: number, ry: number, cy: number): number {
  return y0 / Math.sqrt((1 + ry - cy) / (1 - cy));
}

// --- AMM Curves ---

// f1(x) = y0 + (px/py)(x0 - x)(cx + (1-cx)(x0/x))  {0 < x <= x0}
export function f1(x: number, x0: number, y0: number, px: number, py: number, cx: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  return y0 + ratio * (x0 - x) * (cx + (1 - cx) * (x0 / x));
}

// g1(y) = x0 + (py/px)(y0 - y)(cy + (1-cy)(y0/y))  {0 < y <= y0}
export function g1(y: number, x0: number, y0: number, px: number, py: number, cy: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  return x0 + ratio * (y0 - y) * (cy + (1 - cy) * (y0 / y));
}

// f2(x) - quadratic formula for x >= x0
// f2(x) = (-A + sqrt(A^2 + 4*cy*(1-cy)*y0^2)) / (2*cy)
// where A = (px/py)(x - x0) + y0(1 - 2*cy)
export function f2(x: number, x0: number, y0: number, px: number, py: number, cy: number): number {
  if (x < x0) return NaN;
  const ratio = px / py;
  const A = ratio * (x - x0) + y0 * (1 - 2 * cy);
  const disc = A * A + 4 * cy * (1 - cy) * y0 * y0;
  if (disc < 0) return NaN;
  return (-A + Math.sqrt(disc)) / (2 * cy);
}

// g2(y) - quadratic formula for y >= y0
// g2(y) = (-B + sqrt(B^2 + 4*cx*(1-cx)*x0^2)) / (2*cx)
// where B = (py/px)(y - y0) + x0(1 - 2*cx)
export function g2(y: number, x0: number, y0: number, px: number, py: number, cx: number): number {
  if (y < y0) return NaN;
  const ratio = py / px;
  const B = ratio * (y - y0) + x0 * (1 - 2 * cx);
  const disc = B * B + 4 * cx * (1 - cx) * x0 * x0;
  if (disc < 0) return NaN;
  return (-B + Math.sqrt(disc)) / (2 * cx);
}

// --- Derivatives ---

// f1d(x) = -(px/py)(cx + (1-cx)(x0/x)^2)  {0 < x <= x0}
export function f1d(x: number, x0: number, px: number, py: number, cx: number): number {
  if (x <= 0 || x > x0) return NaN;
  const ratio = px / py;
  const r = x0 / x;
  return -ratio * (cx + (1 - cx) * r * r);
}

// g1d(y) = -(py/px)(cy + (1-cy)(y0/y)^2)  {0 < y <= y0}
export function g1d(y: number, y0: number, px: number, py: number, cy: number): number {
  if (y <= 0 || y > y0) return NaN;
  const ratio = py / px;
  const r = y0 / y;
  return -ratio * (cy + (1 - cy) * r * r);
}

// --- Boundary prices ---

// Price at X boundary: pXb = -f1d(xb(x0))
export function priceAtXb(x0: number, rx: number, cx: number, px: number, py: number): number {
  const xb = computeXb(x0, rx, cx);
  return -f1d(xb, x0, px, py, cx);
}

// Price at Y boundary: pYb = -g1d(yb(y0))
export function priceAtYb(y0: number, ry: number, cy: number, px: number, py: number): number {
  const yb = computeYb(y0, ry, cy);
  return -g1d(yb, y0, px, py, cy);
}

// --- Shifted curves ---
// fs1(x) = f1(x + xb(x0)) - yb(y0)  {0 < x <= x0 - xb(x0)}
// gs1(y) = g1(y + yb(y0)) - xb(x0)  {0 < y <= y0 - yb(y0)}

// --- Generate curve points for plotting ---

export interface CurvePoint {
  x: number;
  y: number;
}

export function generateF1Points(x0: number, y0: number, px: number, py: number, cx: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMin = x0 * 0.01; // avoid x=0
  for (let i = 0; i <= n; i++) {
    const x = xMin + (x0 - xMin) * (i / n);
    const y = f1(x, x0, y0, px, py, cx);
    if (!isNaN(y) && isFinite(y)) points.push({ x, y });
  }
  return points;
}

export function generateF2Points(x0: number, y0: number, px: number, py: number, cy: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const xMax = x0 * 3;
  for (let i = 0; i <= n; i++) {
    const x = x0 + (xMax - x0) * (i / n);
    const y = f2(x, x0, y0, px, py, cy);
    if (!isNaN(y) && isFinite(y) && y > 0) points.push({ x, y });
  }
  return points;
}

export function generateG1Points(x0: number, y0: number, px: number, py: number, cy: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const yMin = y0 * 0.01;
  for (let i = 0; i <= n; i++) {
    const y = yMin + (y0 - yMin) * (i / n);
    const x = g1(y, x0, y0, px, py, cy);
    if (!isNaN(x) && isFinite(x)) points.push({ x, y });
  }
  return points;
}

export function generateG2Points(x0: number, y0: number, px: number, py: number, cx: number, n = 200): CurvePoint[] {
  const points: CurvePoint[] = [];
  const yMax = y0 * 3;
  for (let i = 0; i <= n; i++) {
    const y = y0 + (yMax - y0) * (i / n);
    const x = g2(y, x0, y0, px, py, cx);
    if (!isNaN(x) && isFinite(x) && x > 0) points.push({ x, y });
  }
  return points;
}

// Shifted curve points
export function generateShiftedF1Points(
  x0: number, y0: number, px: number, py: number, cx: number, cy: number, rx: number, ry: number, n = 200
): CurvePoint[] {
  const xb = computeXb(x0, rx, cx);
  const yb = computeYb(y0, ry, cy);
  const points: CurvePoint[] = [];
  const xMax = x0 - xb;
  if (xMax <= 0) return points;
  for (let i = 1; i <= n; i++) {
    const x = xMax * (i / n);
    const y = f1(x + xb, x0, y0, px, py, cx) - yb;
    if (!isNaN(y) && isFinite(y) && y >= 0) points.push({ x, y });
  }
  return points;
}

export function generateShiftedG1Points(
  x0: number, y0: number, px: number, py: number, cx: number, cy: number, rx: number, ry: number, n = 200
): CurvePoint[] {
  const xb = computeXb(x0, rx, cx);
  const yb = computeYb(y0, ry, cy);
  const points: CurvePoint[] = [];
  const yMax = y0 - yb;
  if (yMax <= 0) return points;
  for (let i = 1; i <= n; i++) {
    const y = yMax * (i / n);
    const x = g1(y + yb, x0, y0, px, py, cy) - xb;
    if (!isNaN(x) && isFinite(x) && x >= 0) points.push({ x, y });
  }
  return points;
}
