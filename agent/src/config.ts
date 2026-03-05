import "dotenv/config";
import type { AgentConfig } from "./types.js";
import { parseEther } from "viem";
import { WAD, BPS } from "./types.js";

export function loadConfig(): AgentConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const optional = (key: string, fallback: string): string => {
    return process.env[key] ?? fallback;
  };

  return {
    rpcUrl: required("RPC_URL"),
    privateKey: required("PRIVATE_KEY") as `0x${string}`,
    poolAddress: required("POOL_ADDRESS") as `0x${string}`,
    hookAddress: required("HOOK_ADDRESS") as `0x${string}`,
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    flashbotsRpcUrl: process.env["FLASHBOTS_RPC_URL"],
    pollInterval: parseInt(optional("POLL_INTERVAL", "30")),
    claudeReviewInterval: parseInt(optional("CLAUDE_REVIEW_INTERVAL", "3600")),
    dailyGasBudget: parseEther(optional("DAILY_GAS_BUDGET", "0.1")),

    // Safety bounds
    minBaseFee: 1n * BPS, // 1 bp
    maxBaseFee: 100n * BPS, // 100 bp
    minConcentration: WAD / 100n, // 0.01
    maxConcentration: 95n * WAD / 100n, // 0.95
    maxReconfigsPerHour: 12,
  };
}
