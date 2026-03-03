import { Params, defaultParams, computeSx, computeBxc } from "./math";
import { getToken } from "./tokens";
import { priceToRx, priceToRy } from "./presets";

export interface CreateFormState {
  // Pair & deposits
  tokenX: string;
  tokenY: string;
  tokenZ: string;
  depositX: number;
  depositY: number;
  depositZ: number;      // non-traded Z collateral

  // Strategy
  preset: "conservative" | "moderate" | "aggressive" | "custom";
  equilibriumPrice: number; // Y per X — overridable, defaults to oracle px/py
  priceMin: number;         // Y per X (dollar terms)
  priceMax: number;         // Y per X (dollar terms)
  concentration: number;    // 0–0.99 (cx, or both when symmetric)
  asymmetric: boolean;      // when true, cx and cy are independent
  concentrationY: number;   // cy when asymmetric

  // Leverage
  leverageEnabled: boolean;
  debtAsset: "x" | "y" | "z";
  debtAmount: number;

  // Existing vault positions
  vaultDepositX: number;
  vaultDepositY: number;
  vaultDepositZ: number;
  vaultDebtX: number;
  vaultDebtY: number;
  vaultDebtZ: number;
}

export const defaultFormState: CreateFormState = {
  tokenX: "ETH",
  tokenY: "USDC",
  tokenZ: "DAI",
  depositX: 10,
  depositY: 20000,
  depositZ: 0,
  preset: "moderate",
  equilibriumPrice: 2000,
  priceMin: 1333.33,
  priceMax: 3000,
  concentration: 0.5,
  asymmetric: false,
  concentrationY: 0.5,
  leverageEnabled: false,
  debtAsset: "y",
  debtAmount: 0,
  vaultDepositX: 0,
  vaultDepositY: 0,
  vaultDepositZ: 0,
  vaultDebtX: 0,
  vaultDebtY: 0,
  vaultDebtZ: 0,
};

/** Build a full Params object from the friendly form state. */
export function buildParams(form: CreateFormState): Params {
  const tX = getToken(form.tokenX);
  const tY = getToken(form.tokenY);
  const tZ = getToken(form.tokenZ);

  // Equilibrium price (Y per X) — user-overridable, defaults to oracle ratio
  const eqPrice = form.equilibriumPrice > 0 ? form.equilibriumPrice : tX.price / tY.price;

  // px/py in the math IS the equilibrium price ratio.
  // We normalise to px = eqPrice, py = 1 so that px/py = eqPrice.
  const px = eqPrice;
  const py = 1;

  // pxz: price of Z in X units = pZ_usd / pX_usd
  const pxUsd = tX.price > 0 ? tX.price : 1;
  const pxz = tZ.price > 0 ? tZ.price / pxUsd : 1;
  const pzx = pxz > 0 ? 1 / pxz : 1;

  // Range: convert dollar prices to rx, ry using the equilibrium price
  const rx = Math.max(0.01, priceToRx(form.priceMin, eqPrice));
  const ry = Math.max(0.01, priceToRy(form.priceMax, eqPrice));

  // Concentration (symmetric or asymmetric)
  const cx = Math.min(0.99, Math.max(0, form.concentration));
  const cy = form.asymmetric
    ? Math.min(0.99, Math.max(0, form.concentrationY))
    : cx;

  // Deposits
  const xr = Math.max(0, form.depositX);
  const yr = Math.max(0, form.depositY);
  const zr = Math.max(0, form.depositZ);

  // Debt
  const xd = form.leverageEnabled && form.debtAsset === "x" ? form.debtAmount : 0;
  const yd = form.leverageEnabled && form.debtAsset === "y" ? form.debtAmount : 0;
  const zdebt = form.leverageEnabled && form.debtAsset === "z" ? form.debtAmount : 0;

  // LLTV defaults from protocol
  const { vyx, vxy, vxz, vyz, vzx, vzy } = defaultParams;

  // External collateral from existing vault positions (risk-adjusted)
  const rXX = form.vaultDepositX * vyx + form.vaultDepositZ * vzx;
  const rXY = form.vaultDepositY * vxy + form.vaultDepositZ * vzy;
  const rXZ = 0;
  const rYX = form.vaultDepositX * vxy + form.vaultDepositZ * vzx;
  const rYY = form.vaultDepositY * vyx + form.vaultDepositZ * vzy;
  const rYZ = 0;

  // Exogenous collateral/debt for NAV (convert to X units and Y units, including Z)
  const pxy = eqPrice;
  const eXC = form.vaultDepositX + form.vaultDepositY / pxy + form.vaultDepositZ * pzx;
  const eXD = form.vaultDebtX + form.vaultDebtY / pxy + form.vaultDebtZ * pzx;
  const eYC = form.vaultDepositY + form.vaultDepositX * pxy + form.vaultDepositZ * pzx * pxy;
  const eYD = form.vaultDebtY + form.vaultDebtX * pxy + form.vaultDebtZ * pzx * pxy;

  return {
    vyx, vxy, vxz, vyz, vzx, vzy,
    px, py, pxz,
    rx, ry, cx, cy,
    xr, yr, zr,
    xd, yd, zdebt,
    rXX, rXY, rXZ,
    rYX, rYY, rYZ,
    eXC, eXD, eYC, eYD,
  };
}

/** Capital efficiency multiplier for display. */
export function efficiencyLabel(cx: number, rx: number): string {
  const sx = computeSx(rx, cx);
  if (!isFinite(sx) || sx <= 1) return "—";
  const bxc = computeBxc(sx);
  if (!isFinite(bxc)) return "—";
  return `${bxc.toFixed(1)}×`;
}

/** Format a dollar value for display. */
export function fmtUsd(v: number): string {
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

/** Format a token amount. */
export function fmtAmount(v: number): string {
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toFixed(4);
  return v.toFixed(6);
}
