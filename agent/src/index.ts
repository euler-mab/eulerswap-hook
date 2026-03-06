import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { loadConfig, loadArbConfig } from "./config.js";
import * as monitor from "./monitor.js";
import * as oracle from "./oracle.js";
import * as rules from "./rules.js";
import * as executor from "./executor.js";
import * as claude from "./claude.js";
import * as journal from "./journal.js";
import * as metrics from "./metrics.js";
import { getFundingRate } from "./funding.js";
import * as arb from "./arb.js";
import { eulerSwapAbi, erc20Abi } from "./abi.js";
import { fmtToken, fmtBps as fmtBpsUtil, fmtEth, type AssetDecimals } from "./types.js";

async function main() {
  const config = loadConfig();
  const arbConfig = loadArbConfig();
  const account = privateKeyToAccount(config.privateKey);

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl),
    cacheTime: 0,  // Disable response caching — agent needs fresh on-chain data every poll
  });

  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(config.flashbotsRpcUrl ?? config.rpcUrl),
  });

  // Read asset addresses (immutable, one-time)
  const assets = await publicClient.readContract({
    address: config.poolAddress,
    abi: eulerSwapAbi,
    functionName: "getAssets",
  });
  const asset0 = assets[0] as Address;
  const asset1 = assets[1] as Address;

  // Read token decimals (one-time)
  const [dec0, dec1] = await Promise.all([
    publicClient.readContract({ address: asset0, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: asset1, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const decimals: AssetDecimals = { dec0: Number(dec0), dec1: Number(dec1) };

  console.log("EulerSwap LP Agent starting...");
  console.log(`  Pool: ${config.poolAddress}`);
  console.log(`  Hook: ${config.hookAddress}`);
  console.log(`  Assets: ${asset0} / ${asset1}`);
  console.log(`  Agent: ${account.address}`);
  console.log(`  Poll: every ${config.pollInterval}s`);
  console.log(`  Claude review: every ${config.claudeReviewInterval}s`);

  journal.setPool(config.poolAddress);
  journal.startup(config);

  // Log vault info (LTV, leverage) at startup
  try {
    const vaultDebt = await monitor.getVaultDebtInfo(publicClient, config);
    journal.vaultInfo(vaultDebt, decimals);
    console.log(`  Type: ${vaultDebt.isBooster ? "booster" : "standard"}`);
    console.log(`  LTV: asset0=${(vaultDebt.ltv0 / 100).toFixed(1)}%, asset1=${(vaultDebt.ltv1 / 100).toFixed(1)}%`);
    console.log(`  Max leverage: asset0=${vaultDebt.maxLeverage0.toFixed(2)}x, asset1=${vaultDebt.maxLeverage1.toFixed(2)}x`);
  } catch {
    console.log("  Vault info: unavailable");
  }

  // Check registry status at startup
  let lastRegistryStatus: boolean | null = null;
  if (config.registryAddress) {
    try {
      const regInfo = await monitor.getRegistryInfo(publicClient, config);
      journal.registryStatus(regInfo);
      lastRegistryStatus = regInfo.registered;
      console.log(`  Registry: ${regInfo.registered ? "registered" : "NOT REGISTERED"} (bond: ${(Number(regInfo.validityBond) / 1e18).toFixed(4)} ETH)`);
    } catch {
      console.log("  Registry: unavailable");
    }
  }

  // --- Main poll loop ---
  const pollLoop = async () => {
    try {
      // Read state (including vault debt for interest-rate awareness)
      const [snapshot, feeParams, vaultDebt, aggQuote] = await Promise.all([
        monitor.getPoolSnapshot(publicClient, config),
        monitor.getHookFeeParams(publicClient, config),
        monitor.getVaultDebtInfo(publicClient, config).catch(() => undefined),
        oracle.getAggregatorQuote(publicClient, asset0, asset1).catch(() => null),
      ]);

      metrics.recordSnapshot(snapshot);

      // Evaluate rules (CowSwap mid-price used for recentering decisions)
      const gasToday = metrics.getGasSpentToday();
      const ruleResults = rules.evaluate(snapshot, feeParams, config, gasToday, vaultDebt, aggQuote, decimals);
      journal.ruleResults(ruleResults);

      // Check if gas budget or rate limit blocks execution
      const gasBudgetResult = ruleResults.find((r) => r.name === "gasBudget");
      const rateLimitResult = ruleResults.find((r) => r.name === "rateLimit");
      const canExecute =
        !gasBudgetResult?.triggered && !rateLimitResult?.triggered;

      // Execute triggered actions
      if (canExecute) {
        for (const result of ruleResults) {
          if (result.triggered && result.action) {
            try {
              const executed = await executor.execute(
                result.action,
                walletClient,
                publicClient,
                config
              );
              metrics.recordAction(executed);
              journal.action(executed);
              console.log(
                `Action: ${executed.type} — ${executed.success ? "OK" : "FAILED"} (gas: ${(Number(executed.gasUsed) / 1e18).toFixed(6)} ETH)`
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              journal.error(`Failed to execute ${result.action.type}: ${msg}`);
              console.error(`Action failed: ${msg}`);
            }
          }
        }
      }

      // Periodic snapshot log (every 10th poll)
      const snapCount = metrics.getMetrics().snapshots.length;
      if (snapCount % 10 === 0) {
        journal.snapshot(snapshot, decimals);
        console.log(
          `Snapshot #${snapCount}: reserves=${fmtToken(snapshot.reserve0, decimals.dec0)}/${fmtToken(snapshot.reserve1, decimals.dec1)}, mismatch=${fmtBpsUtil(snapshot.mismatch)}bps`
        );

        // Check registry status every 10th poll (~5 min at 30s intervals)
        if (config.registryAddress) {
          try {
            const regInfo = await monitor.getRegistryInfo(publicClient, config);
            if (lastRegistryStatus === true && !regInfo.registered) {
              journal.registryAlert("Pool has been DEREGISTERED — validity bond lost or challenged!");
              console.error("REGISTRY ALERT: Pool deregistered!");
            } else if (lastRegistryStatus === false && regInfo.registered) {
              journal.registryAlert("Pool is now registered in the registry.");
              console.log("Registry: pool re-registered");
            }
            lastRegistryStatus = regInfo.registered;
          } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      journal.error(`Poll error: ${msg}`);
      console.error(`Poll error: ${msg}`);
    }
  };

  // --- Claude review loop ---
  const claudeLoop = async () => {
    try {
      const [snapshot, feeParams, vaultDebt, registryInfo] = await Promise.all([
        monitor.getPoolSnapshot(publicClient, config),
        monitor.getHookFeeParams(publicClient, config),
        monitor.getVaultDebtInfo(publicClient, config).catch(() => undefined),
        config.registryAddress
          ? monitor.getRegistryInfo(publicClient, config).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);

      const gasToday = metrics.getGasSpentToday();
      const recentActions = metrics.getRecentActions();

      // Aggregator quote + funding rate for market context (non-blocking — null is OK)
      const [aggQuote, funding] = await Promise.all([
        oracle.getAggregatorQuote(publicClient, asset0, asset1),
        config.fundingSymbol
          ? getFundingRate(config.fundingSymbol).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Get last review for feedback loop
      const allReviews = metrics.getMetrics().reviews;
      const lastReview = allReviews.length > 0 ? allReviews[allReviews.length - 1]! : null;

      console.log("Running Claude review...");
      const review = await claude.review(
        config,
        snapshot,
        feeParams,
        recentActions,
        gasToday,
        aggQuote,
        decimals,
        vaultDebt,
        funding,
        lastReview,
        registryInfo,
      );

      metrics.recordReview(review);
      journal.claudeReview(review);
      console.log(
        `Claude review: ${review.recommendations.length} recommendations`
      );

      // Execute safe recommendations
      for (const rec of review.recommendations) {
        const safety = rules.isSafe(rec, config, snapshot);
        if (safety.safe) {
          try {
            const executed = await executor.execute(
              {
                type: rec.type,
                reason: `Claude: ${rec.reasoning}`,
                params: rec.params,
              },
              walletClient,
              publicClient,
              config
            );
            metrics.recordAction(executed);
            journal.action(executed);
            console.log(
              `Claude action: ${executed.type} — ${executed.success ? "OK" : "FAILED"}`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            journal.error(`Claude action failed: ${msg}`);
          }
        } else {
          console.log(
            `Claude recommendation rejected: ${rec.type} — ${safety.reason}`
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      journal.error(`Claude review error: ${msg}`);
      console.error(`Claude review error: ${msg}`);
    }
  };

  // --- Arb loop (every block, ~12s) ---
  const arbLoop = async () => {
    if (!arbConfig.enabled) return;
    try {
      // Rough ETH price from oracle (asset1 is WETH in USDC/WETH pools)
      const ethPriceUsd = decimals.dec0 === 6 ? 2500 : 1; // heuristic; overridden by oracle below
      let ethPrice = ethPriceUsd;
      try {
        const aggQuote = await oracle.getAggregatorQuote(publicClient, asset0, asset1);
        if (aggQuote && aggQuote.midPrice > 0) {
          // midPrice = asset1 per asset0. For USDC/WETH: ~0.0004 (1 USDC = 0.0004 WETH)
          // ETH price = 1 / midPrice
          ethPrice = decimals.dec0 === 6 ? 1 / aggQuote.midPrice : aggQuote.midPrice;
        }
      } catch { /* use fallback */ }

      const gasToday = metrics.getGasSpentToday();
      if (gasToday >= config.dailyGasBudget) return;

      const opp = await arb.checkArbOpportunity(
        publicClient,
        config,
        arbConfig,
        asset0,
        asset1,
        decimals,
        ethPrice,
      );

      if (opp) {
        console.log(`Arb opportunity: ${arb.formatOpportunity(opp, decimals)}`);
        const result = await arb.executeArb(opp, walletClient, publicClient, config, arbConfig);
        journal.arbResult({
          direction: opp.direction,
          profit: fmtToken(opp.profit, opp.direction === "B" ? decimals.dec1 : decimals.dec0),
          profitUsd: opp.profitUsd,
          txHash: result.txHash,
          success: result.success,
          gasUsed: fmtEth(result.gasUsed),
        });
        console.log(`Arb ${result.success ? "OK" : "FAILED"}: tx=${result.txHash} gas=${fmtEth(result.gasUsed)} ETH`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      journal.error(`Arb error: ${msg}`);
      // Don't spam console for expected "no opportunity" errors
      if (!msg.includes("Not profitable")) {
        console.error(`Arb error: ${msg}`);
      }
    }
  };

  // Start loops
  setInterval(pollLoop, config.pollInterval * 1000);
  setInterval(claudeLoop, config.claudeReviewInterval * 1000);
  if (arbConfig.enabled) {
    setInterval(arbLoop, 12_000); // ~1 block
    console.log(`  Arb bot: enabled (contract=${arbConfig.arbitrageurAddress})`);
    console.log(`  Arb min profit: $${arbConfig.minProfitUsd}, max trade: $${arbConfig.maxTradeUsd}`);
  } else {
    console.log("  Arb bot: disabled (set ARB_ENABLED=true to enable)");
  }

  // Run first poll immediately
  await pollLoop();

  console.log("Agent running. Press Ctrl+C to stop.");

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
