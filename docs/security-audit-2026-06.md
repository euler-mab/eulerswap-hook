# DynamicFeeAuctionHook — Spearbit-Style Security Audit

**Date:** 2026-06-04
**Auditor:** independent review (AI-assisted, single-pass)
**Scope:** [`contracts/src/DynamicFeeAuctionHook.sol`](../contracts/src/DynamicFeeAuctionHook.sol) at commit `98cfe44b9`, including the new `builderFee` mechanism (added in [5d1b95efb](https://github.com/euler-mab/eulerswap-hook/commit/5d1b95efb)).
**Status:** experimental, unaudited reference code. **This is not a substitute for a professional audit by a security firm.** It is an internal review intended to surface issues a Spearbit-style engagement would likely flag.

---

## 1. Scope and Methodology

The hook is a single ~1050-line Solidity contract that runs:

1. Oracle-reactive dynamic fees (Uniswap V3 `slot0` / V4 `extsload`).
2. Routing-aware asymmetric fee modulation (capture vs attract).
3. Continuous recenter with curvature-aware additive surcharge.
4. Clearing auction (fallback) with Dutch fee-decay.
5. **NEW**: `builderFee` — permissionless upward-only fee bump with revenue share.

Review methodology:

- Read the full contract top-to-bottom for control flow and storage layout.
- Trace each external-call surface for reentrancy reachability.
- Cross-check the `builderFee` accrual math against the share-payout invariants.
- Examine each `onlyOwner` setter for ranges that could brick or bias the system.
- Validate threat-model claims from `docs/builder-fee-design.md` against implementation.
- Look for known anti-patterns: integer truncation, non-standard ERC-20 handling, oracle manipulation, MEV/sandwich exposure.

Out of scope:
- EulerSwap protocol (audited separately).
- EVK and EVC (audited separately).
- Deploy scripts and calibration tooling.

---

## 2. Findings Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| H-01 | `withdrawBuilderShare` will silently fail on non-standard ERC-20s (USDT) | High | **Fixed** |
| M-01 | Owner-controlled `builderFeeShareBps` can be changed without notice between accrual periods | Medium | Acknowledged |
| M-02 | Builder-fee mechanism creates an operator-funding trust dependency | Medium | Acknowledged |
| M-03 | Hook owner cannot rescue accrued share if hook is replaced (no migration path) | Medium | **Fixed** |
| L-01 | `setBuilderFeeShareBps` accepts 100% — LP can be configured to capture nothing | Low | **Fixed** |
| L-02 | `_accrueBuilderShare` precision loss on very small swaps | Low | **Fixed** |
| L-03 | `setBuilderFee` does not reject zero-fee bumps; ledger pollution possible | Low | **Fixed** |
| L-04 | Pre-existing: `endAuction()` does not reset `auctionStartBlock`, can confuse downstream telemetry | Low | **Fixed** |
| I-01 | `_accrueBuilderShare` re-computes public fee already calculated in `getFee` (gas) | Info | Acknowledged |
| I-02 | No event emitted when a bump is ignored (below public floor) | Info | **Fixed** |
| I-03 | Storage struct `BuilderFeeSlot` does not pack optimally with adjacent fields | Info | Acknowledged |
| I-04 | `_accrueBuilderShare` assumes unidirectional swap; assumption not asserted | Info | **Fixed** |
| I-05 | NatSpec for `setBuilderFee` does not warn smart-contract callers about withdraw semantics | Info | **Fixed** |

**1 High, 3 Medium, 4 Low, 5 Informational.**

No Critical findings.

### Remediation Summary

**Fixed (9 findings):** H-01, M-03, L-01, L-02, L-03, L-04, I-02, I-04, I-05.

**Acknowledged (4 findings):** M-01, M-02, I-01, I-03 — design or operational trade-offs that we've chosen not to address in this revision. See per-finding notes below.

- **M-01 / M-02 (acknowledged):** Both relate to operator-trust assumptions inherent to a single-LP hook design. The operator is the LP — they are not pretending to be a neutral protocol. A timelock on `setBuilderFeeShareBps` adds complexity disproportionate to the threat for an experimental hook. The funding dependency is documented prominently in [docs/builder-fee-design.md](builder-fee-design.md). A future iteration may automate funding via direct vault integration.
- **I-01 (acknowledged):** Transient-storage caching for `_publicFee` would save 3-5k gas per bumped swap but adds complexity to the reentrancy story. Deferred until empirical gas profiling justifies it.
- **I-03 (acknowledged):** Storage packing for `BuilderFeeSlot` + `builderFeeShareBps` would save one SLOAD per bumped swap but requires consolidating into a single struct read. Marginal — deferred.

---

## 3. Detailed Findings

### H-01 — `withdrawBuilderShare` will silently fail on non-standard ERC-20s (USDT)

**Severity:** High
**Location:** [DynamicFeeAuctionHook.sol:379-385](../contracts/src/DynamicFeeAuctionHook.sol#L379-L385)

**Description.**
The withdrawal function uses a bare `IERC20Minimal.transfer` interface that expects a `bool` return value:

```solidity
require(IERC20Minimal(asset).transfer(msg.sender, amount), "transfer failed");
```

Tether USD (USDT) and a handful of historical tokens do not return a `bool` from `transfer`. When the call returns empty data, Solidity's ABI decoder reverts when trying to decode the expected `bool`. The withdrawal will **always revert** for these tokens.

USDT is one half of the live `USDC/USDT` deployment ([`0x7195...68A8`](https://etherscan.io/address/0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8)) — exactly the pool where this hook is currently in production. Any builder accruing share denominated in USDT cannot withdraw it.

**Impact.**
For pools that include USDT (or any non-compliant token), the entire builder-fee mechanism is broken on the withdraw side. Builders will accrue claims they cannot redeem. No funds are lost from the pool, but builder trust in the mechanism is permanently broken on those pools.

**Recommendation.**
Use OpenZeppelin's `SafeERC20.safeTransfer`, or inline an equivalent that handles both `bool`-returning and no-return tokens. The inline version:

```solidity
(bool ok, bytes memory data) = asset.call(
    abi.encodeWithSelector(IERC20Minimal.transfer.selector, msg.sender, amount)
);
require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
```

---

### M-01 — Owner-controlled `builderFeeShareBps` can be changed without notice between accrual periods

**Severity:** Medium
**Location:** [DynamicFeeAuctionHook.sol:393-397](../contracts/src/DynamicFeeAuctionHook.sol#L393-L397)

**Description.**
`setBuilderFeeShareBps` is `onlyOwner` and can be called at any time. The value used for share calculation in `_accrueBuilderShare` is read at the time of `afterSwap` (i.e., during the swap transaction). The owner can:

- Lower `shareBps` from 5000 → 0 immediately before a heavy block, capturing the entire bump for themselves.
- Raise it briefly to attract bumpers, then lower it after they've started bumping.

Within a single swap transaction the value is consistent (atomic). The concern is across-transaction inconsistency: a builder bumping based on a stated 50% share has no on-chain guarantee that the share they accrue corresponds to that promise.

**Impact.**
Builders cannot trust the announced `shareBps`. The mechanism only functions if builders believe the share will be honored, so this introduces a soft trust dependency between operator and builders. Not directly exploitable for fund loss (the LP keeps all fees by default — lowering the share just transfers more to LP), but undermines the "trustless" framing of the design.

**Recommendation.**
- Add a timelock (e.g. 24h–7d) to `setBuilderFeeShareBps` changes, with `BuilderFeeShareBpsScheduled` and `BuilderFeeShareBpsUpdated` events.
- OR allow `shareBps` increases to take effect immediately, but require a delay for decreases.
- Document the current behavior prominently in `docs/builder-fee-design.md`.

---

### M-02 — Builder-fee mechanism creates an operator-funding trust dependency

**Severity:** Medium
**Location:** [DynamicFeeAuctionHook.sol:376-385](../contracts/src/DynamicFeeAuctionHook.sol#L376-L385), [docs/builder-fee-design.md](builder-fee-design.md)

**Description.**
The hook accrues builder-share claims to an internal ledger (`builderShareAccrued`) but does not transfer any tokens at accrual time. Fees collected during the swap remain in the pool. To honor `withdrawBuilderShare`, the LP operator must manually transfer the asset balance into the hook contract.

If the operator never funds the hook, claims accumulate without redemption. Builders have no on-chain recourse and no mechanism to force the operator to settle.

**Impact.**
The mechanism is operator-trust-dependent. Builders relying on share payouts must believe the operator will fund the hook. This contradicts the "trustless / no allowlist" framing in `docs/builder-fee-design.md`.

**Recommendation.**
Two paths, in decreasing order of trust reduction:

1. **Automate funding.** Add a function that the hook can call (from `afterSwap`) to pull the builder's share directly from the pool's accrued fees via EVC. This requires deeper integration with EulerSwap and is non-trivial — but it would make the mechanism trustless.
2. **Document prominently.** Update both the `setBuilderFee` NatSpec and the design doc with a clear "trust requirement" callout. The current docs do mention it but in a low-prominence "Operational notes" section.

A middle option: emit `BuilderShareDelinquent` event when a withdraw reverts on underfunding, so off-chain monitors can flag operator non-payment.

---

### M-03 — No migration path for accrued builder share if hook is replaced

**Severity:** Medium
**Location:** General architectural concern.

**Description.**
The hook is bound to a specific EulerSwap pool via `swapHook`. The pool owner can call `reconfigure()` to swap in a different hook at any time. If they do so:

- All accrued `builderShareAccrued[*][*]` ledger balances become orphaned in the old hook contract.
- Builders cannot recover their claims unless the owner remembers to fund the old hook before the swap, or unless the owner manually transfers funds to each affected builder.

No `migrate()` or `transferAccrued()` function exists.

**Impact.**
A routine hook upgrade (e.g., to fix the H-01 issue above) would orphan builder claims unless explicit care is taken. The owner could also rug builders intentionally by upgrading the hook to one with no withdraw function, then never funding the old hook.

**Recommendation.**
Add a function callable by the hook owner that funds all outstanding claims (or transfers the obligation to a new hook). For example:

```solidity
function batchSettleBuilderShare(address[] calldata payees, address asset) external onlyOwner {
    for (uint256 i; i < payees.length; ++i) {
        uint256 amount = builderShareAccrued[payees[i]][asset];
        if (amount == 0) continue;
        builderShareAccrued[payees[i]][asset] = 0;
        _safeTransfer(asset, payees[i], amount);
        emit BuilderShareWithdrawn(payees[i], asset, amount);
    }
}
```

This doesn't enumerate all payees on-chain (impossible without a registry) but does let the owner settle a known list before a migration.

---

### L-01 — `setBuilderFeeShareBps` accepts 100% — LP can be configured to capture nothing

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:393-397](../contracts/src/DynamicFeeAuctionHook.sol#L393-L397)

**Description.**
The setter validates `shareBps <= 10000`. At 10000 (100%), the entire bumped delta is paid to the builder; the LP captures nothing extra from a bumped swap.

This is likely a misconfiguration, not a malicious setting. But the contract accepts it silently. A confused operator who intended "100%" to mean "100% of the bumped portion stays with the LP" (the inverse semantics) would unknowingly give away all bump value.

**Impact.**
Operator footgun. Could cause LP to forfeit 100% of bump-side revenue for the duration of the misconfiguration.

**Recommendation.**
Cap at a lower maximum (e.g., 8000 = 80%) to ensure the LP always retains meaningful upside, or emit a warning event when set above 5000.

---

### L-02 — `_accrueBuilderShare` precision loss on very small swaps

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:540-541](../contracts/src/DynamicFeeAuctionHook.sol#L540-L541)

**Description.**
The share calculation:

```solidity
uint256 share = (totalFee * delta * shareBps) / (bumped * 10000);
if (share == 0) return;
```

For very small `totalFee` (small swap inputs), or very small `delta`, integer division can round to 0. A swapper splitting a large swap into many tiny swaps could each round to zero share — depriving the builder of accrual that would have occurred on a single large swap.

For typical values, the threshold is in the sub-cent range per swap, so practical impact is limited. But the asymmetry favors swappers who deliberately split (e.g., aggregators).

**Impact.**
Builder loses a small amount of accrual on heavily-split swaps. Adversary pays more in gas than they save in avoided share — but the round-down still matters in aggregate.

**Recommendation.**
Use higher-precision intermediate arithmetic, or scale `share` to a higher denomination before the division:

```solidity
uint256 share = mulDiv(totalFee, delta * shareBps, bumped * 10000);
```

Where `mulDiv` does the multiplication in 512-bit math (already used elsewhere in the contract via `FullMath`).

---

### L-03 — `setBuilderFee` does not reject zero-fee bumps; ledger pollution possible

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:366-374](../contracts/src/DynamicFeeAuctionHook.sol#L366-L374)

**Description.**
A caller can submit `setBuilderFee(0)`, which silently overwrites a prior real bump in the same block. This effectively cancels any earlier bump.

In practice this is a free anti-MEV tool for any participant: see a bump → submit a zero-bump → cancel it. The cost is gas; the "benefit" is reverting the pool to the public fee.

**Impact.**
Limited: anyone can already replace a bump with their own arbitrary fee, so "replace with zero" is no worse. But it does provide a cheap denial path for the entire mechanism. Combined with running this every block, it costs ~$5/block to keep the mechanism permanently disabled. Not an attack, but worth flagging.

**Recommendation.**
Either:
- Add `require(fee > 0, "fee must be > 0")` to `setBuilderFee`, OR
- Document explicitly that zero-bumps are a valid cancellation primitive (and that this is intended).

---

### L-04 — Pre-existing: `endAuction()` does not reset `auctionStartBlock`

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:451-485](../contracts/src/DynamicFeeAuctionHook.sol#L451-L485)

**Description.**
When `endAuction()` succeeds, the contract resets `auctionActive`, `surchargeStartBlock`, `surchargeInitialAmount`, and `lastExposure`, but does **not** reset `auctionStartBlock` or `auctionStartingFee`. These remain set to their values from the most recent auction.

This isn't directly exploitable — `getFee` checks `auctionActive` first before consulting these fields. But downstream telemetry that reads these fields (analytics scripts, monitoring) would see stale data.

**Impact.**
Operational confusion. Could mislead operators investigating pool behavior.

**Recommendation.**
Reset `auctionStartBlock = 0` and `auctionStartingFee = 0` in the success branch of `endAuction()` (and consistently across `_endAuctionAndRecenter()`).

---

### I-01 — `_accrueBuilderShare` re-computes `_publicFee` already calculated in `getFee` (gas)

**Severity:** Informational (gas)
**Location:** [DynamicFeeAuctionHook.sol:527](../contracts/src/DynamicFeeAuctionHook.sol#L527)

**Description.**
On a bumped swap, the pool calls `getFee` (which computes `_publicFee`) and then `afterSwap` (which calls `_accrueBuilderShare`, which again computes `_publicFee` against reconstructed pre-swap reserves). The redundant computation includes an external call to the Uniswap oracle and to `pool.getDynamicParams()`. Approx 3-5k gas duplicated.

**Recommendation.**
Cache `publicFee` and the swap direction in transient storage (Solidity 0.8.27 supports TSTORE/TLOAD) during `getFee`, and read in `_accrueBuilderShare`. Avoids the recomputation and removes the need to reconstruct pre-swap reserves.

---

### I-02 — No event emitted when a bump is ignored (below public floor)

**Severity:** Informational
**Location:** [DynamicFeeAuctionHook.sol:531](../contracts/src/DynamicFeeAuctionHook.sol#L531)

**Description.**
When `_accrueBuilderShare` finds that `bumped <= publicFee`, the function silently returns. There's no event to indicate the bump was uselessly placed.

Builders monitoring whether their bumps are being effective have no on-chain signal for "I bumped but the floor was higher than my bump."

**Recommendation.**
Emit a `BuilderFeeBelowFloor(address indexed payee, uint256 bumpedFee, uint256 publicFee)` event. Optional, useful for telemetry.

---

### I-03 — Storage struct `BuilderFeeSlot` does not pack optimally with adjacent fields

**Severity:** Informational (gas)
**Location:** [DynamicFeeAuctionHook.sol:118-122](../contracts/src/DynamicFeeAuctionHook.sol#L118-L122)

**Description.**
`BuilderFeeSlot { uint64 blockNumber; uint64 fee; address payee; }` occupies 232 of 256 bits — one full slot.

It could be packed alongside `builderFeeShareBps` (uint16) for a savings of one SLOAD per bumped swap. But that requires consolidating into a single struct read.

**Recommendation.**
Low priority. Either inline shareBps into the slot, or leave as-is and accept the 1 extra SLOAD per bumped swap.

---

### I-04 — `_accrueBuilderShare` assumes unidirectional swap; assumption not asserted

**Severity:** Informational
**Location:** [DynamicFeeAuctionHook.sol:526](../contracts/src/DynamicFeeAuctionHook.sol#L526)

**Description.**
The check `bool asset0IsInput = amount0In > 0` and the pre-reserve reconstruction `preR0 = reserve0 + amount0Out - amount0In` both assume that a swap is unidirectional — exactly one of `amount0In` / `amount1In` is non-zero, and exactly one of `amount0Out` / `amount1Out` is non-zero (matching opposite asset).

This is the current EulerSwap behavior, but if a future protocol version introduces bidirectional swaps (multi-asset swaps, etc.) the accounting would silently mis-attribute.

**Recommendation.**
Add a defensive assertion:

```solidity
require(
    (amount0In > 0) != (amount1In > 0),
    "_accrueBuilderShare: bidirectional swap not supported"
);
```

Or document the assumption in the NatSpec.

---

### I-05 — NatSpec for `setBuilderFee` does not warn smart-contract callers about withdraw semantics

**Severity:** Informational
**Location:** [DynamicFeeAuctionHook.sol:362-374](../contracts/src/DynamicFeeAuctionHook.sol#L362-L374)

**Description.**
When `setBuilderFee` is called from a smart contract, `msg.sender` is that contract. The accrued share is locked to the contract address. If the contract has no `withdrawBuilderShare`-aware exit, the share is permanently orphaned.

Builders integrating via custom contracts must include withdraw logic or use an EOA.

**Recommendation.**
Add a NatSpec line warning that the caller becomes the payee, and that smart-contract callers are responsible for being able to call `withdrawBuilderShare` and receive ERC-20 tokens.

---

## 4. Threat-Model Validation

The design doc ([docs/builder-fee-design.md](builder-fee-design.md)) makes four claims of trustlessness. I validated each against the implementation:

| Claim | Verdict | Notes |
|---|---|---|
| Floor is preserved by construction | ✅ Confirmed | `getFee` returns `max(publicFee, builderFee)`; `_publicFee` extraction is correct. |
| Griefing is unprofitable | ✅ Confirmed | Bumper pays gas; receives nothing unless a swap settles at the bumped fee (which it won't if the bump is set absurdly high). |
| Block-controller wins naturally | ✅ Confirmed | No on-chain authentication of "builder" — ordering wins. |
| Self-trade collusion doesn't pay | ✅ Confirmed | Self-trader pays `bumpedDelta`, receives `shareBps * bumpedDelta / 10000`. Net always negative for `shareBps < 10000`. |

One **caveat** to claim #4: at `shareBps = 10000`, self-trade is exactly break-even (ignoring gas). At `shareBps > 10000` (not currently possible due to validation), it would be profitable. The L-01 finding caps this.

---

## 5. Pre-existing Hook Findings (Brief)

A full re-audit of the pre-existing mechanisms was out of scope, but during the read-through I noted:

- **Oracle safety property holds.** The "fee is monotone non-decreasing in oracle delta" invariant is preserved by the current `_computeNormalFee` implementation. Manipulation of `slot0` to inflate the fee is self-paying.
- **Reentrancy through `pool.reconfigure()` is safe** — the EulerSwap pool is documented to be unlocked during `afterSwap`, and `reconfigure()` is non-reentrant within the same transaction.
- **`endAuction()` retry safety is preserved** by gating state resets on reconfigure success.
- **L-04 above** is the only pre-existing concern I'd raise; the rest of the mechanism is internally consistent with the design doc.

---

## 6. Recommendations Priority

If you can only address a subset:

1. **H-01** — fix immediately. USDT/USDC is a live pool; this breaks the new mechanism for that deployment.
2. **M-02** — document or automate. The "trustless" framing is the main pitch; under-funding contradicts it.
3. **L-01** — one-line fix; prevents the most obvious misconfiguration.
4. **L-03** — one-line fix; eliminates the cheapest denial vector.
5. **I-04** — defensive assertion; cheap.

Everything else is polish.

---

## 7. Disclaimer

This review is the output of a careful AI-assisted single-pass audit, not a professional security engagement. It is intended to surface the kinds of issues a Spearbit or similar firm would flag, at a level useful for a personal-research project that's already publicly disclosing its experimental status. **It does not constitute a security clearance.** A real engagement would include:

- Multi-auditor independent review
- Formal verification of critical invariants
- Property-based / fuzz testing campaigns
- Threat modeling against specific deployment configurations
- Sign-off from the auditing firm

For any deployment with material capital, commission a proper review before relying on this code.
