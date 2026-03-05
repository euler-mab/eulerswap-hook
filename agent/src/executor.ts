import type { WalletClient, PublicClient, Hash } from "viem";
import type { AgentConfig, Action, ExecutedAction } from "./types.js";
import { eulerSwapAbi, hookAbi } from "./abi.js";
import { recordReconfig } from "./rules.js";

export async function execute(
  action: Action,
  walletClient: WalletClient,
  publicClient: PublicClient,
  config: AgentConfig
): Promise<ExecutedAction> {
  const account = walletClient.account;
  if (!account) throw new Error("Wallet client has no account");

  let txHash: Hash;

  switch (action.type) {
    case "reconfigure": {
      // Read current dynamic params, merge with action params
      const currentDParams = await publicClient.readContract({
        address: config.poolAddress,
        abi: eulerSwapAbi,
        functionName: "getDynamicParams",
      });

      const newDParams = {
        ...currentDParams,
        equilibriumReserve0: action.params["equilibriumReserve0"]
          ? BigInt(action.params["equilibriumReserve0"] as string)
          : currentDParams.equilibriumReserve0,
        equilibriumReserve1: action.params["equilibriumReserve1"]
          ? BigInt(action.params["equilibriumReserve1"] as string)
          : currentDParams.equilibriumReserve1,
        concentrationX: action.params["concentrationX"]
          ? BigInt(action.params["concentrationX"] as string)
          : currentDParams.concentrationX,
        concentrationY: action.params["concentrationY"]
          ? BigInt(action.params["concentrationY"] as string)
          : currentDParams.concentrationY,
      };

      const initialState = {
        reserve0: newDParams.equilibriumReserve0,
        reserve1: newDParams.equilibriumReserve1,
      };

      txHash = await walletClient.writeContract({
        address: config.poolAddress,
        abi: eulerSwapAbi,
        functionName: "reconfigure",
        args: [newDParams, initialState],
        account,
        chain: walletClient.chain,
      });

      recordReconfig();
      break;
    }

    case "setFeeParams": {
      txHash = await walletClient.writeContract({
        address: config.hookAddress,
        abi: hookAbi,
        functionName: "setFeeParams",
        args: [
          BigInt(action.params["baseFee"] as string),
          BigInt(action.params["maxFee"] as string),
          BigInt(action.params["minFee"] as string),
          BigInt(action.params["mismatchScale"] as string),
        ],
        account,
        chain: walletClient.chain,
      });
      break;
    }

    case "setPaused": {
      txHash = await walletClient.writeContract({
        address: config.hookAddress,
        abi: hookAbi,
        functionName: "setPaused",
        args: [action.params["paused"] as boolean],
        account,
        chain: walletClient.chain,
      });
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  // Wait for receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    ...action,
    txHash,
    gasUsed: receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n),
    success: receipt.status === "success",
    timestamp: Math.floor(Date.now() / 1000),
  };
}
