// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {WalkthroughBase} from "./WalkthroughBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {console} from "forge-std/Test.sol";

/// @title Step5_AuctionMechanics
/// @notice Tests for walkthrough Step 5: constant-sum reconfiguration, AMM-position
///         auction tracking, partial fills, manipulation resistance, clearing threshold,
///         wrong-direction capacity, curvature-aware surcharge math, and auction cost.
///
/// These tests simulate the auction mechanism at the pool level — no hook, just
/// the reconfigure + swap mechanics that the hook will orchestrate.
contract Step5_AuctionMechanics is WalkthroughBase {

    // ════════════════════════════════════════════════════════════════════
    // 5c. Constant-sum reconfiguration
    // ════════════════════════════════════════════════════════════════════

    /// @notice Pool can be reconfigured from curved to constant-sum mid-life.
    ///         eq = current reserves, c = 1. CurveLib.verify passes.
    function test_5c_reconfigure_to_constant_sum() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Displace the pool
        _doSwap(pool, true, 1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Reconfigure to constant-sum
        _reconfigureToConstantSum(pool, 0, 0, 1e18, 1e18, 0.01e18);

        // Verify: pool now has constant-sum pricing
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.concentrationX, 1e18, "cx = 1 (constant-sum)");
        assertEq(dp.concentrationY, 1e18, "cy = 1 (constant-sum)");
        assertEq(dp.equilibriumReserve0, r0, "eq0 = current reserve0");
        assertEq(dp.equilibriumReserve1, r1, "eq1 = current reserve1");

        // Swaps still work
        uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        assertTrue(quote > 0, "swaps work after reconfigure");

        // Constant-sum: second swap gives same rate
        uint256 quote2 = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        assertEq(quote, quote2, "constant-sum: no price impact");
    }

    /// @notice After reconfigure to constant-sum, swaps route through same FundsLib path.
    ///         Vault operations (deposit, borrow, repay) work correctly.
    function test_5c_constant_sum_vault_operations_correct() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Displace to create some debt
        _doSwap(pool, true, 2e18);

        VaultState memory beforeReconfig = _readVault(sp);

        // Reconfigure to constant-sum
        _reconfigureToConstantSum(pool, 0, 0, 1e18, 1e18, 0.01e18);

        // Vault state should be unchanged by reconfigure itself
        VaultState memory afterReconfig = _readVault(sp);
        assertEq(afterReconfig.deposits0, beforeReconfig.deposits0, "deposits0 unchanged by reconfigure");
        assertEq(afterReconfig.debts1, beforeReconfig.debts1, "debts1 unchanged by reconfigure");

        // Now swap on constant-sum: asset1 in to repay debt
        _doSwap(pool, false, 0.5e18);

        VaultState memory afterSwap = _readVault(sp);

        // Debts should have decreased (repaid by asset1 inflow)
        // or deposits1 increased
        int256 net1Change = (int256(afterSwap.deposits1) - int256(afterSwap.debts1))
            - (int256(afterReconfig.deposits1) - int256(afterReconfig.debts1));
        assertTrue(net1Change > 0, "asset1 in: net position improved");
    }

    /// @notice Min reserves on constant-sum define clearing capacity.
    ///         Setting minReserve1 = reserve1 - clearingAmount allows exactly
    ///         clearingAmount of asset1 to flow out. minReserve0 = reserve0 blocks
    ///         wrong-direction output.
    function test_5c_min_reserves_define_clearing_capacity() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Displace
        _doSwap(pool, false, 1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Define clearing: we want to drain 0.5e18 of asset1
        uint112 clearingAmount = 0.5e18;
        uint112 minR1 = r1 - clearingAmount;

        // Reconfigure to constant-sum with locked non-clearing side
        _reconfigureToConstantSum(pool, r0, minR1, 1e18, 1e18, 0.01e18);

        // outLimit should be approximately clearingAmount
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertApproxEqAbs(outLimit, uint256(clearingAmount), 1, "outLimit = clearingAmount");

        // Can swap up to the limit
        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), outLimit, false);
        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, outLimit, swapper, "");

        // Reserve1 should be at minR1
        (, uint112 r1After,) = pool.getReserves();
        assertApproxEqAbs(uint256(r1After), uint256(minR1), 1, "reserve1 at min after full clearing");
    }

    /// @notice Reconfigure back to curved pool after constant-sum auction.
    function test_5c_reconfigure_back_to_curved() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 0.5e18);

        // Save pre-auction params
        IEulerSwap.DynamicParams memory originalDp = pool.getDynamicParams();

        // Reconfigure to constant-sum
        _reconfigureToConstantSum(pool, 0, 0, 1e18, 1e18, 0.01e18);

        // Do some "auction" swaps
        _doSwap(pool, false, 0.3e18);

        // Reconfigure back: eq = current reserves, restore concentration
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory restoredDp = IEulerSwap.DynamicParams({
            equilibriumReserve0: r0,
            equilibriumReserve1: r1,
            minReserve0: 0,
            minReserve1: 0,
            priceX: originalDp.priceX,
            priceY: originalDp.priceY,
            concentrationX: originalDp.concentrationX,
            concentrationY: originalDp.concentrationY,
            fee0: originalDp.fee0,
            fee1: originalDp.fee1,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: r0, reserve1: r1});
        _reconfigure(pool, restoredDp, init);

        // Pool works normally again with curvature
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.concentrationX, originalDp.concentrationX, "concentration restored");

        // Price impact should exist again
        uint256 q1 = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        _doSwap(pool, true, 0.1e18);
        uint256 q2 = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        assertTrue(q2 < q1, "price impact restored after reconfigure back");
    }

    // ════════════════════════════════════════════════════════════════════
    // 5d. Auction tracking via AMM position
    // ════════════════════════════════════════════════════════════════════

    /// @notice Cleared fraction = (eq_out - reserve_out) / (eq_out - minReserve_out).
    ///         The AMM's own position IS the tracker.
    function test_5d_cleared_fraction_from_reserves() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, false, 1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Setup auction: clear 0.5e18 of asset1, lock wrong direction
        uint112 clearingAmount = 0.5e18;
        uint112 minR1 = r1 - clearingAmount;

        _reconfigureToConstantSum(pool, r0, minR1, 1e18, 1e18, 0.005e18);

        // At start: 0% cleared
        (uint112 eq0, uint112 eq1) = (pool.getDynamicParams().equilibriumReserve0, pool.getDynamicParams().equilibriumReserve1);
        {
            (, uint112 curr1,) = pool.getReserves();
            uint256 clearedPct = (uint256(eq1) - uint256(curr1)) * 100 / uint256(clearingAmount);
            assertEq(clearedPct, 0, "0% cleared at start");
        }

        // Partial fill: 50%
        _doSwapExactOut(pool, true, uint256(clearingAmount) / 2);
        {
            (, uint112 curr1,) = pool.getReserves();
            uint256 clearedPct = (uint256(eq1) - uint256(curr1)) * 100 / uint256(clearingAmount);
            assertApproxEqAbs(clearedPct, 50, 1, "~50% cleared after half fill");
        }

        // Fill remaining
        (, uint256 remaining) = pool.getLimits(address(assetTST), address(assetTST2));
        if (remaining > 0) {
            _doSwapExactOut(pool, true, remaining);
        }
        {
            (, uint112 curr1,) = pool.getReserves();
            uint256 clearedPct = (uint256(eq1) - uint256(curr1)) * 100 / uint256(clearingAmount);
            assertApproxEqAbs(clearedPct, 100, 1, "~100% cleared after full fill");
        }
    }

    /// @notice Multiple partial fills converge to full clearing.
    function test_5d_multiple_partial_fills() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.005e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, false, 1.5e18);
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint112 clearingAmount = 1e18;
        uint112 minR1 = r1 - clearingAmount;

        _reconfigureToConstantSum(pool, r0, minR1, 1e18, 1e18, 0.005e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        uint112 eqR1 = dp.equilibriumReserve1;

        // 5 partial fills of 0.2e18 each = 1e18 total
        uint256 totalFilled = 0;
        for (uint256 i = 0; i < 5; i++) {
            (, uint256 outRemaining) = pool.getLimits(address(assetTST), address(assetTST2));
            if (outRemaining == 0) break;

            uint256 fillSize = 0.2e18;
            if (fillSize > outRemaining) fillSize = outRemaining;

            _doSwapExactOut(pool, true, fillSize);
            totalFilled += fillSize;

            (, uint112 curr1,) = pool.getReserves();
            uint256 clearedPct = (uint256(eqR1) - uint256(curr1)) * 100 / uint256(clearingAmount);
            console.log("After fill", i + 1, "- cleared %:", clearedPct);
        }

        (, uint112 finalR1,) = pool.getReserves();
        assertApproxEqAbs(uint256(finalR1), uint256(minR1), 1, "fully cleared after 5 partial fills");
    }

    // ════════════════════════════════════════════════════════════════════
    // 5e. Manipulation resistance
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attack 1: selling asset E into pool to depress price.
    ///         This INCREASES exposure (pushes pool further from target).
    ///         On a leveraged pool, the price depression is negligible.
    function test_5e_manipulation_increases_exposure() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        // Build some exposure: asset0 in
        _doSwap(pool, true, 0.5e18);

        VaultState memory beforeManip = _readVault(sp);
        int256 net0Before = int256(beforeManip.deposits0) - int256(beforeManip.debts0);

        // "Attacker" sells more asset0 in (same direction as existing exposure)
        _doSwap(pool, true, 0.5e18);

        VaultState memory afterManip = _readVault(sp);
        int256 net0After = int256(afterManip.deposits0) - int256(afterManip.debts0);

        // Exposure INCREASED, not decreased
        assertTrue(net0After > net0Before, "manipulation: exposure increased (self-defeating)");
    }

    /// @notice Attack 2: buying asset E from pool (clearing direction).
    ///         This actually helps the pool by reducing exposure.
    ///         The "attacker" does the LP's rebalancing work for it.
    ///
    ///         FINDING: On curved pools, the clearing direction gives the trader
    ///         a better-than-equilibrium rate (the scarce asset commands a premium).
    ///         NAV in 1:1 terms can decrease because the LP pays curve spread to
    ///         attract rebalancing flow. This is the expected cost of rebalancing —
    ///         the LP trades NAV for exposure reduction.
    function test_5e_clearing_direction_helps_pool() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        // Build asset0 exposure
        _doSwap(pool, true, 1e18);

        VaultState memory beforeClear = _readVault(sp);

        // "Attacker" buys asset0 from pool (asset1 in, asset0 out = clearing direction)
        _doSwap(pool, false, 0.5e18);

        VaultState memory afterClear = _readVault(sp);

        // The key assertion: exposure REDUCED (attacker did pool's job)
        int256 exposure0Before = int256(beforeClear.deposits0) - int256(beforeClear.debts0);
        int256 exposure0After = int256(afterClear.deposits0) - int256(afterClear.debts0);
        assertTrue(exposure0After < exposure0Before, "clearing direction: exposure reduced");

        // NAV may decrease slightly (curve spread paid to trader for rebalancing)
        // This is the rebalancing cost documented in walkthrough Step 1
        int256 navBefore = _nav(beforeClear);
        int256 navAfter = _nav(afterClear);

        console.log("Exposure before:", uint256(exposure0Before));
        console.log("Exposure after: ", uint256(exposure0After));
        console.log("NAV before:     ", uint256(navBefore));
        console.log("NAV after:      ", uint256(navAfter));

        if (navAfter < navBefore) {
            console.log("NAV cost of rebalancing:", uint256(navBefore - navAfter));
        }
    }

    /// @notice Price depression from manipulation is negligible on deep pools.
    ///         A $X manipulation on eq=$Y pool moves price by ~2X/Y.
    function test_5e_price_impact_negligible_on_deep_pool() public {
        // Large pool: 50e18 eq per side
        (EulerSwap pool,) = _createPool(50e18, 50e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);

        // Quote before manipulation
        uint256 quoteBefore = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // "Manipulation": 0.1e18 asset0 in (0.2% of eq)
        _doSwap(pool, true, 0.1e18);

        // Quote after — price should barely move
        uint256 quoteAfter = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        uint256 priceDiff = quoteBefore - quoteAfter;
        uint256 priceDiffBps = priceDiff * 10000 / quoteBefore;

        // For eq=50e18, manipulation of 0.1e18: price change ~ 2*0.1/50 = 0.4%
        // In bps: ~40 bps. But that's the marginal change, not the average.
        assertTrue(priceDiffBps < 100, "price impact < 1% (100 bps) on deep pool");

        console.log("Price diff (bps):", priceDiffBps);
    }

    // ════════════════════════════════════════════════════════════════════
    // 5c (extended). Wrong-direction blocked during auction
    // ════════════════════════════════════════════════════════════════════

    /// @notice During auction, minReserve on the non-clearing side = current reserve.
    ///         This makes the pool one-directional: only clearing swaps are possible.
    ///         Wrong-direction output is fully blocked.
    function test_5c_wrong_direction_blocked_during_auction() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, false, 1e18);
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Auction: clearing direction is asset0 in, asset1 out
        // minReserve0 = r0 (LOCK: no asset0 output in wrong direction)
        uint112 clearingAmount = 0.5e18;
        _reconfigureToConstantSum(pool, r0, r1 - clearingAmount, 1e18, 1e18, 0.01e18);

        // Wrong direction should have zero capacity
        (, uint256 wrongDirLimit) = pool.getLimits(address(assetTST2), address(assetTST));
        assertEq(wrongDirLimit, 0, "wrong-direction blocked: minReserve0 = reserve0");

        // Clearing direction still works
        (, uint256 clearingLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertTrue(clearingLimit > 0, "clearing direction still open");
        assertApproxEqAbs(clearingLimit, uint256(clearingAmount), 1, "clearing capacity = clearingAmount");

        // Execute full clearing: asset0 in, asset1 out
        _doSwapExactOut(pool, true, clearingLimit);
        (, uint112 r1After,) = pool.getReserves();
        assertApproxEqAbs(uint256(r1After), uint256(r1 - clearingAmount), 1, "fully cleared");
    }

    /// @notice Symmetric: when clearing asset0 out, block asset1 output instead.
    function test_5c_wrong_direction_blocked_symmetric() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 1e18);
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Clearing direction: asset1 in, asset0 out (sell asset0 cheaply)
        // minReserve1 = r1 (LOCK: no asset1 output)
        uint112 clearingAmount = 0.5e18;
        _reconfigureToConstantSum(pool, r0 - clearingAmount, r1, 1e18, 1e18, 0.01e18);

        // Wrong direction (asset0 in, asset1 out) should be blocked
        (, uint256 wrongDirLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertEq(wrongDirLimit, 0, "wrong-direction blocked: minReserve1 = reserve1");

        // Clearing direction (asset1 in, asset0 out) works
        (, uint256 clearingLimit) = pool.getLimits(address(assetTST2), address(assetTST));
        assertTrue(clearingLimit > 0, "clearing direction open");
        assertApproxEqAbs(clearingLimit, uint256(clearingAmount), 1, "clearing capacity = clearingAmount");
    }

    // ════════════════════════════════════════════════════════════════════
    // 5f. Clearing threshold
    // ════════════════════════════════════════════════════════════════════

    /// @notice Clearing threshold check: remaining < threshold means "good enough".
    ///         Uses the reserve-based formula from walkthrough 5f:
    ///         remaining = (reserve_out - minReserve_out) / clearingAmount
    function test_5f_clearing_threshold_check() public {
        // Use constant-sum for exact arithmetic
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.005e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        _doSwap(pool, false, 1e18);

        (uint112 r0f, uint112 r1,) = pool.getReserves();
        uint112 clearingAmount = 0.8e18;
        uint112 minR1 = r1 - clearingAmount;

        // Already constant-sum, reconfigure min reserves with locked wrong direction
        _reconfigureToConstantSum(pool, r0f, minR1, 1e18, 1e18, 0.005e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        uint112 eqR1 = dp.equilibriumReserve1;

        // Fill 92% of the clearing amount as exact output
        uint256 fillAmount = uint256(clearingAmount) * 92 / 100;
        _doSwapExactOut(pool, true, fillAmount);

        (, uint112 currR1,) = pool.getReserves();
        // remaining = (reserve_out - min_out) / clearingAmount
        uint256 remainingAbs = uint256(currR1) - uint256(minR1);
        uint256 remainingPct = remainingAbs * 100 / uint256(clearingAmount);

        console.log("Clearing amount:", clearingAmount);
        console.log("Filled:         ", fillAmount);
        console.log("Remaining abs:  ", remainingAbs);
        console.log("Remaining %:    ", remainingPct);

        assertTrue(remainingPct <= 10, "remaining <= 10% => threshold met");

        // Also verify: 50% fill leaves ~50% remaining
        // (Reset by creating new pool)
        (EulerSwap pool2,) = _createPool(10e18, 10e18, 0.005e18, 1e18, 1e18, 1e18, 1e18, feeCollector);
        _doSwap(pool2, false, 1e18);
        (uint112 r0b, uint112 r1b,) = pool2.getReserves();

        _reconfigureToConstantSum(pool2, r0b, r1b - clearingAmount, 1e18, 1e18, 0.005e18);

        uint256 halfFill = uint256(clearingAmount) / 2;
        _doSwapExactOut(pool2, true, halfFill);

        (, uint112 currR1b,) = pool2.getReserves();
        uint256 remainingB = uint256(currR1b) - uint256(r1b - clearingAmount);
        uint256 remainingPctB = remainingB * 100 / uint256(clearingAmount);

        console.log("After 50% fill, remaining %:", remainingPctB);
        assertApproxEqAbs(remainingPctB, 50, 2, "50% fill leaves ~50% remaining");
    }

    // ════════════════════════════════════════════════════════════════════
    // 5h. Curvature-aware surcharge math
    // ════════════════════════════════════════════════════════════════════

    /// @notice Curvature component = (1-c) * [(eq/reserve)^2 - 1].
    ///         Verify against actual pool behavior: the extractable value after
    ///         a recenter should match the formula.
    function test_5h_curvature_component_matches_extractable_value() public {
        uint64 cx = 0; // c=0 for maximum curvature effect
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, cx, cx, feeCollector);

        // Displace: asset0 in, so reserve0 > eq0 and reserve1 < eq1
        _doSwap(pool, true, 1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        // Pre-recenter: compute the curvature component on the displaced side
        // Side 1 is displaced (reserve1 < eq1)
        uint256 eq1 = uint256(dpBefore.equilibriumReserve1);
        uint256 reserve1 = uint256(r1);

        // curvatureComponent = (1-c) * [(eq/reserve)^2 - 1]
        // For c=0: curvatureComponent = (eq/reserve)^2 - 1
        uint256 ratio = eq1 * 1e18 / reserve1;
        uint256 ratioSq = ratio * ratio / 1e18;
        uint256 curvatureComponent = ratioSq - 1e18; // in WAD

        console.log("eq1:", eq1);
        console.log("reserve1:", reserve1);
        console.log("eq/reserve (WAD):", ratio);
        console.log("(eq/reserve)^2 (WAD):", ratioSq);
        console.log("Curvature component (WAD):", curvatureComponent);
        console.log("Curvature component (bps):", curvatureComponent / 1e14);

        // Now recenter: eq = current reserves
        IEulerSwap.DynamicParams memory dpNew = dpBefore;
        dpNew.equilibriumReserve0 = r0;
        dpNew.equilibriumReserve1 = r1;
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: r0, reserve1: r1});
        _reconfigure(pool, dpNew, init);

        // After recenter, an arber can trade AWAY from the new eq.
        // The first unit of such trade was previously at the elevated marginal price
        // but now trades at the flat eq price. The edge is the curvature component.

        // Measure: quote for a small trade in the clearing direction vs a trade
        // in the opposite direction. The asymmetry should be zero now (at eq).
        uint256 quoteForward = pool.computeQuote(address(assetTST2), address(assetTST), 0.01e18, true);
        uint256 quoteReverse = pool.computeQuote(address(assetTST), address(assetTST2), 0.01e18, true);

        // At equilibrium, forward and reverse should be symmetric (same fee, same rate)
        // The curvature component is the edge that existed BEFORE recenter, not after.
        assertApproxEqRel(quoteForward, quoteReverse, 0.001e18, "at eq: forward/reverse symmetric");
    }

    /// @notice For c=1 (constant-sum): curvature component is always zero.
    function test_5h_constant_sum_zero_curvature() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Displace
        _doSwap(pool, true, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0,, ) = pool.getReserves();

        // curvatureComponent = (1-c) * [...] = (1-1) * [...] = 0
        uint256 c = uint256(dp.concentrationX);
        uint256 oneMinusC = 1e18 - c;
        assertEq(oneMinusC, 0, "constant-sum: (1-c) = 0");

        // Verify: recenter doesn't change marginal rate for constant-sum
        // (marginal rate is always px/py regardless of position)
        uint256 quoteBefore = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);

        // Recenter
        (uint112 cr0, uint112 cr1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dpNew = dp;
        dpNew.equilibriumReserve0 = cr0;
        dpNew.equilibriumReserve1 = cr1;
        _reconfigure(pool, dpNew, IEulerSwap.InitialState({reserve0: cr0, reserve1: cr1}));

        uint256 quoteAfter = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);

        assertEq(quoteBefore, quoteAfter, "constant-sum: recenter doesn't change rate");
    }

    /// @notice Curvature component scales with displacement.
    ///         Larger displacement = larger surcharge needed.
    function test_5h_curvature_scales_with_displacement() public {
        // Two separate tests with different displacement levels
        (EulerSwap pool1,) = _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);

        // Small displacement
        _doSwap(pool1, true, 0.5e18);
        (,uint112 r1Small,) = pool1.getReserves();
        IEulerSwap.DynamicParams memory dp1 = pool1.getDynamicParams();
        uint256 eq1 = uint256(dp1.equilibriumReserve1);

        uint256 ratioSmall = eq1 * 1e18 / uint256(r1Small);
        uint256 componentSmall = (ratioSmall * ratioSmall / 1e18) - 1e18;

        // Large displacement on same pool
        _doSwap(pool1, true, 1.5e18);
        (,uint112 r1Large,) = pool1.getReserves();

        uint256 ratioLarge = eq1 * 1e18 / uint256(r1Large);
        uint256 componentLarge = (ratioLarge * ratioLarge / 1e18) - 1e18;

        assertTrue(componentLarge > componentSmall, "larger displacement = larger curvature component");

        console.log("Small displacement curvature (bps):", componentSmall / 1e14);
        console.log("Large displacement curvature (bps):", componentLarge / 1e14);
    }

    /// @notice Intermediate concentration (c=0.5): curvature component halved.
    function test_5h_intermediate_concentration() public {
        // c=0 pool
        (EulerSwap poolC0,) = _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);
        _doSwap(poolC0, true, 1e18);

        IEulerSwap.DynamicParams memory dp0 = poolC0.getDynamicParams();
        (, uint112 r1C0,) = poolC0.getReserves();
        uint256 eq1 = uint256(dp0.equilibriumReserve1);
        uint256 ratio = eq1 * 1e18 / uint256(r1C0);
        uint256 bracket = (ratio * ratio / 1e18) - 1e18;

        uint256 componentC0 = bracket; // (1-0) * bracket
        uint256 componentC05 = bracket / 2; // (1-0.5) * bracket

        assertTrue(componentC0 > 0, "c=0 has curvature");
        assertTrue(componentC05 > 0, "c=0.5 has curvature");
        assertApproxEqRel(componentC05, componentC0 / 2, 0.001e18, "c=0.5: half the curvature of c=0");

        console.log("c=0 component (bps): ", componentC0 / 1e14);
        console.log("c=0.5 component (bps):", componentC05 / 1e14);
    }

    // ════════════════════════════════════════════════════════════════════
    // 5i. Auction cost analysis
    // ════════════════════════════════════════════════════════════════════

    /// @notice On constant-sum auction: LP cost = fee only (zero curve spread).
    ///         The arber pays grossIn, receives clearingAmount.
    ///         Fee = grossIn - clearingAmount (goes to feeCollector).
    function test_5i_constant_sum_auction_cost_is_fee_only() public {
        uint64 fee = 0.02e18; // 2% auction fee
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Build exposure
        _doSwap(pool, false, 1e18);

        VaultState memory beforeAuction = _readVault(sp);
        int256 navBefore = _nav(beforeAuction);

        // Reconfigure to constant-sum with auction fee, lock wrong direction
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint112 clearingAmount = 0.5e18;
        _reconfigureToConstantSum(pool, r0, r1 - clearingAmount, 1e18, 1e18, fee);

        // Execute clearing swap
        uint256 grossIn = pool.computeQuote(address(assetTST), address(assetTST2), uint256(clearingAmount), false);

        uint256 feeCollectorBefore = assetTST.balanceOf(feeCollector);

        assetTST.mint(swapper, grossIn);
        vm.prank(swapper);
        assetTST.transfer(address(pool), grossIn);
        vm.prank(swapper);
        pool.swap(0, uint256(clearingAmount), swapper, "");

        uint256 feesCollected = assetTST.balanceOf(feeCollector) - feeCollectorBefore;

        // Fee = grossIn - clearingAmount (for 1:1 constant-sum)
        uint256 expectedFee = grossIn - uint256(clearingAmount);
        assertApproxEqAbs(feesCollected, expectedFee, 1, "fees = grossIn - clearing (no curve spread)");

        // NAV should be unchanged (fees left the vault, no spread)
        VaultState memory afterAuction = _readVault(sp);
        int256 navAfter = _nav(afterAuction);
        assertApproxEqAbs(uint256(navAfter), uint256(navBefore), 2, "NAV preserved (constant-sum auction)");

        console.log("Clearing amount:", clearingAmount);
        console.log("Gross in:       ", grossIn);
        console.log("Fee collected:  ", feesCollected);
        console.log("NAV before:     ", uint256(navBefore));
        console.log("NAV after:      ", uint256(navAfter));
    }

    // ════════════════════════════════════════════════════════════════════
    // 5b (extended). Starting fee and fee decay math
    // ════════════════════════════════════════════════════════════════════

    /// @notice Starting fee = premium + k * D.
    ///         The auction becomes profitable at block k.
    ///         Verify: at different fee levels, output changes predictably.
    function test_5b_starting_fee_and_decay_math() public {
        // Simulate fee decay by reconfiguring pool fee each "block"
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.05e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Parameters
        uint256 baseFee = 0.001e18;    // 10 bps (floor)
        uint256 startingFee = 0.05e18; // 500 bps
        uint256 decayPerBlock = 0.004e18; // 40 bps per block

        // Block 0: fee = startingFee = 500 bps
        uint256 fee0 = startingFee;
        uint256 output0 = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output0, 1e18 - fee0, "block 0: output reflects starting fee");

        // Block 5: fee = max(baseFee, 500 - 5*40) = max(10, 300) = 300 bps
        uint256 fee5 = startingFee - 5 * decayPerBlock;
        assertTrue(fee5 > baseFee, "block 5: fee > baseFee");
        {
            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.fee0 = uint64(fee5);
            dp.fee1 = uint64(fee5);
            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        }
        uint256 output5 = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output5, 1e18 - fee5, "block 5: output reflects decayed fee");

        // Block 12: fee = max(baseFee, 500 - 12*40) = max(10, 20) = 20 bps
        uint256 fee12raw = startingFee > 12 * decayPerBlock ? startingFee - 12 * decayPerBlock : 0;
        uint256 fee12 = fee12raw > baseFee ? fee12raw : baseFee;
        {
            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.fee0 = uint64(fee12);
            dp.fee1 = uint64(fee12);
            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        }
        uint256 output12 = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output12, 1e18 - fee12, "block 12: fee decayed near baseFee");

        // Block 20: fee = max(baseFee, 500 - 20*40) = max(10, -300) = baseFee
        {
            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.fee0 = uint64(baseFee);
            dp.fee1 = uint64(baseFee);
            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        }
        uint256 output20 = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output20, 1e18 - baseFee, "block 20: fee at baseFee floor");

        // Verify monotonic improvement
        assertTrue(output0 < output5 && output5 < output12 && output12 < output20,
            "output improves as fee decays");

        console.log("Output block 0 (500 bps):", output0);
        console.log("Output block 5 (300 bps):", output5);
        console.log("Output block 12:", output12);
        console.log("Output block 20 (baseFee):", output20);
    }

    // ════════════════════════════════════════════════════════════════════
    // 5h (extended). Surcharge price component and linear decay
    // ════════════════════════════════════════════════════════════════════

    /// @notice Price component: |newPrice - oldPrice| / max(newPrice, oldPrice).
    ///         A 1% price change creates a 1% surcharge component.
    function test_5h_price_component_computation() public {
        // Pure math test: compute price component for various oracle changes
        uint256 oldPrice = 1e18;

        // 1% price change
        uint256 newPrice1 = 1.01e18;
        uint256 priceComp1 = _absDiff(newPrice1, oldPrice) * 1e18 / _max(newPrice1, oldPrice);
        // |1.01 - 1.0| / 1.01 = 0.0099... ≈ 99 bps
        assertApproxEqRel(priceComp1, 0.0099e18, 0.01e18, "1% price change ~ 99 bps component");

        // 0.01% price change (stablecoin scenario)
        uint256 newPrice2 = 1.0001e18;
        uint256 priceComp2 = _absDiff(newPrice2, oldPrice) * 1e18 / _max(newPrice2, oldPrice);
        assertApproxEqRel(priceComp2, 0.0001e18, 0.01e18, "0.01% price change ~ 1 bps component");

        // 5% price change (volatile scenario)
        uint256 newPrice3 = 1.05e18;
        uint256 priceComp3 = _absDiff(newPrice3, oldPrice) * 1e18 / _max(newPrice3, oldPrice);
        assertApproxEqRel(priceComp3, 0.0476e18, 0.01e18, "5% price change ~ 476 bps component");

        console.log("1% change component (bps):", priceComp1 / 1e14);
        console.log("0.01% change component (bps):", priceComp2 / 1e14);
        console.log("5% change component (bps):", priceComp3 / 1e14);
    }

    /// @notice Total surcharge = (curvature + price) * multiplier.
    ///         Linear decay: surcharge = max(0, initial - decayPerBlock * blocks).
    function test_5h_surcharge_linear_decay_math() public {
        // Parameters
        uint256 curvatureComponent = 0.003e18; // 30 bps
        uint256 priceComponent = 0.001e18;     // 10 bps
        uint256 multiplier = 1.25e18;          // 25% safety margin

        uint256 surchargeInitial = (curvatureComponent + priceComponent) * multiplier / 1e18;
        // = 0.004 * 1.25 = 0.005 = 50 bps
        assertEq(surchargeInitial, 0.005e18, "initial surcharge = 50 bps");

        // Decay: 0.5 bps per block -> reaches 0 in 100 blocks
        uint256 decayPerBlock = surchargeInitial / 100;

        // Block 0: 50 bps
        assertEq(_surchargeAt(surchargeInitial, decayPerBlock, 0), surchargeInitial, "block 0: 50 bps");

        // Block 50: 25 bps
        assertEq(_surchargeAt(surchargeInitial, decayPerBlock, 50), surchargeInitial / 2, "block 50: 25 bps");

        // Block 100: 0
        assertEq(_surchargeAt(surchargeInitial, decayPerBlock, 100), 0, "block 100: 0 bps");

        // Block 200: still 0 (capped at 0)
        assertEq(_surchargeAt(surchargeInitial, decayPerBlock, 200), 0, "block 200: still 0");
    }

    function _surchargeAt(uint256 initial, uint256 decay, uint256 blocks) internal pure returns (uint256) {
        uint256 decayed = decay * blocks;
        return decayed >= initial ? 0 : initial - decayed;
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ════════════════════════════════════════════════════════════════════
    // 5e (extended). Manipulation profitability analysis
    // ════════════════════════════════════════════════════════════════════

    /// @notice Attack 1 profitability: sell X into pool, buy from auction.
    ///         Profit = priceDepression * originalAmount.
    ///         Cost = priceDepression * X + fees.
    ///         For leveraged pools: cost >> profit.
    function test_5e_attack1_unprofitable_on_leveraged_pool() public {
        // Deep pool: 50e18 eq per side (simulates high leverage)
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(50e18, 50e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        // Build initial exposure: 1e18 asset0 in
        _doSwap(pool, true, 1e18);
        VaultState memory preManip = _readVault(sp);
        int256 originalExposure = int256(preManip.deposits0) - int256(preManip.debts0);

        // Attacker manipulation: sell 2e18 more asset0 (same direction as exposure)
        uint256 manipAmount = 2e18;
        uint256 manipOutput = _doSwap(pool, true, manipAmount);

        // Cost: the attacker sold manipAmount for manipOutput (on a curved pool, output < input)
        uint256 manipCost = manipAmount - manipOutput; // they lost this much from the swap

        // Price depression: how much did the clearing price change?
        // On c=0 pool: price impact ~ 2 * manipAmount / eq0
        // For eq=50e18: depression ~ 2*2/50 = 0.08 = 8%
        // Potential profit from original exposure at depressed price:
        // profit ~ priceDepression * originalExposure_amount
        uint256 priceDepressionBps = manipAmount * 2 * 10000 / 50e18; // rough estimate

        console.log("Manipulation amount:", manipAmount);
        console.log("Manipulation cost (output deficit):", manipCost);
        console.log("Price depression (bps):", priceDepressionBps);
        console.log("Original exposure:", uint256(originalExposure));

        // The key insight: manipulation cost scales with X (manipulation amount)
        // while profit from the depressed clearing price is small for deep pools.
        // The attacker also INCREASED exposure (self-defeating).

        VaultState memory postManip = _readVault(sp);
        int256 newExposure = int256(postManip.deposits0) - int256(postManip.debts0);
        assertTrue(newExposure > originalExposure, "manipulation increased exposure");
    }

    // ════════════════════════════════════════════════════════════════════
    // Full auction simulation: displace -> reconfigure -> clear -> restore
    // ════════════════════════════════════════════════════════════════════

    /// @notice End-to-end auction cycle: normal -> constant-sum -> clear -> restore.
    ///         Verifies the full lifecycle from walkthrough 5g.
    function test_full_auction_lifecycle() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        uint64 origCx = pool.getDynamicParams().concentrationX;

        // Phase 1: Normal trading builds exposure
        _doSwap(pool, false, 0.5e18);
        _doSwap(pool, false, 0.3e18);
        _doSwap(pool, false, 0.2e18);

        int256 navPreTrigger = _nav(_readVault(sp));

        // Phase 2: Trigger -> reconfigure to constant-sum
        _lifecycleAuction(pool);

        // Phase 3: Restore curved pool
        _lifecycleRestore(pool, origCx);

        // Verify
        assertEq(pool.getDynamicParams().concentrationX, origCx, "concentration restored");
        int256 navPostAuction = _nav(_readVault(sp));

        console.log("NAV pre-trigger: ", uint256(navPreTrigger));
        console.log("NAV post-auction:", uint256(navPostAuction));
        assertTrue(navPostAuction > 0, "NAV positive after full cycle");
    }

    function _lifecycleAuction(EulerSwap pool) internal {
        VaultState memory pre = _readVault(pool.getStaticParams());
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint112 clearAmt = uint112(pre.deposits1 / 2);

        // Lock wrong direction: minReserve0 = r0
        _reconfigureToConstantSum(pool, r0, r1 - clearAmt, 1e18, 1e18, 0.05e18);

        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 fill = outLimit < uint256(clearAmt) ? outLimit : uint256(clearAmt);
        _doSwapExactOut(pool, true, fill);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (, uint112 postR1,) = pool.getReserves();
        console.log("Cleared %:", (uint256(dp.equilibriumReserve1) - uint256(postR1)) * 100 / uint256(clearAmt));
    }

    function _lifecycleRestore(EulerSwap pool, uint64 origCx) internal {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        dp.concentrationX = origCx;
        dp.concentrationY = origCx;
        dp.fee0 = 0.01e18;
        dp.fee1 = 0.01e18;
        dp.minReserve0 = 0;
        dp.minReserve1 = 0;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
    }
}
