# OpenZeppelin-Style Audit — DynamicFeeAuctionHook (Follow-up)

**Date:** 2026-06-04
**Auditor:** independent review (AI-assisted, single-pass)
**Scope:** [`contracts/src/DynamicFeeAuctionHook.sol`](../contracts/src/DynamicFeeAuctionHook.sol) at commit `81bb94680` — verifies the audit-fix patches in [docs/security-audit-2026-06.md](security-audit-2026-06.md) and looks for issues not covered by the prior review.
**Status:** experimental, unaudited reference code. **Not a substitute for a professional engagement.** This is an internal follow-up that simulates a second, independent audit pass with a different perspective.

---

## Executive Summary

The prior internal audit identified 13 issues and fixed 9. This follow-up:

1. **Verifies the 9 fixes** for correctness and completeness.
2. **Examines new attack surface** introduced by the fixes (`_safeTransfer`, `batchSettleBuilderShare`, the `(amount0In==0) != (amount1In==0)` assertion).
3. **Surveys areas the prior audit did not cover deeply** — owner privilege scope, oracle failure modes, `approxNav` staleness, reentrancy via callback tokens.

### Verification of prior fixes

| Prior ID | Fix Verified? | Notes |
|---|---|---|
| H-01 (USDT-safe transfer) | ✅ Mostly | New M-01 below: missing contract-existence check. |
| M-03 (batchSettleBuilderShare) | ✅ | New L-02 below: unbounded loop. |
| L-01 (shareBps ≤ 8000) | ✅ | Clean. |
| L-02 (FullMath precision) | ✅ | Overflow bounds checked; safe. |
| L-03 (reject zero-fee bumps) | ⚠️ Bypassable | New L-01 below: `fee = 1` achieves the same outcome. |
| L-04 (reset auction state) | ✅ | Applied in both `endAuction()` and `_endAuctionAndRecenter()`. |
| I-02 (BuilderFeeBelowFloor event) | ✅ | Emitted correctly; tested via log inspection. |
| I-04 (unidirectional assertion) | ⚠️ Brittle | New L-03 below: reverts the swap rather than silently skipping. |
| I-05 (NatSpec smart-contract warning) | ✅ | Clean. |

### New Findings Summary

| ID | Title | Severity |
|---|---|---|
| M-01 | `_safeTransfer` does not verify token contract existence | Medium |
| L-01 | `setBuilderFee` zero-fee check is bypassable with `fee = 1` | Low |
| L-02 | `batchSettleBuilderShare` is an unbounded loop | Low |
| L-03 | Unidirectional-swap assertion reverts the swap instead of silently skipping | Low |
| N-01 | ERC-777 callback tokens enable in-callback re-entry into setBuilderFee + swap | Note |
| N-02 | No reentrancy guard on `withdrawBuilderShare` and `batchSettleBuilderShare` | Note |
| N-03 | Pre-existing: `approxNav` can grow stale across many swaps without recenter | Note |
| N-04 | Pre-existing: owner can change all fee/auction params atomically with no announcement | Note |
| N-05 | Missing convenience view `isCurrentlyBumped() returns (bool, address, uint64)` | Note |

**0 Critical, 0 High, 1 Medium, 3 Low, 5 Notes.**

---

## Detailed Findings

### M-01 — `_safeTransfer` does not verify token contract existence

**Severity:** Medium
**Location:** [DynamicFeeAuctionHook.sol:398-402](../contracts/src/DynamicFeeAuctionHook.sol#L398-L402)

**Description.**
The newly-added `_safeTransfer` helper accepts an empty-returndata case to handle USDT-style tokens. OpenZeppelin's `SafeERC20` pattern explicitly checks `address(token).code.length > 0` in this case to distinguish a real USDT-style token from an EOA or a self-destructed contract. The current implementation does not perform this check:

```solidity
(bool ok, bytes memory data) =
    token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
```

A call to an EOA returns `ok = true` with `data.length == 0`. The require passes. The withdrawal **appears** successful (event emitted, ledger zeroed) but no tokens move.

**Reachability.**
- Currently **not exploitable**. `asset0` and `asset1` are immutable and set from `IEVault(supplyVault).asset()` at construction — a real ERC-20 contract.
- In `batchSettleBuilderShare`, the `asset` is owner-controlled, but the owner has no incentive to pass a wrong asset, and the ledger entries for a wrong asset are always zero.
- In `withdrawBuilderShare`, the `asset` is caller-controlled but again the ledger entries for an arbitrary asset are always zero (no accrual path exists for non-pool assets).
- A theoretical edge case: if a pool's underlying asset is a contract that later self-destructs (largely prevented by EIP-6780 post-Cancun), the withdraw would silently zero the ledger without transferring tokens.

**Recommendation.**
Add the contract-existence check, mirroring OpenZeppelin's pattern:

```solidity
function _safeTransfer(address token, address to, uint256 amount) internal {
    (bool ok, bytes memory data) =
        token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
    require(ok, "transfer failed");
    if (data.length == 0) {
        require(token.code.length > 0, "token is not a contract");
    } else {
        require(abi.decode(data, (bool)), "transfer returned false");
    }
}
```

Defense in depth. Cost: one EXTCODESIZE (~100 gas) per withdraw on the empty-return path.

---

### L-01 — `setBuilderFee` zero-fee check is bypassable with `fee = 1`

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:373-382](../contracts/src/DynamicFeeAuctionHook.sol#L373-L382)

**Description.**
The prior L-03 fix added `require(fee > 0, "builder fee == 0")` to prevent "ledger pollution via zero-fee bumps." However, an attacker can achieve the same outcome (overwriting an earlier bump in the same block) by setting `fee = 1`:

- `fee = 1` is below any realistic public floor (`baseFee` is typically 5e14–25e14, i.e. 5–25 bps in 1e18 fixed point; `fee = 1` is 1 atto).
- `getFee()` returns `max(publicFee, 1) = publicFee` — bump effectively ignored.
- `_accrueBuilderShare` emits `BuilderFeeBelowFloor` and returns without accrual.
- The slot is still overwritten with the new payee + blockNumber, displacing any earlier real bump in the same block.

So the fix prevents the literal-zero case but does not prevent the underlying "free cancellation" behavior. Gas cost to cancel via `fee=1` is identical to `fee=0` (one SSTORE).

**Impact.**
Minimal: the fix is API-hygiene, not a security boundary. Anyone can already disrupt an earlier bump by setting their own bump at any value. The audit's earlier framing of L-03 as "ledger pollution prevention" was over-promising.

**Recommendation.**
Either:
1. Remove the require entirely and document that any party can overwrite the bump (the design's actual intent), or
2. Require `fee >= baseFee` — meaningfully prevents below-floor bumps from displacing real ones.

Option 2 is the more substantive fix. It also removes the need for the `BuilderFeeBelowFloor` event branch.

---

### L-02 — `batchSettleBuilderShare` is an unbounded loop

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:412-423](../contracts/src/DynamicFeeAuctionHook.sol#L412-L423)

**Description.**
The newly-added migration helper accepts an array of arbitrary length:

```solidity
function batchSettleBuilderShare(address[] calldata payees, address asset) external onlyOwner {
    for (uint256 i; i < payees.length; ++i) { ... }
}
```

If an oversized array is passed (operator misconfiguration or accidental copy-paste), the call will run out of gas and revert. The operator loses the gas spent up to the OOG point. Atomicity is preserved (revert reverses all state), so no partial settlement happens.

**Impact.**
Operator footgun. No security boundary crossed. The function is `onlyOwner`, so an attacker cannot trigger this against the operator.

**Recommendation.**
Either cap the input array length explicitly:

```solidity
require(payees.length <= 256, "batch too large");
```

…or document that the operator must call in reasonably-sized batches (e.g., 50–100 payees per call). The cap is cheaper and self-enforcing.

---

### L-03 — Unidirectional-swap assertion reverts the swap instead of silently skipping

**Severity:** Low
**Location:** [DynamicFeeAuctionHook.sol:519-522](../contracts/src/DynamicFeeAuctionHook.sol#L519-L522)

**Description.**
The prior I-04 fix added a defensive assertion:

```solidity
require((amount0In == 0) != (amount1In == 0), "non-unidirectional swap");
```

If the pool ever calls `afterSwap` with both `amount0In == 0` and `amount1In == 0` (or both non-zero), the swap will revert. Notably, this assertion only fires when:
1. A builder fee is set for the current block
2. `builderFeeShareBps != 0`

So in the common case (no builder activity), an unexpected swap shape would be ignored. With builder activity active, the same swap reverts. This creates a **state-dependent revert** — the same swap succeeds or fails based on whether someone happened to bump the builder fee.

**Impact.**
Defensive assertions that revert the swap are net-negative when the alternative is "silently skip the accrual." A future EulerSwap protocol upgrade or a corner case in fee accounting (e.g., 0-amount swap, multi-asset settlement) would break swap availability for any block where a builder bumped.

**Recommendation.**
Replace the `require` with a graceful early-return:

```solidity
// EulerSwap swaps are expected to be unidirectional. If they aren't,
// skip the accrual rather than reverting the swap.
if ((amount0In == 0) == (amount1In == 0)) return;
```

This preserves the safety property (no incorrect accrual) without making swap availability state-dependent.

---

### N-01 — ERC-777 callback tokens enable in-callback re-entry

**Severity:** Note
**Location:** [DynamicFeeAuctionHook.sol:388-394](../contracts/src/DynamicFeeAuctionHook.sol#L388-L394) and [DynamicFeeAuctionHook.sol:412-423](../contracts/src/DynamicFeeAuctionHook.sol#L412-L423)

**Description.**
`withdrawBuilderShare` and `batchSettleBuilderShare` both call `_safeTransfer`, which makes an external call to the token contract. ERC-777-style tokens (or any token with `tokensReceived` callback semantics) invoke the recipient after balance changes. Inside that callback, the recipient could:

- Call `setBuilderFee()` again — affects only future blocks, not the in-progress withdraw.
- Initiate another swap via the pool — would trigger `afterSwap` → `_accrueBuilderShare`, which sees a new bump if the callback set one.
- Re-enter `withdrawBuilderShare` — CEI is followed, so the ledger is already zeroed; this branch is a no-op.

No exploit is reachable, but the cumulative behavior is more permissive than a naive reading suggests.

**Recommendation.**
Document the ERC-777 interaction explicitly in `docs/builder-fee-design.md`. Optionally, add `nonReentrant` guards (see N-02 below) — this would block the callback path mechanically.

---

### N-02 — No reentrancy guard on `withdrawBuilderShare` and `batchSettleBuilderShare`

**Severity:** Note
**Location:** [DynamicFeeAuctionHook.sol:388-394](../contracts/src/DynamicFeeAuctionHook.sol#L388-L394), [DynamicFeeAuctionHook.sol:412-423](../contracts/src/DynamicFeeAuctionHook.sol#L412-L423)

**Description.**
Both functions perform external token-transfer calls and could theoretically reach a callback-token re-entry path. The current implementation relies on CEI ordering (ledger zeroed before transfer). Analysis above (N-01) confirms no exploit is reachable, but the code does not have explicit guards.

OpenZeppelin's standard practice is to add `nonReentrant` to any function that makes an external token call, as defense in depth.

**Recommendation.**
Add `nonReentrant` modifiers (importing `ReentrancyGuard` from OZ or implementing a minimal version). Cost: 2.1k gas per call for the guard's storage check. Worth the safety margin.

---

### N-03 — Pre-existing: `approxNav` can grow stale across many swaps without recenter

**Severity:** Note
**Location:** General hook behavior — see `_handleNormalMode` and `_cacheVaultState`.

**Description.**
The hook caches NAV (`cachedNav`) only at recenter time. Between recenters, the cached value drifts from the true NAV as vault interest accrues. The auction trigger threshold (`auctionTriggerThreshold`) compares against this cached value.

If NAV has grown since the cache was set:
- Relative exposure denominator is artificially low
- Auction triggers prematurely (more often than intended)

If NAV has shrunk (rare — implies losses faster than fees):
- Relative exposure denominator is artificially high
- Auction triggers too late

The owner has `refreshVaultState()` to manually correct.

**Recommendation.**
Consider an automatic cache refresh after N blocks (e.g., every 100 blocks worth of swaps) inside `_handleNormalMode`. Cost: extra vault reads. Or document the staleness clearly so operators know when to call `refreshVaultState()`.

---

### N-04 — Pre-existing: owner can change all fee/auction params atomically

**Severity:** Note
**Location:** All `setXxxParams` setters.

**Description.**
The owner can call `setFeeParams`, `setAuctionParams`, `setRecenterParams`, `setSurchargeParams`, and `setBuilderFeeShareBps` at any time, with no announcement and no delay. Between two swaps in the same block (or across blocks), the entire hook configuration can change.

For a single-LP design where the owner IS the LP, this is expected: the operator controls their own pool. For an integration partner (e.g., LiquidMesh's solver), it means the fee they quoted against may not match the fee they execute against if the owner front-runs.

**Recommendation.**
Two-tier mitigation:
1. **For aggregators**: document that `getFee()` should be re-queried at execution time, not cached from quote time.
2. **For governance**: consider adding a timelock on the most disruptive setters (e.g., `setFeeParams`, `setAuctionParams`) if multi-party trust ever becomes a goal. Out of scope for a single-LP design.

---

### N-05 — Missing convenience view `isCurrentlyBumped()`

**Severity:** Note
**Location:** N/A — feature suggestion.

**Description.**
Off-chain monitors and aggregators need to know whether the current block has an active builder bump. Currently this requires reading the public `builderFeeSlot()` getter and comparing `blockNumber` to `block.number`. A small convenience view would simplify integrations:

```solidity
function isCurrentlyBumped() external view returns (bool active, address payee, uint64 fee) {
    BuilderFeeSlot memory s = builderFeeSlot;
    if (s.blockNumber == uint64(block.number)) {
        return (true, s.payee, s.fee);
    }
    return (false, address(0), 0);
}
```

**Recommendation.**
Add the view. Pure quality-of-life; not a correctness issue.

---

## Comments on Acknowledged Findings (M-01, M-02, I-01, I-03 from prior audit)

The prior audit marked four findings as Acknowledged. Re-examining:

- **Prior M-01 (timelock on `shareBps`)**: I agree with the acknowledgment. For a single-LP hook, owner-trust is inherent; adding a timelock is heavier than warranted. The N-04 finding above generalizes the concern to *all* params.
- **Prior M-02 (operator funding trust)**: Stands. The mechanism is documented in `docs/builder-fee-design.md`. A future automated-funding path via direct vault integration is the right long-term answer.
- **Prior I-01 (transient storage caching)**: Stands. Gas optimization, not correctness.
- **Prior I-03 (storage packing)**: Stands. Minor.

---

## Test Coverage Observations

The test suite (162 unit + 16 fork) covers the threat-model rows from the prior audit and the new audit-fix behaviors well. Notable gaps:

1. **No fuzzing**: shape of swap inputs (amount0In, amount1In, amount0Out, amount1Out) is not fuzzed against `_accrueBuilderShare`. A small Foundry invariant suite would surface edge cases.
2. **No mainnet-fork test for the `batchSettleBuilderShare` migration path** — only unit tests with mock tokens.
3. **No test for high-volume `batchSettleBuilderShare` to validate the gas-bound concern from L-02.**

These are not findings per se — coverage is reasonable for an experimental contract. They're improvement directions.

---

## Overall Posture

**Improvement since prior audit:** substantial. The H-01 USDT issue was the biggest known risk and is resolved (modulo M-01 above). The mechanism's trust model is now consistent across implementation and documentation.

**Remaining risk surface:** dominated by operator-trust (M-01 acknowledged, M-02 documented, N-04 inherent to single-LP). The hook is fit for the personal-research, single-operator context it was designed for. **It is not suitable as-is for a multi-party shared deployment** without addressing the timelock, funding-automation, and reentrancy-guard concerns above.

**Recommendation prioritization (if you fix only a subset):**

1. **M-01** — one-line addition; closes a defensive gap.
2. **L-03** — one-line change; eliminates state-dependent revert.
3. **N-02** — reentrancy guard; defense in depth.
4. **L-02** — array-length cap; one-line.
5. **N-05** — convenience view; QoL.

Everything else is judgment-call territory.

---

## Disclaimer

Same disclaimer as the prior audit. This is an AI-assisted simulated second-opinion audit, not a professional engagement. It surfaces the kinds of issues an OZ-style firm would flag, with the perspective shifted from the prior review. **It does not constitute a security clearance.** For material capital, commission a real audit.
