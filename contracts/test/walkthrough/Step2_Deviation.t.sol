// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {WalkthroughBase} from "./WalkthroughBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {console} from "forge-std/Test.sol";

/// @title Step2_Deviation
/// @notice Tests for walkthrough Step 2: measuring deviation from target,
///         clearing swaps, fee residual, and oracle dependency.
///
/// Key claims tested:
/// - Swap flow changes vault composition: one side grows, the other shrinks
/// - The clearing swap is the trade that moves vault from current to target
/// - For c=1, clearing cost = clearingAmount / (1 - feeRate)
/// - For c<1, clearing cost includes curve spread on top of fees
/// - Fee residual (feeRecipient=0) is inaccessible via swaps
contract Step2_Deviation is WalkthroughBase {

    // ════════════════════════════════════════════════════════════════════
    // 2a. Swap flow changes vault composition
    // ════════════════════════════════════════════════════════════════════

    /// @notice Asset0 inflow increases deposits0 (or repays debts0),
    ///         decreases deposits1 (or increases debts1).
    function test_2a_swap_changes_vault_composition() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        VaultState memory before = _readVault(sp);

        // Swap asset0 in
        _doSwap(pool, true, 1e18);

        VaultState memory after_ = _readVault(sp);

        // Net asset0 position should increase (more deposits or less debt)
        int256 net0Before = int256(before.deposits0) - int256(before.debts0);
        int256 net0After = int256(after_.deposits0) - int256(after_.debts0);
        assertTrue(net0After > net0Before, "asset0 in: net0 increased");

        // Net asset1 position should decrease (less deposits or more debt)
        int256 net1Before = int256(before.deposits1) - int256(before.debts1);
        int256 net1After = int256(after_.deposits1) - int256(after_.debts1);
        assertTrue(net1After < net1Before, "asset0 in: net1 decreased");
    }

    /// @notice Directional flow builds one-sided exposure that accumulates.
    function test_2a_directional_flow_builds_exposure() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        VaultState memory init = _readVault(sp);
        int256 initNet0 = int256(init.deposits0) - int256(init.debts0);

        // 5 directional swaps: all asset0 in
        for (uint256 i = 0; i < 5; i++) {
            _doSwap(pool, true, 0.3e18);
        }

        VaultState memory final_ = _readVault(sp);
        int256 finalNet0 = int256(final_.deposits0) - int256(final_.debts0);

        // Exposure accumulated: net0 grew significantly
        int256 exposure = finalNet0 - initNet0;
        assertTrue(exposure > 0, "directional flow: exposure accumulated");

        // The pool now holds more asset0 than it started with
        // and has borrowed/reduced asset1
        console.log("Exposure (asset0 net increase):", uint256(exposure));
    }

    // ════════════════════════════════════════════════════════════════════
    // 2b/2c. Clearing swap: drains deviation back to target
    // ════════════════════════════════════════════════════════════════════

    /// @notice Constant-sum clearing: cost = clearingAmount / (1 - feeRate). Exact.
    function test_2c_clearing_cost_constant_sum_exact() public {
        uint64 fee = 0.01e18;
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, fee, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Build exposure: asset1 in
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.3e18);
        }

        VaultState memory before = _readVault(sp);
        _logVault("Before clearing", before);

        // Clearing direction: send asset0 in to drain deposits1
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 clearingAmount = before.deposits1 < outLimit ? before.deposits1 : outLimit;

        // Walkthrough claim: grossIn = clearingAmount / (1 - fee)
        uint256 expectedGrossIn = clearingAmount * 1e18 / (1e18 - fee);
        uint256 actualGrossIn = pool.computeQuote(
            address(assetTST), address(assetTST2), clearingAmount, false
        );

        assertApproxEqAbs(actualGrossIn, expectedGrossIn, 1, "constant-sum clearing cost exact");
    }

    /// @notice Constant-sum clearing fully drains deposits on one side.
    function test_2c_clearing_drains_target_side() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.3e18);
        }

        VaultState memory before = _readVault(sp);

        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 clearingAmount = before.deposits1 < outLimit ? before.deposits1 : outLimit;

        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), clearingAmount, false);

        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, clearingAmount, swapper, "");

        VaultState memory after_ = _readVault(sp);
        _logVault("After clearing", after_);

        assertLe(after_.deposits1, 1, "deposits1 fully drained");
        assertEq(after_.debts1, 0, "no debts1");
        assertTrue(after_.deposits0 > 0, "all equity in asset0");
    }

    /// @notice Clearing works in both directions (symmetric).
    function test_2c_clearing_symmetric_both_directions() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Build asset0 exposure
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, true, 0.3e18);
        }

        VaultState memory before = _readVault(sp);

        // Clear in opposite direction: asset1 in to drain deposits0
        (, uint256 outLimit) = pool.getLimits(address(assetTST2), address(assetTST));
        uint256 clearingAmount = before.deposits0 < outLimit ? before.deposits0 : outLimit;

        uint256 grossIn = pool.computeQuote(address(assetTST2), address(assetTST), clearingAmount, false);

        assetTST2.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST2.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(clearingAmount, 0, swapper, "");

        VaultState memory after_ = _readVault(sp);

        assertLe(after_.deposits0, 1, "deposits0 fully drained (reverse direction)");
        assertTrue(after_.deposits1 > 0, "all equity in asset1");
    }

    /// @notice Curved pool clearing costs more than constant-sum (curve spread).
    function test_2c_curved_clearing_costs_more_than_cs() public {
        uint64 fee = 0.01e18;

        // Constant-sum pool
        (EulerSwap csPool,) = _createPool(10e18, 10e18, fee, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Build same exposure on both
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(csPool, false, 0.2e18);
        }

        VaultState memory csBefore = _readVault(csPool.getStaticParams());
        uint256 csClearingAmt = csBefore.deposits1 / 2;
        uint256 csGrossIn = csPool.computeQuote(address(assetTST), address(assetTST2), csClearingAmt, false);

        // Now create a curved pool and build same exposure
        (EulerSwap curvedPool,) = _createPool(10e18, 10e18, fee, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(curvedPool, false, 0.2e18);
        }

        // Use same clearing amount (may differ slightly due to different outputs)
        uint256 curvedGrossIn = curvedPool.computeQuote(address(assetTST), address(assetTST2), csClearingAmt, false);

        assertTrue(curvedGrossIn > csGrossIn, "curved pool: clearing costs more than constant-sum");
        console.log("Constant-sum grossIn:", csGrossIn);
        console.log("Curved grossIn:      ", curvedGrossIn);
        console.log("Curve spread:        ", curvedGrossIn - csGrossIn);
    }

    /// @notice Curve spread from clearing accrues to LP as NAV.
    function test_2c_curve_spread_accrues_as_nav() public {
        uint64 fee = 0.01e18;
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, fee, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.2e18);
        }

        VaultState memory before = _readVault(sp);
        int256 navBefore = _nav(before);

        // Partial clear
        uint256 clearAmt = before.deposits1 / 2;
        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), clearAmt, false);

        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, clearAmt, swapper, "");

        VaultState memory after_ = _readVault(sp);
        int256 navAfter = _nav(after_);

        // NAV increased because curve spread went to the pool (fees went to collector)
        assertTrue(navAfter > navBefore, "NAV increased from curve spread");
        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after: ", uint256(navAfter));
        console.log("NAV gain:  ", uint256(navAfter - navBefore));
    }

    /// @notice Constant-sum clearing preserves NAV exactly (no curve spread).
    function test_2c_constant_sum_preserves_nav() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.2e18);
        }

        VaultState memory before = _readVault(sp);
        int256 navBefore = _nav(before);

        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 clearAmt = before.deposits1 < outLimit ? before.deposits1 : outLimit;
        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), clearAmt, false);

        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, clearAmt, swapper, "");

        VaultState memory after_ = _readVault(sp);
        int256 navAfter = _nav(after_);

        // With c=1 + feeRecipient: no curve spread, fees leave. NAV unchanged.
        assertApproxEqAbs(uint256(navAfter), uint256(navBefore), 1, "constant-sum NAV unchanged");
    }

    // ════════════════════════════════════════════════════════════════════
    // 2d. Fee residual (feeRecipient = address(0))
    // ════════════════════════════════════════════════════════════════════

    /// @notice When feeRecipient=0, fees stay in vault creating deposits > reserves gap.
    ///         The fee residual is NOT accessible via swaps.
    function test_2d_fee_residual_inaccessible_via_swaps() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, address(0));

        // Build fee residual via directional swaps
        for (uint256 i = 0; i < 5; i++) {
            _doSwap(pool, false, 0.3e18);
        }

        VaultState memory v = _readVault(sp);
        (, uint112 reserve1,) = pool.getReserves();

        // deposits1 > reserve1 because fees are in vault but not in reserves
        uint256 feeResidual = v.deposits1 - uint256(reserve1);
        assertTrue(feeResidual > 0, "fee residual exists");

        // The swap can drain at most reserve1 worth of asset1
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertTrue(outLimit <= uint256(reserve1), "outLimit bounded by reserves, not deposits");

        // After draining all available reserves, fee residual remains
        uint256 drainAmount = uint256(reserve1) < outLimit ? uint256(reserve1) : outLimit;
        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), drainAmount, false);

        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, drainAmount, swapper, "");

        VaultState memory after_ = _readVault(sp);

        // Fee residual remains in vault — inaccessible via swaps
        assertApproxEqAbs(
            after_.deposits1,
            feeResidual + (uint256(reserve1) - drainAmount),
            2,
            "fee residual remains after draining reserves"
        );

        console.log("Fee residual:    ", feeResidual);
        console.log("Remaining dep1:  ", after_.deposits1);
    }

    // ════════════════════════════════════════════════════════════════════
    // 2f. Interest drift (vault changes without reserve changes)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Vault interest changes deposits/debts without moving reserves.
    ///         The reserve-coordinate trigger cannot detect this.
    function test_2f_interest_changes_vault_not_reserves() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Build some debt by swapping
        _doSwap(pool, true, 2e18);

        (uint112 r0Before, uint112 r1Before,) = pool.getReserves();
        VaultState memory vBefore = _readVault(sp);

        // Advance time to accrue interest
        vm.warp(block.timestamp + 365 days);

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        VaultState memory vAfter = _readVault(sp);

        // Reserves unchanged (no swaps occurred)
        assertEq(r0After, r0Before, "reserves0 unchanged after time");
        assertEq(r1After, r1Before, "reserves1 unchanged after time");

        // But vault state changed (interest accrued on debts)
        // The pool has borrowed asset1, so debts1 should have grown
        if (vBefore.debts1 > 0) {
            assertTrue(vAfter.debts1 > vBefore.debts1, "debts grew from interest");
            console.log("Debt before:", vBefore.debts1);
            console.log("Debt after: ", vAfter.debts1);
            console.log("Interest:   ", vAfter.debts1 - vBefore.debts1);
        }

        // Deposits may also have grown (interest on supply)
        if (vBefore.deposits0 > 0) {
            assertTrue(vAfter.deposits0 >= vBefore.deposits0, "deposits grew from interest");
        }
    }
}
