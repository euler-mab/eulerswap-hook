// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {console} from "forge-std/Test.sol";

/// @notice Verifies that we can compute and execute swaps that move the vault
/// toward a target state (e.g., 100% asset0, zero debts).
///
/// This tests the "clearing swap" concept from docs/auction-walkthrough.md Step 2:
/// given the current vault state and a target vault state, compute the swap that
/// bridges the gap.
///
/// The clearing swap operates on VAULT composition (deposits and debts), not on
/// virtual reserves. Even without leverage or debt, swap flow changes the vault's
/// asset mix — one side's deposits grow while the other's shrink. The auction's
/// job is to attract flow that rebalances this composition back to the LP's target.
///
/// In production pools with concentrated liquidity (tight range), the virtual
/// reserves are much larger than the actual equity, so the clearing swap is a
/// small perturbation on the curve — well within its capacity.
///
/// Key findings:
///
/// 1. For constant-sum (c = 1), the clearing cost is exactly:
///    grossIn = clearingAmount / (1 - feeRate). No curve spread.
///
/// 2. For curved pools (c < 1), the clearing cost includes curve spread
///    (price impact) on top of fees. This spread accrues to the LP as NAV.
///
/// 3. When feeRecipient == address(0), vault deposits exceed reserves by
///    accumulated fees. This fee residual is not accessible via swaps — it
///    requires recentering or direct withdrawal.
contract ClearingSwapTest is EulerSwapTestBase {
    address swapper;
    address feeCollector;

    function setUp() public override {
        super.setUp();
        swapper = makeAddr("swapper");
        feeCollector = makeAddr("feeCollector");
    }

    // --- Helpers ---

    struct VaultState {
        uint256 deposits0;
        uint256 deposits1;
        uint256 debts0;
        uint256 debts1;
    }

    function _readVault(IEulerSwap.StaticParams memory sp) internal view returns (VaultState memory v) {
        address account = sp.eulerAccount;
        uint256 s0 = IEVault(sp.supplyVault0).balanceOf(account);
        v.deposits0 = s0 == 0 ? 0 : IEVault(sp.supplyVault0).convertToAssets(s0);
        uint256 s1 = IEVault(sp.supplyVault1).balanceOf(account);
        v.deposits1 = s1 == 0 ? 0 : IEVault(sp.supplyVault1).convertToAssets(s1);
        v.debts0 = IEVault(sp.borrowVault0).debtOf(account);
        v.debts1 = IEVault(sp.borrowVault1).debtOf(account);
    }

    function _doSwap(EulerSwap pool, bool asset0In, uint256 amount) internal {
        if (asset0In) {
            assetTST.mint(swapper, amount);
            vm.prank(swapper);
            assetTST.transfer(address(pool), amount);
            uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), amount, true);
            require(quote > 0, "quote zero");
            vm.prank(swapper);
            pool.swap(0, quote, swapper, "");
        } else {
            assetTST2.mint(swapper, amount);
            vm.prank(swapper);
            assetTST2.transfer(address(pool), amount);
            uint256 quote = pool.computeQuote(address(assetTST2), address(assetTST), amount, true);
            require(quote > 0, "quote zero");
            vm.prank(swapper);
            pool.swap(quote, 0, swapper, "");
        }
    }

    function _logVault(string memory label, VaultState memory v) internal pure {
        console.log(label);
        console.log("  deposits0:", v.deposits0);
        console.log("  deposits1:", v.deposits1);
        console.log("  debts0:   ", v.debts0);
        console.log("  debts1:   ", v.debts1);
    }

    /// @dev Create pool with feeRecipient so fees leave the vault.
    function _createPoolWithFeeRecipient(
        uint112 eq0, uint112 eq1, uint64 fee, uint80 px, uint80 py, uint64 cx, uint64 cy
    ) internal returns (EulerSwap pool, IEulerSwap.StaticParams memory sp) {
        (sp,) = getEulerSwapParams(eq0, eq1, px, py, cx, cy, fee, feeCollector);
        IEulerSwap.DynamicParams memory dp = IEulerSwap.DynamicParams({
            equilibriumReserve0: eq0,
            equilibriumReserve1: eq1,
            minReserve0: 0,
            minReserve1: 0,
            priceX: px,
            priceY: py,
            concentrationX: cx,
            concentrationY: cy,
            fee0: fee,
            fee1: fee,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: eq0, reserve1: eq1});
        pool = createEulerSwapFull(sp, dp, init);
    }

    // --- Tests ---

    /// @notice Constant-sum (c=1): clearing swap fully drains deposits1 to zero.
    /// Cost is exactly: grossIn = clearingAmount / (1 - feeRate).
    function test_clearing_constant_sum_drain_deposits1() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPoolWithFeeRecipient(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18);

        // Build exposure: 3 swaps of asset1 in
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.3e18);
        }

        VaultState memory before = _readVault(sp);
        _logVault("Before clearing (c=1):", before);

        // With feeRecipient set and c=1, deposits track reserves exactly.
        // The clearing swap drains all deposits1.
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 clearingAmount = before.deposits1 < outLimit ? before.deposits1 : outLimit;

        // Verify cost formula: grossIn = clearingAmount / (1 - fee)
        uint256 expectedGrossIn = clearingAmount * 1e18 / (1e18 - 0.01e18);
        uint256 actualGrossIn = pool.computeQuote(
            address(assetTST), address(assetTST2), clearingAmount, false
        );
        assertApproxEqAbs(actualGrossIn, expectedGrossIn, 1, "Constant-sum clearing cost exact");

        // Execute
        assetTST.mint(swapper, actualGrossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), actualGrossIn);
        vm.prank(swapper);
        pool.swap(0, clearingAmount, swapper, "");

        VaultState memory post = _readVault(sp);
        _logVault("Post clearing (c=1):", post);

        assertLe(post.deposits1, 1, "deposits1 fully drained");
        assertEq(post.debts1, 0, "no debts1");
        assertTrue(post.deposits0 > 0, "All equity in asset0");

        console.log("Clearing cost (fee):", actualGrossIn - clearingAmount);
    }

    /// @notice Constant-sum clearing in the opposite direction: drain deposits0.
    function test_clearing_constant_sum_drain_deposits0() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPoolWithFeeRecipient(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, true, 0.3e18);
        }

        VaultState memory before = _readVault(sp);

        (, uint256 outLimit) = pool.getLimits(address(assetTST2), address(assetTST));
        uint256 clearingAmount = before.deposits0 < outLimit ? before.deposits0 : outLimit;

        uint256 grossIn1 = pool.computeQuote(
            address(assetTST2), address(assetTST), clearingAmount, false
        );

        assetTST2.mint(swapper, grossIn1);
        vm.prank(swapper);
        assetTST2.transfer(address(pool), grossIn1);
        vm.prank(swapper);
        pool.swap(clearingAmount, 0, swapper, "");

        VaultState memory post = _readVault(sp);
        _logVault("Post clearing (c=1, drain asset0):", post);

        assertLe(post.deposits0, 1, "deposits0 fully drained");
        assertEq(post.debts0, 0, "no debts0");
        assertTrue(post.deposits1 > 0, "All equity in asset1");
    }

    /// @notice When feeRecipient == address(0), fees stay in vault creating a
    /// deposits > reserves gap. The fee residual is inaccessible via swaps.
    function test_fee_residual_with_zero_recipient() public {
        // Pool WITHOUT feeRecipient — fees stay in vault
        EulerSwap pool = createEulerSwap(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18);
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.3e18);
        }

        VaultState memory before = _readVault(sp);

        (, uint112 _reserve1,) = pool.getReserves();
        uint256 reserve1 = uint256(_reserve1);

        // deposits1 = reserve1 + accumulated fees (fees in vault but not in reserves)
        uint256 feeResidual = before.deposits1 - reserve1;
        console.log("Reserve1:", reserve1);
        console.log("Deposits1:", before.deposits1);
        console.log("Fee residual:", feeResidual);
        assertTrue(feeResidual > 0, "Fees accumulated in vault");

        // The clearing swap can drain reserve1's worth from the vault.
        // The fee residual stays behind — it's in the vault but not
        // reachable through the curve without recentering.
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 drainAmount = reserve1 < outLimit ? reserve1 : outLimit;

        uint256 grossIn0 = pool.computeQuote(
            address(assetTST), address(assetTST2), drainAmount, false
        );

        assetTST.mint(swapper, grossIn0);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn0);
        vm.prank(swapper);
        pool.swap(0, drainAmount, swapper, "");

        VaultState memory post = _readVault(sp);
        _logVault("Post clearing:", post);

        // Remaining deposits1 ≈ fee residual
        assertApproxEqAbs(post.deposits1, feeResidual + (reserve1 - drainAmount), 1, "Fee residual remains");
    }

    /// @notice Curved pool (c=0.5): clearing swap costs more than constant-sum
    /// due to curve spread (price impact). The spread accrues to the LP as NAV.
    function test_clearing_curved_pool_spread() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPoolWithFeeRecipient(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.2e18);
        }

        VaultState memory before = _readVault(sp);
        _logVault("Before clearing (c=0.5):", before);

        int256 navBefore = int256(before.deposits0 + before.deposits1)
            - int256(before.debts0 + before.debts1);

        // Use a clearing amount within curve limits
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        // Use 50% of deposits1 — well within limits, demonstrates the concept
        uint256 clearingAmount = before.deposits1 / 2;
        require(clearingAmount <= outLimit, "clearing exceeds limit");

        uint256 curvedGrossIn = pool.computeQuote(
            address(assetTST), address(assetTST2), clearingAmount, false
        );

        // Constant-sum baseline (analytical): grossIn = clearingAmount / (1 - fee)
        // At 1:1 price with c=1, output = post-fee input, so this is the minimum cost.
        uint256 csGrossIn = clearingAmount * 1e18 / (1e18 - 0.01e18);

        console.log("Clearing amount:", clearingAmount);
        console.log("Constant-sum baseline:", csGrossIn);
        console.log("Curved (c=0.5) grossIn:", curvedGrossIn);
        console.log("Curve spread:", curvedGrossIn - csGrossIn);

        // Curved pool costs more: the extra cost is curve spread (price impact)
        assertTrue(curvedGrossIn > csGrossIn, "Curved pool costs more than constant-sum");

        // Execute and verify NAV increases (spread accrues to LP, fees to collector)
        assetTST.mint(swapper, curvedGrossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), curvedGrossIn);
        vm.prank(swapper);
        pool.swap(0, clearingAmount, swapper, "");

        VaultState memory post = _readVault(sp);
        int256 navAfter = int256(post.deposits0 + post.deposits1)
            - int256(post.debts0 + post.debts1);

        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after: ", uint256(navAfter));

        // NAV increases because curve spread goes to the pool (fees go to collector)
        assertTrue(navAfter > navBefore, "NAV increases from curve spread");
    }

    /// @notice Verify NAV is preserved through a constant-sum clearing swap.
    /// With c=1 and feeRecipient set, there is zero curve spread, so
    /// NAV should be exactly unchanged.
    function test_clearing_constant_sum_preserves_nav_exactly() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPoolWithFeeRecipient(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18);

        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, false, 0.2e18);
        }

        VaultState memory before = _readVault(sp);
        int256 navBefore = int256(before.deposits0 + before.deposits1) - int256(before.debts0 + before.debts1);

        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 clearingAmount = before.deposits1 < outLimit ? before.deposits1 : outLimit;

        uint256 grossIn0 = pool.computeQuote(
            address(assetTST), address(assetTST2), clearingAmount, false
        );

        assetTST.mint(swapper, grossIn0);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn0);
        vm.prank(swapper);
        pool.swap(0, clearingAmount, swapper, "");

        VaultState memory post = _readVault(sp);
        int256 navAfter = int256(post.deposits0 + post.deposits1) - int256(post.debts0 + post.debts1);

        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after: ", uint256(navAfter));

        // With c=1 + feeRecipient: no curve spread, fees leave the vault.
        // NAV should be exactly unchanged (within 1 wei rounding).
        assertApproxEqAbs(uint256(navAfter), uint256(navBefore), 1, "NAV unchanged for constant-sum");
    }
}
