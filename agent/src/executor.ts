import type { WalletClient, PublicClient, Hash, Address } from "viem";
import { encodeFunctionData } from "viem";
import type { AgentConfig, Action, ExecutedAction } from "./types.js";
import { eulerSwapAbi, evcAbi, hookAbi, evaultAbi, erc20Abi } from "./abi.js";
import { recordAction as recordRateLimitedAction } from "./rules.js";
import { getVaultMeta } from "./monitor.js";
import { getSwapQuote, signOrder, submitOrder, waitForOrder, GPV2_VAULT_RELAYER } from "./cowswap.js";

const TX_TIMEOUT_MS = 120_000;

export async function execute(
  action: Action,
  walletClient: WalletClient,
  publicClient: PublicClient,
  config: AgentConfig
): Promise<ExecutedAction> {
  const account = walletClient.account;
  if (!account) throw new Error("Wallet client has no account");

  // External swap has its own multi-step flow
  if (action.type === "externalSwap") {
    return executeExternalSwap(action, walletClient, publicClient, config);
  }

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
        minReserve0: action.params["minReserve0"] !== undefined
          ? BigInt(action.params["minReserve0"] as string)
          : currentDParams.minReserve0,
        minReserve1: action.params["minReserve1"] !== undefined
          ? BigInt(action.params["minReserve1"] as string)
          : currentDParams.minReserve1,
        priceX: action.params["priceX"]
          ? BigInt(action.params["priceX"] as string)
          : currentDParams.priceX,
        priceY: action.params["priceY"]
          ? BigInt(action.params["priceY"] as string)
          : currentDParams.priceY,
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

      // Must route through EVC — direct calls revert with EVC_NotAuthorized
      const reconfigureData = encodeFunctionData({
        abi: eulerSwapAbi,
        functionName: "reconfigure",
        args: [newDParams, initialState],
      });

      txHash = await walletClient.writeContract({
        address: config.evcAddress,
        abi: evcAbi,
        functionName: "call",
        args: [config.poolAddress, config.eulerAccount, 0n, reconfigureData],
        account,
        chain: walletClient.chain,
      });

      recordRateLimitedAction();
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
          BigInt(action.params["gasCoeff"] as string),
          BigInt(action.params["captureRate"] as string),
          BigInt(action.params["attractRate"] as string),
        ],
        account,
        chain: walletClient.chain,
      });
      recordRateLimitedAction();
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: TX_TIMEOUT_MS,
  });

  return {
    ...action,
    txHash,
    gasUsed: receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n),
    success: receipt.status === "success",
    timestamp: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// External swap: withdraw from vault → CowSwap → deposit back
// ---------------------------------------------------------------------------

async function executeExternalSwap(
  action: Action,
  walletClient: WalletClient,
  publicClient: PublicClient,
  config: AgentConfig,
): Promise<ExecutedAction> {
  const account = walletClient.account!;
  const sellAsset = action.params["sellAsset"] as string; // "0" or "1"
  const sellAmount = BigInt(action.params["sellAmount"] as string);
  const minBuyAmount = BigInt(action.params["minBuyAmount"] as string);

  const meta = await getVaultMeta(publicClient, config);
  const isAsset0 = sellAsset === "0";
  const sellToken = isAsset0 ? meta.asset0 : meta.asset1;
  const buyToken = isAsset0 ? meta.asset1 : meta.asset0;
  const sellVault = isAsset0 ? meta.supplyVault0 : meta.supplyVault1;
  const buyVault = isAsset0 ? meta.supplyVault1 : meta.supplyVault0;

  let totalGasUsed = 0n;

  // Helper: wait for tx receipt and accumulate gas
  async function waitAndAccum(hash: Hash): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: TX_TIMEOUT_MS,
    });
    totalGasUsed += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    if (receipt.status !== "success") {
      throw new Error(`Transaction reverted: ${hash}`);
    }
  }

  // Helper: deposit tokens back into vault (recovery or final step)
  async function depositToVault(
    token: Address,
    vault: Address,
    amount: bigint,
  ): Promise<Hash> {
    // Approve vault to pull tokens from agent EOA
    const appHash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, amount],
      account,
      chain: walletClient.chain,
    });
    await waitAndAccum(appHash);

    // Deposit directly — vault.deposit is permissionless, transfers from msg.sender
    const depHash = await walletClient.writeContract({
      address: vault,
      abi: evaultAbi,
      functionName: "deposit",
      args: [amount, config.eulerAccount],
      account,
      chain: walletClient.chain,
    });
    await waitAndAccum(depHash);
    return depHash;
  }

  // Step 1: Withdraw sell tokens from supply vault to agent EOA
  console.log(`  Swap step 1/5: Withdrawing ${sellAmount} from vault...`);
  const withdrawData = encodeFunctionData({
    abi: evaultAbi,
    functionName: "withdraw",
    args: [sellAmount, account.address, config.eulerAccount],
  });
  const withdrawHash = await walletClient.writeContract({
    address: config.evcAddress,
    abi: evcAbi,
    functionName: "call",
    args: [sellVault, config.eulerAccount, 0n, withdrawData],
    account,
    chain: walletClient.chain,
  });
  await waitAndAccum(withdrawHash);

  // Step 2: Get CowSwap quote (off-chain, no gas)
  console.log(`  Swap step 2/5: Getting CowSwap quote...`);
  const quote = await getSwapQuote(sellToken, buyToken, sellAmount, account.address);
  if (!quote) {
    console.error("  CowSwap quote failed — recovering tokens to vault...");
    await depositToVault(sellToken, sellVault, sellAmount);
    throw new Error("CowSwap quote failed — tokens recovered to vault");
  }

  if (BigInt(quote.buyAmount) < minBuyAmount) {
    console.error(`  CowSwap price too low (${quote.buyAmount} < ${minBuyAmount}) — recovering...`);
    await depositToVault(sellToken, sellVault, sellAmount);
    throw new Error(`CowSwap quote too low: ${quote.buyAmount} < ${minBuyAmount}`);
  }

  // Step 3: Approve CowSwap VaultRelayer (sellAmount + feeAmount for solver fees)
  const approveAmount = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  console.log(`  Swap step 3/5: Approving CowSwap for ${approveAmount}...`);
  const approveHash = await walletClient.writeContract({
    address: sellToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [GPV2_VAULT_RELAYER, approveAmount],
    account,
    chain: walletClient.chain,
  });
  await waitAndAccum(approveHash);

  // Step 4: Sign and submit order
  console.log(`  Swap step 4/5: Signing and submitting order...`);
  const signature = await signOrder(walletClient, quote);
  const orderUid = await submitOrder(quote, signature, account.address);
  console.log(`  Order submitted: ${orderUid.slice(0, 20)}...`);

  // Step 5: Wait for fill
  console.log(`  Swap step 5/5: Waiting for fill (up to 5 min)...`);
  const result = await waitForOrder(orderUid);

  if (result.status !== "fulfilled") {
    // Order expired or was cancelled — try to recover tokens
    console.error(`  Order ${result.status} — recovering tokens to vault...`);
    try {
      await depositToVault(sellToken, sellVault, sellAmount);
    } catch (recoverErr) {
      const msg = recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
      console.error(`  WARNING: Token recovery failed: ${msg}`);
      console.error(`  ${sellAmount} of ${sellToken} may be stuck in agent EOA ${account.address}`);
    }
    throw new Error(`CowSwap order ${result.status}`);
  }

  // Step 6: Deposit received buy tokens into supply vault
  console.log(`  Depositing ${result.buyAmount} into vault...`);
  const finalHash = await depositToVault(buyToken, buyVault, result.buyAmount);

  console.log(`  Swap complete: sold ${sellAmount} asset${sellAsset}, received ${result.buyAmount}`);

  recordRateLimitedAction();

  return {
    ...action,
    txHash: finalHash,
    gasUsed: totalGasUsed,
    success: true,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
