import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  PoolSnapshot,
  HookFeeParams,
  HookStats,
  ExecutedAction,
  ClaudeReview,
  ClaudeRecommendation,
  AssetDecimals,
} from "./types.js";
import type { AggregatorQuote } from "./oracle.js";
import { WAD, BPS, fmtToken } from "./types.js";

let client: Anthropic | null = null;

function getClient(config: AgentConfig): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

export async function review(
  config: AgentConfig,
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  stats: HookStats,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null = null,
  decimals?: AssetDecimals
): Promise<ClaudeReview> {
  const anthropic = getClient(config);

  const context = buildContext(snapshot, feeParams, stats, recentActions, gasSpentToday, aggQuote, decimals);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are an autonomous LP agent managing an EulerSwap pool. Review the current state and suggest parameter adjustments.

## Current Pool State
${context}

## Your Task
Analyze the current state and provide recommendations as JSON. Consider:
1. Is the current baseFee appropriate given the mismatch and volume?
2. Should concentration be adjusted based on recent volatility?
3. Does the equilibrium need recentering?
4. Any strategy observations for the journal?

Respond with ONLY valid JSON in this format:
{
  "recommendations": [
    {
      "type": "setFeeParams" | "reconfigure",
      "params": { "baseFee": "2500000000000", ... },
      "reasoning": "...",
      "confidence": 0.0-1.0
    }
  ],
  "marketAnalysis": "Brief analysis of current conditions",
  "strategyNotes": "Notes for the journal about strategy performance"
}

If no changes are needed, return empty recommendations array.
All numeric params must be strings representing WAD-scaled values (1e18 = 100%).
1 basis point = ${BPS.toString()}.`,
      },
    ],
  });

  // Parse response
  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return emptyReview("Failed to parse Claude response — no JSON found");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      recommendations?: ClaudeRecommendation[];
      marketAnalysis?: string;
      strategyNotes?: string;
    };

    return {
      timestamp: Math.floor(Date.now() / 1000),
      recommendations: parsed.recommendations ?? [],
      marketAnalysis: parsed.marketAnalysis ?? "",
      strategyNotes: parsed.strategyNotes ?? "",
    };
  } catch {
    return emptyReview(`Failed to parse Claude response: ${text.slice(0, 200)}`);
  }
}

function buildContext(
  snapshot: PoolSnapshot,
  feeParams: HookFeeParams,
  stats: HookStats,
  recentActions: ExecutedAction[],
  gasSpentToday: bigint,
  aggQuote: AggregatorQuote | null,
  decimals?: AssetDecimals
): string {
  const fmtR0 = (v: bigint) => decimals ? fmtToken(v, decimals.dec0) : (Number(v) / 1e18).toFixed(6);
  const fmtR1 = (v: bigint) => decimals ? fmtToken(v, decimals.dec1) : (Number(v) / 1e18).toFixed(6);
  const fmtWad = (v: bigint) => (Number(v) / 1e18).toFixed(6);
  const fmtBps = (v: bigint) => (Number(v) / Number(BPS)).toFixed(1) + " bps";
  const fmtEth = (v: bigint) => (Number(v) / 1e18).toFixed(6) + " ETH";

  return `
Reserves: ${fmtR0(snapshot.reserve0)} / ${fmtR1(snapshot.reserve1)}
Equilibrium: ${fmtR0(snapshot.equilibriumReserve0)} / ${fmtR1(snapshot.equilibriumReserve1)}
Oracle price: ${fmtWad(snapshot.oraclePrice)} (asset1 per asset0)
Marginal price: ${fmtWad(snapshot.marginalPrice)}
Mismatch: ${fmtBps(snapshot.mismatch)}
Concentration: X=${fmtWad(snapshot.concentrationX)}, Y=${fmtWad(snapshot.concentrationY)}

Hook fee params:
  baseFee: ${fmtBps(feeParams.baseFee)}
  minFee: ${fmtBps(feeParams.minFee)}
  maxFee: ${fmtBps(feeParams.maxFee)}
  mismatchScale: ${fmtWad(feeParams.mismatchScale)}
  paused: ${feeParams.paused}

Trade stats:
  Total trades: ${stats.tradeCount.toString()}
  Volume: ${fmtR0(stats.cumulativeVolume0)} / ${fmtR1(stats.cumulativeVolume1)}
  Last trade: ${stats.lastTradeAsset0In ? "asset0 in" : "asset1 in"}, size ${stats.lastTradeAsset0In ? fmtR0(stats.lastTradeSize) : fmtR1(stats.lastTradeSize)}

Gas spent today: ${fmtEth(gasSpentToday)}
Recent actions: ${recentActions.length > 0 ? recentActions.map((a) => `${a.type}: ${a.reason} (${a.success ? "OK" : "FAILED"})`).join("; ") : "none"}
${aggQuote ? `
Aggregator market data (CowSwap):
  Mid price: ${aggQuote.midPrice.toFixed(6)} (asset1 per asset0)
  Bid: ${aggQuote.bidPrice.toFixed(6)}, Ask: ${aggQuote.askPrice.toFixed(6)}
  Spread: ${aggQuote.spread.toFixed(1)} bps` : `
Aggregator market data: unavailable`}
`.trim();
}

function emptyReview(notes: string): ClaudeReview {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    recommendations: [],
    marketAnalysis: "",
    strategyNotes: notes,
  };
}
