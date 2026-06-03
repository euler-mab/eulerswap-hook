// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {
    IEulerSwapHookTarget,
    EULER_SWAP_HOOK_GET_FEE
} from "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @title MinimalHook — the smallest useful EulerSwap hook
/// @notice Returns a constant fee for every swap. Nothing else.
///
/// This is the pedagogical starting point for building your own hook. Once you
/// understand the wiring, fork this contract and add the mechanisms you need:
///
///   - **Oracle-reactive fee**: read Uniswap V3 `slot0` or V4 `extsload` and
///     bump the fee when the AMM is offering an arb against itself. See
///     `DynamicFeeAuctionHook._dynamicFee()` for a reference implementation.
///
///   - **Rebalancing auctions**: implement `afterSwap` (add the
///     `EULER_SWAP_HOOK_AFTER_SWAP` flag) and call `IEulerSwap.reconfigure`
///     from inside it. The pool is unlocked during `afterSwap`, so the hook
///     can rebalance without an off-chain agent.
///
///   - **Recenter surcharge**: track when you last recentered and add a
///     decaying additive fee to prevent round-trip extraction.
///
/// To bind this hook, set the pool's `swapHookedOperations` to
/// `EULER_SWAP_HOOK_GET_FEE` (0x02). If you add `afterSwap`, set it to
/// `EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP` (0x06).
contract MinimalHook is IEulerSwapHookTarget {
    /// @notice Fee returned for every swap, in WAD (1e18 = 100%).
    /// Example: 5e14 = 0.05% = 5 bps.
    uint64 public immutable fee;

    constructor(uint64 _fee) {
        fee = _fee;
    }

    function beforeSwap(uint256, uint256, address, address) external pure override {
        revert("beforeSwap not enabled");
    }

    function getFee(bool, uint112, uint112, bool) external view override returns (uint64) {
        return fee;
    }

    function afterSwap(
        uint256, uint256, uint256, uint256, uint256, uint256, address, address, uint112, uint112
    ) external pure override {
        revert("afterSwap not enabled");
    }
}
