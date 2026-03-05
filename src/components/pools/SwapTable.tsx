"use client";

import { useState } from "react";
import type { SwapEvent } from "@/lib/pools/types";
import { fmtAmount, timeAgo } from "@/lib/pools/format";

interface Props {
  swaps: SwapEvent[];
  asset0Decimals: number;
  asset1Decimals: number;
  asset0Symbol: string;
  asset1Symbol: string;
}

const PAGE_SIZE = 50;

export default function SwapTable({ swaps, asset0Decimals, asset1Decimals, asset0Symbol, asset1Symbol }: Props) {
  const [showAll, setShowAll] = useState(false);

  // Reverse to show most recent first
  const sorted = [...swaps].reverse();
  const visible = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-zinc-600 uppercase tracking-wider">
              <th className="text-left pb-2">Time</th>
              <th className="text-left pb-2">Direction</th>
              <th className="text-right pb-2">In</th>
              <th className="text-right pb-2">Out</th>
              <th className="text-right pb-2">Fee</th>
              <th className="text-right pb-2">Block</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            {visible.map((s, i) => {
              const isBuy = s.amount0In > 0n; // asset0 in → buying asset1
              return (
                <tr key={`${s.transactionHash}-${s.logIndex}`} className="border-t border-zinc-800/40">
                  <td className="py-1.5">
                    {s.timestamp ? timeAgo(s.timestamp) : `#${s.blockNumber.toString()}`}
                  </td>
                  <td className="py-1.5">
                    <span className={isBuy ? "text-emerald-400" : "text-red-400"}>
                      {isBuy ? `→ ${asset1Symbol}` : `→ ${asset0Symbol}`}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {isBuy
                      ? `${fmtAmount(s.amount0In, asset0Decimals)} ${asset0Symbol}`
                      : `${fmtAmount(s.amount1In, asset1Decimals)} ${asset1Symbol}`}
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {isBuy
                      ? `${fmtAmount(s.amount1Out, asset1Decimals)} ${asset1Symbol}`
                      : `${fmtAmount(s.amount0Out, asset0Decimals)} ${asset0Symbol}`}
                  </td>
                  <td className="py-1.5 text-right font-mono text-zinc-500">
                    {s.fee0 > 0n && `${fmtAmount(s.fee0, asset0Decimals)}`}
                    {s.fee1 > 0n && `${fmtAmount(s.fee1, asset1Decimals)}`}
                  </td>
                  <td className="py-1.5 text-right">
                    <a
                      href={`https://etherscan.io/tx/${s.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 hover:text-zinc-300 transition-colors font-mono text-[10px]"
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
          className="mt-3 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Show all {sorted.length} trades
        </button>
      )}
    </div>
  );
}
