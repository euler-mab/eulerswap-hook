"use client";

import { useState } from "react";
import type { SwapEvent } from "@/lib/pools/types";
import { formatUnits } from "viem";
import { fmtAmount, timeAgo } from "@/lib/pools/format";

interface Props {
  swaps: SwapEvent[];
  asset0Decimals: number;
  asset1Decimals: number;
  asset0Symbol: string;
  asset1Symbol: string;
  prices?: { asset0: number; asset1: number };
}

const PAGE_SIZE = 50;

export default function SwapTable({ swaps, asset0Decimals, asset1Decimals, asset0Symbol, asset1Symbol, prices }: Props) {
  const [showAll, setShowAll] = useState(false);

  // Reverse to show most recent first
  const sorted = [...swaps].reverse();
  const visible = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-400 uppercase tracking-wider">
              <th className="text-left pb-2">Time</th>
              <th className="text-left pb-2">Direction</th>
              <th className="text-right pb-2">In</th>
              <th className="text-right pb-2">Out</th>
              <th className="text-right pb-2">Fee</th>
              <th className="text-right pb-2">Block</th>
            </tr>
          </thead>
          <tbody className="text-gray-500">
            {visible.map((s, i) => {
              const isBuy = s.amount0In > 0n; // asset0 in → buying asset1
              return (
                <tr key={`${s.transactionHash}-${s.logIndex}`} className="border-t border-gray-100">
                  <td className="py-2.5">
                    {s.timestamp ? timeAgo(s.timestamp) : `#${s.blockNumber.toString()}`}
                  </td>
                  <td className="py-2.5">
                    <span className={isBuy ? "text-emerald-700" : "text-red-600"}>
                      {isBuy ? `→ ${asset1Symbol}` : `→ ${asset0Symbol}`}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono">
                    {isBuy
                      ? `${fmtAmount(s.amount0In, asset0Decimals)} ${asset0Symbol}`
                      : `${fmtAmount(s.amount1In, asset1Decimals)} ${asset1Symbol}`}
                  </td>
                  <td className="py-2.5 text-right font-mono">
                    {isBuy
                      ? `${fmtAmount(s.amount1Out, asset1Decimals)} ${asset1Symbol}`
                      : `${fmtAmount(s.amount0Out, asset0Decimals)} ${asset0Symbol}`}
                  </td>
                  <td className="py-2.5 text-right font-mono text-gray-500">
                    {(() => {
                      const fee = isBuy ? s.fee0 : s.fee1;
                      const amtIn = isBuy ? s.amount0In : s.amount1In;
                      if (fee <= 0n || amtIn <= 0n) return "—";
                      const bps = Number(fee * 1_000_000n / amtIn) / 100;
                      const decimals = isBuy ? asset0Decimals : asset1Decimals;
                      const price = prices ? (isBuy ? prices.asset0 : prices.asset1) : undefined;
                      const feeUsd = price ? Number(formatUnits(fee, decimals)) * price : undefined;
                      return (
                        <span>
                          {bps.toFixed(1)} bps
                          {feeUsd !== undefined && (
                            <span className="text-gray-400 ml-1">
                              (${feeUsd < 0.01 ? feeUsd.toFixed(4) : feeUsd.toFixed(2)})
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="py-2.5 text-right">
                    <a
                      href={`https://etherscan.io/tx/${s.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-500 hover:text-gray-900 transition-colors font-mono text-xs"
                    >
                      {s.blockNumber.toString()}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showAll && sorted.length > PAGE_SIZE && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs text-gray-500 hover:text-gray-900 transition-colors cursor-pointer"
        >
          Show all {sorted.length} trades
        </button>
      )}
    </div>
  );
}
