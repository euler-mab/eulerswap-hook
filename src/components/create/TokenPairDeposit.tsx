"use client";

import { TOKENS } from "@/lib/tokens";
import { fmtUsd } from "@/lib/paramBuilder";

interface Props {
  tokenX: string;
  tokenY: string;
  depositX: number;
  depositY: number;
  onTokenX: (s: string) => void;
  onTokenY: (s: string) => void;
  onDepositX: (v: number) => void;
  onDepositY: (v: number) => void;
}

function TokenColumn({
  label,
  token,
  exclude,
  deposit,
  onToken,
  onDeposit,
}: {
  label: string;
  token: string;
  exclude: string;
  deposit: number;
  onToken: (s: string) => void;
  onDeposit: (v: number) => void;
}) {
  const t = TOKENS.find((tk) => tk.symbol === token) ?? TOKENS[0];
  const dollarValue = deposit * t.price;

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium uppercase tracking-widest text-gray-400">
        {label}
      </label>
      <select
        value={token}
        onChange={(e) => onToken(e.target.value)}
        className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500"
      >
        {TOKENS.filter((tk) => tk.symbol !== exclude).map((tk) => (
          <option key={tk.symbol} value={tk.symbol}>
            {tk.symbol} — {tk.name}
          </option>
        ))}
      </select>
      <div className="relative">
        <input
          type="number"
          value={deposit || ""}
          onChange={(e) => onDeposit(Math.max(0, Number(e.target.value)))}
          placeholder="0"
          className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 font-mono focus:outline-none focus:border-blue-500"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
          {token}
        </span>
      </div>
      <p className="text-xs text-gray-500 font-mono pl-1">
        {fmtUsd(dollarValue)}
      </p>
    </div>
  );
}

export default function TokenPairDeposit(props: Props) {
  const tX = TOKENS.find((t) => t.symbol === props.tokenX) ?? TOKENS[0];
  const tY = TOKENS.find((t) => t.symbol === props.tokenY) ?? TOKENS[0];
  const totalUsd = props.depositX * tX.price + props.depositY * tY.price;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-6">
        <TokenColumn
          label="Token X"
          token={props.tokenX}
          exclude={props.tokenY}
          deposit={props.depositX}
          onToken={props.onTokenX}
          onDeposit={props.onDepositX}
        />
        <TokenColumn
          label="Token Y"
          token={props.tokenY}
          exclude={props.tokenX}
          deposit={props.depositY}
          onToken={props.onTokenY}
          onDeposit={props.onDepositY}
        />
      </div>
      <div className="text-sm text-gray-500 text-right">
        Total value: <span className="text-gray-700 font-mono">{fmtUsd(totalUsd)}</span>
      </div>
    </div>
  );
}
