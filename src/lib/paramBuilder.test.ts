import { describe, it, expect } from "vitest";
import { buildParams, defaultFormState, efficiencyLabel, fmtUsd, fmtAmount } from "./paramBuilder";
import { validateParams, defaultParams } from "./math";

describe("buildParams — default form state", () => {
  const p = buildParams(defaultFormState);

  it("produces valid Params (no validation errors)", () => {
    expect(validateParams(p)).toEqual([]);
  });

  it("px = equilibrium price, py = 1", () => {
    expect(p.px).toBe(2000);
    expect(p.py).toBe(1);
  });

  it("deposits map directly", () => {
    expect(p.xr).toBe(10);
    expect(p.yr).toBe(20000);
  });

  it("no debt when leverage disabled", () => {
    expect(p.xd).toBe(0);
    expect(p.yd).toBe(0);
    expect(p.zdebt).toBe(0);
  });

  it("LLTV values come from defaultParams", () => {
    expect(p.vyx).toBe(defaultParams.vyx);
    expect(p.vxy).toBe(defaultParams.vxy);
  });

  it("no external collateral/debt with zero vault positions", () => {
    expect(p.eXC).toBe(0);
    expect(p.eXD).toBe(0);
    expect(p.rXX).toBe(0);
    expect(p.rXY).toBe(0);
  });
});

describe("buildParams — symmetric vs asymmetric concentration", () => {
  it("symmetric: cx = cy = concentration", () => {
    const p = buildParams({ ...defaultFormState, concentration: 0.7 });
    expect(p.cx).toBe(0.7);
    expect(p.cy).toBe(0.7);
  });

  it("asymmetric: cx = concentration, cy = concentrationY", () => {
    const p = buildParams({
      ...defaultFormState,
      asymmetric: true,
      concentration: 0.3,
      concentrationY: 0.9,
    });
    expect(p.cx).toBe(0.3);
    expect(p.cy).toBe(0.9);
  });

  it("clamps concentration to [0, 0.99]", () => {
    const p = buildParams({ ...defaultFormState, concentration: 1.5 });
    expect(p.cx).toBe(0.99);
    const p2 = buildParams({ ...defaultFormState, concentration: -0.5 });
    expect(p2.cx).toBe(0);
  });
});

describe("buildParams — leverage / debt routing", () => {
  it("Y debt when debtAsset=y and leverage enabled", () => {
    const p = buildParams({
      ...defaultFormState,
      leverageEnabled: true,
      debtAsset: "y",
      debtAmount: 5000,
    });
    expect(p.yd).toBe(5000);
    expect(p.xd).toBe(0);
    expect(p.zdebt).toBe(0);
  });

  it("X debt when debtAsset=x", () => {
    const p = buildParams({
      ...defaultFormState,
      leverageEnabled: true,
      debtAsset: "x",
      debtAmount: 3,
    });
    expect(p.xd).toBe(3);
    expect(p.yd).toBe(0);
  });

  it("Z debt when debtAsset=z", () => {
    const p = buildParams({
      ...defaultFormState,
      leverageEnabled: true,
      debtAsset: "z",
      debtAmount: 1000,
    });
    expect(p.zdebt).toBe(1000);
    expect(p.xd).toBe(0);
    expect(p.yd).toBe(0);
  });

  it("no debt when leverage disabled even with amount set", () => {
    const p = buildParams({
      ...defaultFormState,
      leverageEnabled: false,
      debtAsset: "y",
      debtAmount: 5000,
    });
    expect(p.yd).toBe(0);
  });
});

describe("buildParams — price range conversion", () => {
  it("priceMin/priceMax convert to rx/ry correctly", () => {
    // default: equilibriumPrice=2000, priceMin=1333.33, priceMax=3000
    // rx = 2000/1333.33 - 1 ≈ 0.5
    // ry = 3000/2000 - 1 = 0.5
    const p = buildParams(defaultFormState);
    expect(p.rx).toBeCloseTo(0.5, 2);
    expect(p.ry).toBeCloseTo(0.5, 2);
  });

  it("rx is clamped to minimum 0.01", () => {
    // priceMin very close to equilibrium → tiny rx → clamped
    const p = buildParams({ ...defaultFormState, priceMin: 1999 });
    // rx = 2000/1999 - 1 ≈ 0.0005 → clamped to 0.01
    expect(p.rx).toBe(0.01);
  });
});

describe("buildParams — vault positions (external collateral)", () => {
  it("vault deposits produce non-zero rXX/rXY and eXC", () => {
    const p = buildParams({
      ...defaultFormState,
      vaultDepositY: 10000,
    });
    expect(p.rXY).toBeGreaterThan(0);
    expect(p.eXC).toBeGreaterThan(0);
  });

  it("vault debts produce non-zero eXD", () => {
    const p = buildParams({
      ...defaultFormState,
      vaultDebtY: 5000,
    });
    expect(p.eXD).toBeGreaterThan(0);
  });
});

describe("buildParams — pxz (Z token pricing)", () => {
  it("pxz = pZ_usd / pX_usd", () => {
    // DAI=$1, ETH=$2000 → pxz = 1/2000 = 0.0005
    const p = buildParams(defaultFormState);
    expect(p.pxz).toBeCloseTo(1 / 2000, 6);
  });
});

describe("efficiencyLabel", () => {
  it("returns multiplier string for valid inputs", () => {
    expect(efficiencyLabel(0.5, 0.5)).toMatch(/^\d+\.\d×$/);
  });

  it("returns — for degenerate sx", () => {
    // cx=0, rx=0 → sx = sqrt(1/1) = 1 → bxc = Infinity
    expect(efficiencyLabel(0, 0)).toBe("—");
  });
});

describe("fmtUsd", () => {
  it("formats large values without decimals", () => {
    expect(fmtUsd(12345)).toMatch(/12,345/);
  });

  it("formats small values with decimals", () => {
    expect(fmtUsd(1.5)).toBe("$1.50");
  });

  it("formats tiny values with 4 decimals", () => {
    expect(fmtUsd(0.1234)).toBe("$0.1234");
  });

  it("returns — for non-finite", () => {
    expect(fmtUsd(Infinity)).toBe("—");
    expect(fmtUsd(NaN)).toBe("—");
  });
});

describe("fmtAmount", () => {
  it("formats large values with 2 decimals", () => {
    expect(fmtAmount(12345.678)).toMatch(/12,345\.68/);
  });

  it("formats medium values with 4 decimals", () => {
    expect(fmtAmount(5.123456)).toBe("5.1235");
  });

  it("formats tiny values with 6 decimals", () => {
    expect(fmtAmount(0.001234)).toBe("0.001234");
  });

  it("returns — for non-finite", () => {
    expect(fmtAmount(NaN)).toBe("—");
  });
});
