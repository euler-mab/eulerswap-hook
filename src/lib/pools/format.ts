import { formatUnits } from "viem";
import type { SwapEvent, PricePoint } from "./types";

/** Format a bigint amount with token decimals to human-readable string */
export function fmtAmount(amount: bigint, decimals: number, maxDp = 4): string {
  const num = Number(formatUnits(amount, decimals));
  if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(2)}k`;
  if (Math.abs(num) >= 1) return num.toFixed(Math.min(maxDp, 2));
  if (Math.abs(num) >= 0.0001) return num.toFixed(maxDp);
  if (num === 0) return "0";
  return num.toExponential(2);
}

/** Format USD value */
export function fmtUsd(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}k`;
  return `$${value.toFixed(2)}`;
}

/** Format basis points from WAD-scaled fee (1e18 = 100%) */
export function fmtFeeBps(feeWad: bigint): string {
  const bps = Number(feeWad) / 1e14;
  return `${bps.toFixed(1)} bps`;
}

/** Format address to 0x1234...5678 */
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Format relative time */
export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Convert swap events to chart-ready PricePoint array */
export function swapsToPricePoints(
  swaps: SwapEvent[],
  decimals0: number,
  decimals1: number,
): PricePoint[] {
  let cumFee0 = 0;
  let cumFee1 = 0;
  return swaps.map((s) => {
    const r0 = Number(formatUnits(s.reserve0, decimals0));
    const r1 = Number(formatUnits(s.reserve1, decimals1));
    const price = r0 > 0 ? r1 / r0 : 0;
    cumFee0 += Number(formatUnits(s.fee0, decimals0));
    cumFee1 += Number(formatUnits(s.fee1, decimals1));
    return {
      timestamp: s.timestamp ?? 0,
      blockNumber: Number(s.blockNumber),
      price,
      reserve0: r0,
      reserve1: r1,
      cumulativeFee0: cumFee0,
      cumulativeFee1: cumFee1,
    };
  });
}

/** Downsample array to at most maxPts points, keeping first and last */
export function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = (arr.length - 1) / (maxPts - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}
