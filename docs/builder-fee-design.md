# `builderFee` — opportunistic builder-side fee bump

**Status:** implemented in [DynamicFeeAuctionHook.sol](../contracts/src/DynamicFeeAuctionHook.sol). 20 unit tests in [DynamicFeeAuctionHook.t.sol](../contracts/test/DynamicFeeAuctionHook.t.sol) cover the threat-model table below. **Disabled by default** (`builderFeeShareBps = 0`) and **untested in the wild** — no builder has integrated yet.

## How this fits with the other mechanisms — layered LVR defence

The hook's five mechanisms each close a different LVR leak. They're not alternatives competing for "the fee" — they're complementary layers:

| Mechanism | LVR source it defends against | Role if `builderFee` is live and useful |
|---|---|---|
| Fee compass (#1) | Stale public spot vs true fair-value | Backup signal for blocks where no builder bumps |
| Asymmetric fees (#2) | Directional toxicity from arbs against the public price | Can be **relaxed** (lower `captureRate`, looser `attractRate`) since the builder is already pricing in better information |
| Dutch auctions (#3) | Accumulated directional exposure that needs rebalancing | **Still load-bearing** — exposure builds regardless of who set the per-swap fees |
| Curvature surcharge (#4) | Round-trip extraction across recenters | **Still load-bearing** — round-trips are about curve shape, not fee level |
| Builder fee (#5) | The builder's private CEX-DEX signal the public formula can't see | The primary per-swap fee setter when a builder bids |

The properties that stay invariant either way:
- Public floor is always preserved (`max(publicFee, builderFee)`).
- Solvers can always simulate `publicFee` from chain state for routing without talking to any builder.
- Auctions still clear directional exposure; surcharges still protect post-recenter curves.

So if `builderFee` proves itself, mechanisms 1–2 don't get *removed* — they get *parameterized down*, because the builder is closing the same LVR leak more precisely. Mechanisms 3–4 stay where they are. The point is layered defence across distinct leaks, not redundant defences against one.

## Problem

The hook today sets fees from a public Uniswap-spot reference:

```
fee = baseFee + captureRate · max(0, oracleDelta)    (capture side)
fee = max(baseFee, baseFee − attractRate · externalFee)   (attract side)
fee = max(above, auctionFee)                             (during auction)
fee = above + surcharge                                  (post-recenter)
```

This is deliberately defensive — public formula, deterministic, manipulable only by paying the inflated fee yourself. It works well for ordinary solver flow because the fee is a pure view function of public state.

But it leaves money on the table. A block builder with private CEX-DEX signal knows, at the moment the swap is being included, what the *real* fair-value spread is — often much wider than the public Uniswap reference. The hook is currently quoting a fee that reflects only the public reference. The builder's information advantage is being burned.

We'd like to capture some of that.

## Goal

Let any party (in practice, the block builder) **raise** the fee for swaps in a given block, without:

- breaking the solver-friendly property (base fee always remains computable from public state),
- introducing any trust assumption or allowlist,
- ever lowering the quoted fee below the existing public-formula floor.

## Mechanism

One new external function and one storage slot.

```solidity
struct BuilderFeeSlot {
    uint64  blockNumber;   // bump only applies to this block
    uint16  fee;           // 1e6 fixed point, same units as existing maxFee
    address payee;         // receives revenue share on the bumped portion
}

BuilderFeeSlot public builderFee;
uint16 public builderFeeShareBps;   // 0..10000; hook-owner param

function setBuilderFee(uint16 fee) external {
    require(fee <= maxFee, "fee > max");
    builderFee = BuilderFeeSlot({
        blockNumber: uint64(block.number),
        fee: fee,
        payee: msg.sender
    });
    emit BuilderFeeSet(msg.sender, fee, block.number);
}
```

`getFee` becomes `max(currentPublicFee, builderFee)`:

```solidity
function getFee(...) public view returns (uint64) {
    uint256 publicFee = _existingComputation(...);   // unchanged
    if (builderFee.blockNumber == block.number) {
        uint256 b = uint256(builderFee.fee);
        if (b > publicFee) return uint64(b > maxFee ? maxFee : b);
    }
    return uint64(publicFee);
}
```

Revenue split happens in `afterSwap`. We already know the actual fee paid (from the swap deltas); the bumped portion is `actualFee − publicFee` at the time of the swap. Hook pays `payee` `share × bumpedDelta`, retains the rest.

(Implementation detail: `afterSwap` needs to compute the public fee a second time to derive `bumpedDelta`. That's a few hundred gas — the function is already doing larger computations.)

## Why no trust is needed

Four independent reasons the LP can never be made worse off than the no-builder-fee baseline.

### 1. The floor is preserved by construction

`getFee` returns `max(public, builder)`. The public formula is unchanged. Solvers reading the hook's fee see exactly what they'd see today, **or more**. They can still simulate the worst case (highest fee) by computing `min(public(t), maxFee)` over the current and adjacent blocks.

### 2. Griefing is unprofitable

A malicious actor calls `setBuilderFee(maxFee)` to brick swaps in a block.

- Cost: gas for the `setBuilderFee` tx.
- Benefit: only the bumped revenue share, paid by the swap that uses the bumped fee — which won't happen because the fee is too high.
- Net: pay gas, get nothing. Per block. Forever.

This is the same economics that protect Uniswap-spot as a fee compass: a manipulator who inflates the fee pays it on their own swap. Here the manipulator inflates the fee and pays gas instead, but still earns nothing.

### 3. Block-controller wins naturally

The `setBuilderFee` tx and the swap it bumps must appear in the same block, with the bump first. The only party reliably able to win that ordering race is whoever builds the block. So the mechanism's economic surplus accrues to the builder *as a consequence of block construction*, without any need to authenticate them on-chain.

If a non-builder gets a `setBuilderFee` tx in before a swap — fine, they collect the share. The mechanism doesn't care who. The expected steady-state caller is the builder because of access to ordering.

### 4. Self-trade collusion doesn't pay

A builder bumps their own swap by `Δ`, captures `share · Δ` from the hook, pays `Δ` more on the swap. Net: `−(1 − share) · Δ`. Worse than just paying the public fee.

So the only profitable strategy is to bump swaps the builder predicts will *still go through at the higher fee* — i.e., swaps with low fee-elasticity. That's exactly where the LP wants higher fees. The incentives are aligned.

## Threat model

| Attack | Outcome | Defense |
|---|---|---|
| Bump to `maxFee` to brick all swaps in a block | Attacker pays gas, gets nothing. LP loses one block's worth of flow (which they would have gotten at base fee). Sustainable only at sustained gas cost per block — not economic. | Inherent. Optional: rate-limit `setBuilderFee` to one call per block per sender to make the gas cost more visible. |
| Bump just-above-public to extract from inelastic swaps | This is the intended use case. LP captures `(1−share)` of the surplus. | None needed. |
| Bump and front-run a known-large swap | Same as above — surplus flows to LP and bumper. | None needed. |
| Bump using stolen / impersonated builder identity | Cannot — `payee` is `msg.sender`, so revenue goes to whoever actually sent the tx. There is no "builder identity" being trusted. | Inherent. |
| `setBuilderFee` called from a contract that immediately drains via reentry | `setBuilderFee` writes only one packed slot. No external calls. Reentrancy irrelevant. | Inherent. |
| Bump persists across blocks | Cannot — `blockNumber` check in `getFee` discards stale slots. | Inherent. |
| Builder colludes with swapper to set artificially low fee | Cannot — `getFee` returns `max(public, builder)`, never lower. | Inherent. |

The only *legitimate* operational concern is: a builder who can predict pool flow can use this to price-discriminate. That's the *purpose* — capture the discrimination economics for the LP via the share.

## Engineering notes

**Storage.** One 256-bit slot is enough (`uint64 + uint16 + address = 232 bits`, packs into one slot with room to spare).

**Gas.** `setBuilderFee` is one SSTORE. `getFee` adds one SLOAD + one branch in the public-fee-only path. `afterSwap` adds one SLOAD + one branch + (on a bumped swap only) one CALL to send the share to the payee.

**Same-block ordering.** V4's `getFee` is called inside the swap. The bump must therefore be a separate transaction earlier in the block. This is how builders already operate — bundling pre-swap state updates with the swap they're influencing is standard MEV plumbing.

**Multiple swaps per block.** The current sketch lets one bump apply to every swap in the same block. If we want per-swap bumps, the bump should be consumed (e.g., zero the fee field after the first use). Probably not worth the complication — per-block is fine and lets the builder cover a sequence of related swaps with one tx.

**Owner controls.** `builderFeeShareBps` is the only new hook parameter. Setter is `onlyOwner`. Default `0` means the mechanism is dormant (nobody bumps because nobody captures anything).

**Disable switch.** Setting `builderFeeShareBps = 0` effectively disables the mechanism. Setting `maxFee` low caps the harm of any single bump. No new emergency path needed.

## Composition with existing mechanisms

The builder fee composes cleanly:

- **vs. oracle-reactive fee.** Both are floors on the quoted fee; we take the max. No interaction.
- **vs. attract-side discount.** The attract-side computation lowers `publicFee` below `baseFee` (toward but never under). Builder can still bump on top. If the bump is taken, the LP captures the share — *better* than the baseline where retail just gets a discounted fee.
- **vs. surcharge.** Surcharge is part of `publicFee`. Builder fee composes by `max`. No interaction.
- **vs. clearing auction.** Auction sets `publicFee` to a high decaying value. Builder can still bump above it, though the auction fee will usually dominate. The bumped portion above the auction fee is shared.

In each case the existing mechanism remains the **lower bound** on the fee. Nothing about builder bumps changes the auction state machine, recenter logic, or any of the existing invariants.

## What this is not

- **Not** a propAMM — there's no off-chain quoter, no signed message, no builder integration code. Just one extra storage slot.
- **Not** a builder allowlist — anyone can call `setBuilderFee`. The natural winner is the block builder *because of block construction*, not because of authentication.
- **Not** a replacement for the oracle. The Uniswap-spot reference still defines the base; this just lets someone with better information bid the fee up.

## Open questions

1. **Share calibration.** What's the right `builderFeeShareBps`? Too low and no builder bothers; too high and the LP gives away most of the surplus. Probably needs to be measured on a live deployment with a sweep.
2. **Should `setBuilderFee` accept a deadline?** If a builder bumps in block N intending it for a specific swap but their tx gets re-orged into block N+1, the bump applies to a different set of swaps. Trivial defence: pass `(targetBlockNumber, fee)` and require `targetBlockNumber == block.number`. Costs one calldata word.
3. **Should the share be paid in-kind or in the input/output asset?** Cleanest is to keep the fee accounting unchanged (fees stay in the pool's accounting) and pay the share out of the pool's accumulated fee balance on a periodic basis. Avoids one external transfer per swap. Slight bookkeeping cost.
4. **Interaction with non-EulerSwap swaps?** This mechanism is hook-local; no global state. Other pools running other hooks see no effect.

## Implementation size

Actual changes in [DynamicFeeAuctionHook.sol](../contracts/src/DynamicFeeAuctionHook.sol):

- `BuilderFeeSlot` struct + storage slot, `builderFeeShareBps` param, `builderShareAccrued` ledger
- `setBuilderFee(uint64)` — permissionless, caller becomes payee
- `setBuilderFeeShareBps(uint16)` — `onlyOwner` (defaults to 0 = dormant)
- `withdrawBuilderShare(address asset)` — payee pulls accrued share; reverts if hook underfunded
- `getFee` refactored to use internal `_publicFee` helper; returns `max(public, builder)`
- `_accrueBuilderShare` called first in `afterSwap`, reconstructs pre-swap reserves from deltas
- `IERC20Minimal` interface added for the withdraw transfer

Total: ~70 LOC of hook code, ~280 LOC of tests (20 cases covering the threat-model table). No external dependencies beyond a minimal IERC20 interface.

## Operational notes

- **Defaults to dormant.** `builderFeeShareBps` is 0 at deploy. Nobody can earn share until the owner enables it. Once enabled, anyone can bump.
- **Funding the hook.** The hook accrues share to a ledger but does not pull tokens from the pool — fees stay in the LP's accruals. To honour `withdrawBuilderShare`, the LP owner must transfer the corresponding asset balance into the hook contract. A practical pattern is to top up the hook periodically based on emitted `BuilderShareAccrued` events.
- **Disable in emergencies.** Setting `builderFeeShareBps = 0` halts new accruals immediately. Existing accrued balances remain claimable.
