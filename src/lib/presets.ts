export interface StrategyPreset {
  name: string;
  label: string;
  description: string;
  rx: number;
  ry: number;
  concentration: number;
}

export const PRESETS: Record<string, StrategyPreset> = {
  conservative: {
    name: "conservative",
    label: "Conservative",
    description: "Wide range, low concentration — set and forget",
    rx: 1.0,
    ry: 1.0,
    concentration: 0.2,
  },
  moderate: {
    name: "moderate",
    label: "Moderate",
    description: "Balanced range and concentration",
    rx: 0.5,
    ry: 0.5,
    concentration: 0.5,
  },
  aggressive: {
    name: "aggressive",
    label: "Aggressive",
    description: "Tight range, high concentration — needs monitoring",
    rx: 0.15,
    ry: 0.15,
    concentration: 0.8,
  },
};

/** Convert rx to lower bound price (Y per X). */
export function rxToPrice(rx: number, currentPrice: number): number {
  return currentPrice / (1 + rx);
}

/** Convert ry to upper bound price (Y per X). */
export function ryToPrice(ry: number, currentPrice: number): number {
  return currentPrice * (1 + ry);
}

/** Inverse: price → rx. */
export function priceToRx(priceLower: number, currentPrice: number): number {
  if (priceLower <= 0) return 2;
  return currentPrice / priceLower - 1;
}

/** Inverse: price → ry. */
export function priceToRy(priceUpper: number, currentPrice: number): number {
  if (currentPrice <= 0) return 2;
  return priceUpper / currentPrice - 1;
}
