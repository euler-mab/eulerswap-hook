/** Token metadata for presets. Prices are approximate USD values for default configuration. */
export interface Token {
  symbol: string;
  name: string;
  price: number;   // approximate USD price (used for preset px/py values)
  color: string;   // brand color for UI
}

export const TOKENS: Token[] = [
  { symbol: "ETH",  name: "Ethereum",    price: 2000,  color: "#627eea" },
  { symbol: "USDC", name: "USD Coin",    price: 1,     color: "#2775ca" },
  { symbol: "WBTC", name: "Wrapped BTC", price: 60000, color: "#f7931a" },
  { symbol: "DAI",  name: "Dai",         price: 1,     color: "#f5ac37" },
  { symbol: "USDT", name: "Tether",      price: 1,     color: "#26a17b" },
];

/** Look up a token by symbol. Falls back to the first token (ETH) if not found. */
export function getToken(symbol: string): Token {
  return TOKENS.find((t) => t.symbol === symbol) ?? TOKENS[0];
}
