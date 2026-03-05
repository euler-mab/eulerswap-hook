import type { PublicClient, Address } from "viem";

export interface AggregatorQuote {
  midPrice: number; // asset1 per asset0 (human-readable, e.g. 3000 for WETH/USDC)
  bidPrice: number; // price when selling asset0
  askPrice: number; // price when buying asset0
  spread: number; // (ask - bid) / mid * 10000 (in bps)
  timestamp: number;
}

// CowSwap Orderbook API — aggregates across DEXes for best execution price
const COWSWAP_API = "https://api.cow.fi/mainnet/api/v1";
const QUOTE_TIMEOUT_MS = 10_000;
// Quote size in human units. Must be large enough for CowSwap fixed fees to be
// negligible (at $1 the fee is ~61%, at $10K it's <0.01%).
const QUOTE_UNITS = 10_000;

const erc20Abi = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const decimalsCache = new Map<string, number>();

async function getDecimals(client: PublicClient, token: Address): Promise<number> {
  const cached = decimalsCache.get(token);
  if (cached !== undefined) return cached;

  const dec = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });

  const n = Number(dec);
  decimalsCache.set(token, n);
  return n;
}

interface CowQuoteResult {
  sellAmount: string;
  buyAmount: string;
}

async function cowQuote(body: Record<string, unknown>): Promise<CowQuoteResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);

    const res = await fetch(`${COWSWAP_API}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = (await res.json()) as { quote: CowQuoteResult };
    return data.quote;
  } catch {
    return null; // API down, timeout, or network error
  }
}

export async function getAggregatorQuote(
  client: PublicClient,
  asset0: Address,
  asset1: Address,
): Promise<AggregatorQuote | null> {
  const [dec0, dec1] = await Promise.all([
    getDecimals(client, asset0),
    getDecimals(client, asset1),
  ]);

  const quoteRaw = (BigInt(QUOTE_UNITS) * 10n ** BigInt(dec0)).toString();
  const validTo = Math.floor(Date.now() / 1000) + 600;
  const from = "0x0000000000000000000000000000000000000001";

  // Bid: sell QUOTE_UNITS asset0 → how much asset1 do we receive?
  // Ask: buy QUOTE_UNITS asset0 → how much asset1 do we spend?
  const [bidQuote, askQuote] = await Promise.all([
    cowQuote({
      sellToken: asset0,
      buyToken: asset1,
      sellAmountBeforeFee: quoteRaw,
      kind: "sell",
      from,
      validTo,
      priceQuality: "fast",
    }),
    cowQuote({
      sellToken: asset1,
      buyToken: asset0,
      buyAmountAfterFee: quoteRaw,
      kind: "buy",
      from,
      validTo,
      priceQuality: "fast",
    }),
  ]);

  if (!bidQuote || !askQuote) return null;

  const bidBuyAmount = Number(bidQuote.buyAmount);
  const askSellAmount = Number(askQuote.sellAmount);

  if (bidBuyAmount <= 0 || askSellAmount <= 0) return null;

  // bidPrice: sold QUOTE_UNITS asset0, got bidBuyAmount smallest-units of asset1
  // per-unit price = bidBuyAmount / (10^dec1 * QUOTE_UNITS)
  const bidPrice = bidBuyAmount / (10 ** dec1 * QUOTE_UNITS);

  // askPrice: to buy QUOTE_UNITS asset0, must pay askSellAmount smallest-units of asset1
  const askPrice = askSellAmount / (10 ** dec1 * QUOTE_UNITS);

  const midPrice = (bidPrice + askPrice) / 2;
  const spread = midPrice > 0 ? ((askPrice - bidPrice) / midPrice) * 10000 : 0;

  return {
    midPrice,
    bidPrice,
    askPrice,
    spread: Math.max(0, spread),
    timestamp: Math.floor(Date.now() / 1000),
  };
}
