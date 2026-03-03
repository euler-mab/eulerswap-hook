import { describe, it, expect } from "vitest";
import { PRESETS, rxToPrice, ryToPrice, priceToRx, priceToRy } from "./presets";

describe("presets data", () => {
  it("all three presets exist", () => {
    expect(Object.keys(PRESETS)).toEqual(["conservative", "moderate", "aggressive"]);
  });

  it("concentration increases from conservative to aggressive", () => {
    expect(PRESETS.conservative.concentration).toBeLessThan(PRESETS.moderate.concentration);
    expect(PRESETS.moderate.concentration).toBeLessThan(PRESETS.aggressive.concentration);
  });

  it("range (rx) decreases from conservative to aggressive", () => {
    expect(PRESETS.conservative.rx).toBeGreaterThan(PRESETS.moderate.rx);
    expect(PRESETS.moderate.rx).toBeGreaterThan(PRESETS.aggressive.rx);
  });
});

describe("rxToPrice / priceToRx round-trip", () => {
  it("rxToPrice: lower bound = currentPrice / (1+rx)", () => {
    // rx=1, price=2000 → lower bound = 2000/2 = 1000
    expect(rxToPrice(1, 2000)).toBe(1000);
    // rx=0.5 → 2000/1.5 = 1333.33…
    expect(rxToPrice(0.5, 2000)).toBeCloseTo(1333.333, 2);
  });

  it("ryToPrice: upper bound = currentPrice * (1+ry)", () => {
    expect(ryToPrice(1, 2000)).toBe(4000);
    expect(ryToPrice(0.5, 2000)).toBe(3000);
  });

  it("priceToRx inverts rxToPrice", () => {
    for (const rx of [0.1, 0.5, 1, 2]) {
      const price = rxToPrice(rx, 2000);
      expect(priceToRx(price, 2000)).toBeCloseTo(rx, 10);
    }
  });

  it("priceToRy inverts ryToPrice", () => {
    for (const ry of [0.1, 0.5, 1, 2]) {
      const price = ryToPrice(ry, 2000);
      expect(priceToRy(price, 2000)).toBeCloseTo(ry, 10);
    }
  });

  it("priceToRx returns 2 for non-positive price", () => {
    expect(priceToRx(0, 2000)).toBe(2);
    expect(priceToRx(-100, 2000)).toBe(2);
  });

  it("priceToRy returns 2 for non-positive currentPrice", () => {
    expect(priceToRy(3000, 0)).toBe(2);
    expect(priceToRy(3000, -1)).toBe(2);
  });
});
