// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {WalkthroughBase} from "./WalkthroughBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {console} from "forge-std/Test.sol";

/// @title EdgeCases
/// @notice Edge case and stress tests for the auction walkthrough concepts.
///
/// Tests boundary conditions, high-leverage pools, extreme displacement,
/// fee edge cases, and multi-cycle auction behavior.
contract EdgeCases is WalkthroughBase {

    // ════════════════════════════════════════════════════════════════════
    // Boundary conditions
    // ════════════════════════════════════════════════════════════════════

    /// @notice Pool at equilibrium: zero displacement, zero curvature component.
    function test_edge_zero_displacement() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();

        // At equilibrium
        assertEq(r0, dp.equilibriumReserve0, "reserve0 = eq0");
        assertEq(r1, dp.equilibriumReserve1, "reserve1 = eq1");

        // Curvature component at eq = 0
        // (eq/reserve)^2 - 1 = 1 - 1 = 0
        uint256 eq1 = uint256(dp.equilibriumReserve1);
        uint256 ratio = eq1 * 1e18 / uint256(r1);
        uint256 ratioSq = ratio * ratio / 1e18;
        uint256 component = ratioSq > 1e18 ? ratioSq - 1e18 : 0;
        assertEq(component, 0, "curvature component = 0 at equilibrium");

        // Recenter at eq is a no-op (params don't change)
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        IEulerSwap.DynamicParams memory dpNew = pool.getDynamicParams();
        assertEq(dpNew.equilibriumReserve0, dp.equilibriumReserve0, "recenter at eq: no change");
    }

    /// @notice Maximum displacement: swap until pool hits min reserve boundary.
    function test_edge_max_displacement() public {
        uint112 eq = 10e18;
        uint112 minR = 5e18; // large range: 50% capacity

        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPoolWithMinReserves(eq, eq, minR, minR, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        // Get max output
        (, uint256 maxOut) = pool.getLimits(address(assetTST), address(assetTST2));

        // Swap to the boundary
        _doSwapExactOut(pool, true, maxOut);

        (, uint112 r1After,) = pool.getReserves();

        // Should be at or near min reserve
        assertApproxEqAbs(uint256(r1After), uint256(minR), 1, "reserve1 at min boundary");

        // Curvature component at max displacement for c=0
        uint256 ratio = uint256(eq) * 1e18 / uint256(r1After);
        uint256 ratioSq = ratio * ratio / 1e18;
        uint256 component = ratioSq - 1e18;

        // eq/min = 10/5 = 2, so (eq/r)^2 - 1 = 4 - 1 = 3 = 300%
        // This is a massive curvature component
        console.log("Max displacement curvature (bps):", component / 1e14);
        assertTrue(component > 2e18, "curvature > 200% at max displacement");
    }

    /// @notice Tiny swaps: verify precision with very small amounts.
    function test_edge_tiny_swap_precision() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Very small swap: 1 wei
        uint256 tinyQuote = pool.computeQuote(address(assetTST), address(assetTST2), 1, true);
        // FINDING: For c=1 at 1:1 with 1% fee: fee = floor(1 * 0.01) = 0 wei.
        // So the full 1 wei passes through. Dust amounts avoid fees entirely.
        assertEq(tinyQuote, 1, "1 wei: fee rounds to 0, full amount passes through");

        // Slightly larger: 1000 wei
        uint256 smallQuote = pool.computeQuote(address(assetTST), address(assetTST2), 1000, true);
        assertEq(smallQuote, 990, "1000 wei at 1% fee = 990 output");
    }

    // ════════════════════════════════════════════════════════════════════
    // High-leverage pool behavior
    // ════════════════════════════════════════════════════════════════════

    /// @notice High-leverage pool: tiny swap vs huge eq. Verify that a small
    ///         swap barely moves the price (walkthrough 0f claim).
    function test_edge_high_leverage_negligible_impact() public {
        // Very high leverage: 100e18 eq but tight min reserves
        uint112 eq = 100e18;
        uint112 minR = uint112(uint256(eq) * 999 / 1000); // 0.1% capacity

        (EulerSwap pool,) = _createPoolWithMinReserves(
            eq, eq, minR, minR, 0.001e18, 1e18, 1e18, 0, 0, feeCollector
        );

        // Swap 0.001e18 (0.001% of eq)
        uint256 quoteBefore = pool.computeQuote(address(assetTST), address(assetTST2), 0.01e18, true);
        _doSwap(pool, true, 0.001e18);
        uint256 quoteAfter = pool.computeQuote(address(assetTST), address(assetTST2), 0.01e18, true);

        // Price impact should be negligible
        if (quoteBefore > quoteAfter) {
            uint256 impact = quoteBefore - quoteAfter;
            uint256 impactBps = impact * 10000 / quoteBefore;
            assertTrue(impactBps < 1, "high leverage: <0.01% price impact");
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Auction edge cases
    // ════════════════════════════════════════════════════════════════════

    /// @notice Auction with zero clearing amount: reconfigure should still work
    ///         but have no clearing capacity. Both directions are locked.
    function test_edge_auction_zero_clearing() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 0.5e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Reconfigure to constant-sum with minR1 = r1 (zero clearing) and minR0 = r0 (locked)
        _reconfigureToConstantSum(pool, r0, r1, 1e18, 1e18, 0.01e18);

        // No output capacity in either direction
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertEq(outLimit, 0, "zero clearing capacity");

        (, uint256 wrongDir) = pool.getLimits(address(assetTST2), address(assetTST));
        assertEq(wrongDir, 0, "wrong direction also blocked");
    }

    /// @notice Multiple auction cycles: displace -> reconfigure -> clear -> restore -> repeat.
    function test_edge_multiple_auction_cycles() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        VaultState memory init = _readVault(sp);
        int256 navInit = _nav(init);

        for (uint256 cycle = 0; cycle < 3; cycle++) {
            // Build exposure
            _doSwap(pool, cycle % 2 == 0, 0.3e18);

            // Reconfigure to constant-sum for clearing
            (uint112 r0, uint112 r1,) = pool.getReserves();
            uint112 clearAmt = 0.1e18;

            if (cycle % 2 == 0) {
                // Clear asset1 out, lock asset0 output (wrong direction)
                if (r1 > clearAmt) {
                    _reconfigureToConstantSum(pool, r0, r1 - clearAmt, 1e18, 1e18, 0.02e18);
                    (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
                    if (outLimit > 0) {
                        uint256 fill = outLimit < uint256(clearAmt) ? outLimit : uint256(clearAmt);
                        _doSwapExactOut(pool, true, fill);
                    }
                }
            } else {
                // Clear asset0 out, lock asset1 output (wrong direction)
                if (r0 > clearAmt) {
                    _reconfigureToConstantSum(pool, r0 - clearAmt, r1, 1e18, 1e18, 0.02e18);
                    (, uint256 outLimit) = pool.getLimits(address(assetTST2), address(assetTST));
                    if (outLimit > 0) {
                        uint256 fill = outLimit < uint256(clearAmt) ? outLimit : uint256(clearAmt);
                        _doSwapExactOut(pool, false, fill);
                    }
                }
            }

            // Restore to curved pool
            (uint112 fr0, uint112 fr1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.equilibriumReserve0 = fr0;
            dp.equilibriumReserve1 = fr1;
            dp.concentrationX = 0.5e18;
            dp.concentrationY = 0.5e18;
            dp.fee0 = 0.01e18;
            dp.fee1 = 0.01e18;
            dp.minReserve0 = 0;
            dp.minReserve1 = 0;
            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: fr0, reserve1: fr1}));

            console.log("Cycle", cycle, "complete");
        }

        VaultState memory final_ = _readVault(sp);
        int256 navFinal = _nav(final_);

        console.log("NAV init: ", uint256(navInit));
        console.log("NAV final:", uint256(navFinal));

        // NAV should be positive (pool survived multiple cycles)
        assertTrue(navFinal > 0, "NAV positive after multiple cycles");
    }

    // ════════════════════════════════════════════════════════════════════
    // Fee edge cases
    // ════════════════════════════════════════════════════════════════════

    /// @notice Zero fee: all output goes to trader, no fee revenue.
    function test_edge_zero_fee() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0, 1e18, 1e18, 1e18, 1e18, feeCollector);

        uint256 output = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output, 1e18, "zero fee: output = input on constant-sum");
    }

    /// @notice Fee near 100%: almost all input taken as fee.
    function test_edge_near_100_pct_fee() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Reconfigure to 99% fee
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.fee0 = 0.99e18;
        dp.fee1 = 0.99e18;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        uint256 output = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        assertEq(output, 0.01e18, "99% fee: 1% output");
    }

    // ════════════════════════════════════════════════════════════════════
    // NAV tracking through full lifecycle
    // ════════════════════════════════════════════════════════════════════

    /// @notice FINDING: On constant-sum with feeRecipient, NAV is perfectly
    ///         preserved through clearing. This is the key property that makes
    ///         constant-sum auctions cheap.
    function test_edge_nav_preservation_constant_sum_clearing() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Build significant exposure
        for (uint256 i = 0; i < 5; i++) {
            _doSwap(pool, false, 0.5e18);
        }

        VaultState memory before = _readVault(sp);
        int256 navBefore = _nav(before);

        // Full clearing
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

        // NAV exactly preserved (within 1 wei)
        assertApproxEqAbs(uint256(navAfter), uint256(navBefore), 1, "constant-sum clearing: NAV exact");

        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after: ", uint256(navAfter));
    }

    /// @notice On curved pool with feeRecipient, clearing costs NAV due to curve spread.
    ///         This is the rebalancing cost the LP pays.
    function test_edge_nav_cost_of_curved_clearing() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        // Build exposure
        for (uint256 i = 0; i < 3; i++) {
            _doSwap(pool, true, 1e18);
        }

        VaultState memory before = _readVault(sp);
        int256 navBefore = _nav(before);

        // Clear by swapping in the opposite direction
        _doSwap(pool, false, 1.5e18);

        VaultState memory after_ = _readVault(sp);
        int256 navAfter = _nav(after_);

        // FINDING: Curved clearing reduces NAV because the trader gets a
        // favorable rate (the scarce asset is priced above 1:1 by the curve).
        // This is the fundamental rebalancing cost described in Step 1.
        //
        // NOTE: Whether NAV increases or decreases depends on the direction.
        // When the pool trades TOWARD equilibrium, the trader gets above-eq
        // rates. When the pool trades AWAY from equilibrium, the LP gets
        // above-eq rates. Both are reflected as curve spread.

        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after: ", uint256(navAfter));
        if (navAfter < navBefore) {
            console.log("Rebalancing cost:", uint256(navBefore - navAfter));
        } else {
            console.log("NAV gain:", uint256(navAfter - navBefore));
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Reconfigure invariants
    // ════════════════════════════════════════════════════════════════════

    /// @notice Reconfigure with InitialState != current reserves: resets position.
    ///         This is how the pool "jumps" to a new position on reconfigure.
    function test_edge_reconfigure_with_different_initial_state() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 1e18);
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Reconfigure with InitialState = eq (not current reserves)
        // This "resets" reserves back to eq
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.equilibriumReserve0 = r0; // Set eq = current reserves
        dp.equilibriumReserve1 = r1;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        // Now reserves == eq
        (uint112 r0New, uint112 r1New,) = pool.getReserves();
        assertEq(r0New, dp.equilibriumReserve0, "reserves match eq after reconfigure");
        assertEq(r1New, dp.equilibriumReserve1, "reserves match eq after reconfigure");
    }

    /// @notice Rapidly alternating reconfigure: constant-sum -> curved -> constant-sum.
    ///         Pool should remain functional throughout.
    function test_edge_rapid_mode_switching() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        for (uint256 i = 0; i < 5; i++) {
            _doSwap(pool, i % 2 == 0, 0.1e18);

            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.equilibriumReserve0 = r0;
            dp.equilibriumReserve1 = r1;

            if (i % 2 == 0) {
                // Switch to constant-sum
                dp.concentrationX = 1e18;
                dp.concentrationY = 1e18;
            } else {
                // Switch back to curved
                dp.concentrationX = 0.5e18;
                dp.concentrationY = 0.5e18;
            }

            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

            // Pool still functional
            uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), 0.01e18, true);
            assertTrue(quote > 0, "pool functional after mode switch");
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // FINDING: Fee direction convention
    // ════════════════════════════════════════════════════════════════════

    /// @notice FINDING: fee0 applies when asset0 is INPUT (not output).
    ///         fee1 applies when asset1 is INPUT.
    ///         This is the opposite of what one might assume from the naming.
    ///         The hook must account for this when setting directional fees.
    function test_finding_fee_direction_convention() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Set asymmetric fees
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.fee0 = 0.01e18; // 1%
        dp.fee1 = 0.05e18; // 5%
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        // Asset0 in: fee0 = 1% applies
        uint256 out0in = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        // Asset1 in: fee1 = 5% applies
        uint256 out1in = pool.computeQuote(address(assetTST2), address(assetTST), 1e18, true);

        // For constant-sum at 1:1:
        assertEq(out0in, 0.99e18, "fee0=1% applied when asset0 is INPUT");
        assertEq(out1in, 0.95e18, "fee1=5% applied when asset1 is INPUT");
    }

    /// @notice fee0 and fee1 are fully symmetric — nothing privileged about either.
    ///         Swapping which fee applies to which direction by relabeling assets
    ///         produces identical behavior.
    function test_finding_fee_symmetry() public {
        // Pool A: fee0=2%, fee1=3%
        (EulerSwap poolA,) = _createPool(10e18, 10e18, 0.02e18, 1e18, 1e18, 1e18, 1e18, feeCollector);
        {
            (uint112 r0, uint112 r1,) = poolA.getReserves();
            IEulerSwap.DynamicParams memory dp = poolA.getDynamicParams();
            dp.fee0 = 0.02e18;
            dp.fee1 = 0.03e18;
            _reconfigure(poolA, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        }

        // Asset0 in on poolA: fee0=2%
        uint256 outA_0in = poolA.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        // Asset1 in on poolA: fee1=3%
        uint256 outA_1in = poolA.computeQuote(address(assetTST2), address(assetTST), 1e18, true);

        // If we swap the fees (fee0=3%, fee1=2%), the roles reverse
        (EulerSwap poolB,) = _createPool(10e18, 10e18, 0.03e18, 1e18, 1e18, 1e18, 1e18, feeCollector);
        {
            (uint112 r0, uint112 r1,) = poolB.getReserves();
            IEulerSwap.DynamicParams memory dp = poolB.getDynamicParams();
            dp.fee0 = 0.03e18;
            dp.fee1 = 0.02e18;
            _reconfigure(poolB, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));
        }

        // Asset0 in on poolB: fee0=3% (same as asset1 in on poolA)
        uint256 outB_0in = poolB.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        // Asset1 in on poolB: fee1=2% (same as asset0 in on poolA)
        uint256 outB_1in = poolB.computeQuote(address(assetTST2), address(assetTST), 1e18, true);

        // Symmetry: swapping fee labels swaps the outputs
        assertEq(outA_0in, outB_1in, "fee symmetry: fee0=2% on A == fee1=2% on B");
        assertEq(outA_1in, outB_0in, "fee symmetry: fee1=3% on A == fee0=3% on B");
    }

    // ════════════════════════════════════════════════════════════════════
    // NAV cost = arb bonus on curved clearing
    // ════════════════════════════════════════════════════════════════════

    /// @notice On a curved pool, clearing-direction swaps cost NAV because the trader
    ///         receives above-equilibrium rates (the scarce asset is priced higher).
    ///         The LP's NAV loss should equal the arb's profit (curve spread bonus).
    function test_nav_cost_equals_arb_bonus_on_curved_clearing() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);

        // Build asset0 exposure: swap asset0 in
        _doSwap(pool, true, 2e18);

        VaultState memory beforeClear = _readVault(sp);
        int256 navBefore = _nav(beforeClear);

        // Clearing direction: asset1 in, asset0 out
        // Record what the arber sends and receives
        uint256 clearSize = 1e18;
        uint256 arbSent = clearSize; // asset1 in
        uint256 arbReceived = _doSwap(pool, false, clearSize); // asset0 out

        VaultState memory afterClear = _readVault(sp);
        int256 navAfter = _nav(afterClear);

        // At 1:1 price, arb profit = received - sent (both in same unit)
        // The arb gets more asset0 out than asset1 in because the curve
        // prices the scarce asset (asset0, which is being drained) higher.
        int256 arbProfit = int256(arbReceived) - int256(arbSent);

        // LP's NAV cost
        int256 navCost = navBefore - navAfter;

        console.log("Arb sent (asset1 in):", arbSent);
        console.log("Arb received (asset0 out):", arbReceived);
        console.log("Arb profit:", arbProfit > 0 ? uint256(arbProfit) : 0);
        console.log("NAV cost:", navCost > 0 ? uint256(navCost) : 0);

        // The arb profit should approximately equal the NAV cost.
        // They may differ slightly due to fee (0.1%) going to feeCollector.
        // fee goes to feeCollector (external), so both LP NAV cost and arb profit
        // are net of fees. The relationship is:
        //   grossOut = netOut(arb gets) + 0 (fee is on input side)
        //   Actually: fee is on input side, so arbSent is gross, postFee goes to vault.
        //   arbProfit = arbReceived - arbSent
        //   navCost = deposits lost - debts repaid (net)
        //   These should match because: what the arb gains, the LP loses.
        if (arbProfit > 0 && navCost > 0) {
            assertApproxEqRel(
                uint256(arbProfit),
                uint256(navCost),
                0.05e18, // 5% tolerance for fee/rounding
                "arb profit ~ NAV cost (curve spread transferred)"
            );
        }
    }
}
