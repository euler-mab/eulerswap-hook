# Seed prompts

Verbatim prompts for an AI coding agent (Claude Code, Codex, etc.) working in this repo. Each is pre-validated to produce useful output without further clarification.

If you're new to this repo, start with the first prompt and let the agent's response guide you.

---

### Set up and verify

> "Set up this repo from scratch (`make setup`), run `make doctor`, then `make test`. Tell me if anything fails and stop."

Expected: agent runs the three commands in order, reports green or pinpoints the first failure.

---

### Understand the design

> "Explain what this hook does in three paragraphs — design, mechanisms, what makes it different from a passive Uniswap V3 LP. Cite specific files in [contracts/src/](contracts/src/)."

Expected: agent reads README, AGENTS, ARCHITECTURE, and produces a grounded summary citing file paths.

---

### Run the live-state analyzer

> "Run [scripts/analyze-hook.ts](scripts/analyze-hook.ts) against the default USDC/WETH pool. Summarize lifetime volume, fees collected, fee capture %, and the worst/best swaps. (The script auto-detects asset symbols + decimals from chain; only `MAINNET_RPC_URL` needs to be set.)"

Expected: agent sets the RPC env var, runs the analyzer, summarizes the on-chain history. The default USDC/WETH pool is decommissioned now but its historical Swap events are still readable, which is what the script analyzes. V4-oracle pools (USDC/USDT) error out cleanly because historical V4 sqrtPrice reads via extsload aren't yet implemented.

---

### Deploy to a forked mainnet

> "Run `make demo` to deploy the USDC/WETH hook against a forked mainnet. Show me the deployed addresses and whether the post-deploy fork tests pass."

Expected: agent runs the anvil demo, summarizes results.

---

### Adapt for a new pair

> "I want to deploy this hook for [token A] / [token B] on Ethereum mainnet. Walk me through what I need: vault addresses, oracle pool, calibration profile. Then generate a `scripts/profiles/[name].json` and a worked-example deploy script modeled on [DeployHookUSDCWETH.s.sol](contracts/script/DeployHookUSDCWETH.s.sol)."

Expected: agent identifies vault addresses (Euler clusters), checks for a deep Uniswap reference pool, generates the calibration profile, generates the deploy script, asks clarifying questions only on genuinely ambiguous choices.

---

### Trace an auction cycle

> "Trace what happens, line by line, when relative exposure exceeds `auctionTriggerThreshold` for the first time. Cite [DynamicFeeAuctionHook.sol](contracts/src/DynamicFeeAuctionHook.sol) by line number and end with the on-chain events emitted."

Expected: agent reads the source, produces a step-by-step trace with citations.

---

### Find where a concept is implemented

> "Where is the `builderFee` mechanism implemented? Give me file paths, line numbers, and a one-paragraph summary of how it works including the threat model."

Expected: agent greps + reads, produces a grounded answer with line cites.

---

### Add a new unit test

> "Add a unit test that verifies the auction clears within 50 blocks under a 3% oracle drift. Pattern-match the existing tests in [DynamicFeeAuctionHook.t.sol](contracts/test/DynamicFeeAuctionHook.t.sol). Run it before stopping."

Expected: agent writes the test, runs it, reports pass/fail.

---

## Anti-patterns

- **"Deploy this to mainnet."** Never. Mainnet broadcasts are explicit `forge script ... --broadcast` commands run by you with `PRIVATE_KEY` in your own shell, after thorough fork testing.
- **"Audit this contract."** Agents are not auditors. Use them to surface candidate issues you verify yourself; never as the sole security review.
- **"Make it production-ready."** Too vague. Specify: "add CI / pin Foundry / add a doctor script / etc."
