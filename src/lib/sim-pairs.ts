/**
 * Asset pair presets for the unified simulation framework.
 *
 * Each preset provides realistic defaults for a specific trading pair:
 * price, volatility, retail flow, and reference venue fee tier.
 * The simulation engine works in human-readable units internally;
 * decimal handling only matters for priceX/priceY computation on-chain.
 */

export interface AssetPair {
  name: string;              // e.g. "WETH/USDC"
  asset0: string;            // quote asset (X in curve math)
  asset1: string;            // base asset (Y in curve math)
  dec0: number;              // decimals of asset0
  dec1: number;              // decimals of asset1
  price: number;             // asset1 in asset0 units, human-readable (e.g. 1986 USDC per WETH)
  vol: number;               // annualized volatility
  typicalRetail: {
    arrivalRate: number;     // orders per hour
    meanSize: number;        // mean order size in USD
  };
  uniswapFeeTier: number;   // reference venue fee (fraction, e.g. 0.0005 = 5 bps)
}

/** Compute on-chain priceX/priceY from human price and decimals.
 *  priceX/priceY = humanPrice × 10^(dec1 - dec0) */
export function computeOnChainPriceRatio(pair: AssetPair): { px: number; py: number } {
  // In the simulation, px and py are the curve's price scalars.
  // Convention: px=1, py=humanPrice (Y per X, where X is asset0, Y is asset1).
  // The sim works in human units, so px=1, py=price.
  return { px: 1, py: pair.price };
}

export const PAIRS: Record<string, AssetPair> = {
  "WETH/USDC": {
    name: "WETH/USDC",
    asset0: "USDC",
    asset1: "WETH",
    dec0: 6,
    dec1: 18,
    price: 1986,
    vol: 0.60,
    typicalRetail: { arrivalRate: 3, meanSize: 5000 },
    uniswapFeeTier: 0.0005,
  },

  "WBTC/WETH": {
    name: "WBTC/WETH",
    asset0: "WETH",
    asset1: "WBTC",
    dec0: 18,
    dec1: 8,
    price: 30,           // 1 BTC ≈ 30 ETH
    vol: 0.25,           // correlated pair, lower vol
    typicalRetail: { arrivalRate: 1, meanSize: 8000 },
    uniswapFeeTier: 0.003,
  },

  "USDC/USDT": {
    name: "USDC/USDT",
    asset0: "USDC",
    asset1: "USDT",
    dec0: 6,
    dec1: 6,
    price: 1.0,
    vol: 0.005,          // stablecoin pair, near-zero vol
    typicalRetail: { arrivalRate: 10, meanSize: 20000 },
    uniswapFeeTier: 0.0001,
  },

  "wstETH/WETH": {
    name: "wstETH/WETH",
    asset0: "WETH",
    asset1: "wstETH",
    dec0: 18,
    dec1: 18,
    price: 1.15,         // wstETH/ETH exchange rate
    vol: 0.02,           // LST pair, very low vol
    typicalRetail: { arrivalRate: 2, meanSize: 10000 },
    uniswapFeeTier: 0.0001,
  },
};
