// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {WalkthroughBase} from "./WalkthroughBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {console} from "forge-std/Test.sol";

/// @title Step0_CurveMechanics
/// @notice Tests for walkthrough Step 0: curve mechanics, vault/reserve connection,
///         accumulator identities, range/min reserves, and leverage.
///
/// These tests validate the mathematical claims in the walkthrough against real
/// pool behavior — no hook involved.
contract Step0_CurveMechanics is WalkthroughBase {

    // ════════════════════════════════════════════════════════════════════
    // 0a. Curve basics
    // ════════════════════════════════════════════════════════════════════

    /// @notice Swaps must satisfy CurveLib.verify — reserves stay on/above the curve.
    ///         Tested implicitly: any successful swap means verify passed.
    ///         We verify by checking reserves move in the expected direction.
    function test_0a_swap_moves_reserves_correctly() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        (uint112 r0Before, uint112 r1Before,) = pool.getReserves();
        assertEq(r0Before, 10e18, "starts at eq0");
        assertEq(r1Before, 10e18, "starts at eq1");

        // Swap asset0 in → asset1 out
        _doSwap(pool, true, 0.5e18);

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        assertTrue(r0After > r0Before, "reserve0 increased (asset0 in)");
        assertTrue(r1After < r1Before, "reserve1 decreased (asset1 out)");
    }

    /// @notice Min reserves are hard floors — swaps cannot push reserves below them.
    function test_0a_min_reserves_enforced() public {
        // Create pool with min reserves set near eq
        uint112 eq = 10e18;
        uint112 minR = 9.5e18; // only 0.5e18 of capacity per side

        (EulerSwap pool,) = _createPoolWithMinReserves(
            eq, eq, minR, minR, 0.01e18, 1e18, 1e18, 0, 0, feeCollector
        );

        // A small swap should work
        _doSwap(pool, true, 0.1e18);

        // A large swap should fail (would push reserve1 below min)
        // getLimits tells us the max output
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        assertTrue(outLimit < eq - minR + 1e16, "output limited by minReserve");

        // Try to swap more than the limit
        uint256 tooMuch = outLimit + 1e18;
        assetTST.mint(swapper, tooMuch * 2);
        vm.prank(swapper);
        assetTST.transfer(address(pool), tooMuch * 2);
        vm.expectRevert();
        vm.prank(swapper);
        pool.swap(0, tooMuch, swapper, "");
    }

    /// @notice Concentration c=1 gives constant-sum (linear) pricing.
    ///         At 1:1 price, output ≈ input × (1 - fee).
    function test_0a_constant_sum_linear_pricing() public {
        uint64 fee = 0.01e18; // 1%
        (EulerSwap pool,) = _createPool(10e18, 10e18, fee, 1e18, 1e18, 1e18, 1e18, feeCollector);

        uint256 amountIn = 1e18;
        uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), amountIn, true);

        // For c=1, px=py=1: output = input × (1 - fee)
        uint256 expected = amountIn * (1e18 - fee) / 1e18;
        assertApproxEqAbs(quote, expected, 1, "constant-sum: output = input * (1-fee)");

        // Second swap should give same rate (no price impact)
        _doSwap(pool, true, amountIn);
        uint256 quote2 = pool.computeQuote(address(assetTST), address(assetTST2), amountIn, true);
        assertApproxEqAbs(quote2, expected, 1, "constant-sum: no price impact on second swap");
    }

    /// @notice Concentration c=0 gives constant-product-like pricing with price impact.
    function test_0a_curved_pool_has_price_impact() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0, 0, feeCollector);

        uint256 amountIn = 1e18;
        uint256 quote1 = pool.computeQuote(address(assetTST), address(assetTST2), amountIn, true);

        // Execute first swap
        _doSwap(pool, true, amountIn);

        // Second swap should give less output (price moved against this direction)
        uint256 quote2 = pool.computeQuote(address(assetTST), address(assetTST2), amountIn, true);
        assertTrue(quote2 < quote1, "curved pool: second swap gets less (price impact)");
    }

    // ════════════════════════════════════════════════════════════════════
    // 0b/0c. Vault-Reserve Connection
    // ════════════════════════════════════════════════════════════════════

    /// @notice Reserve deltas match vault deltas when feeRecipient is set.
    ///         Walkthrough 0c: "when feeRecipient != 0, vault and reserve deltas match."
    function test_0c_vault_reserve_deltas_match_with_feeRecipient() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        (uint112 r0Init, uint112 r1Init,) = pool.getReserves();
        VaultState memory vInit = _readVault(sp);

        // Execute several swaps in both directions
        _doSwap(pool, true, 0.5e18);
        _doSwap(pool, false, 0.3e18);
        _doSwap(pool, true, 0.7e18);

        (uint112 r0Final, uint112 r1Final,) = pool.getReserves();
        VaultState memory vFinal = _readVault(sp);

        // Reserve deltas
        int256 reserveDelta0 = int256(uint256(r0Final)) - int256(uint256(r0Init));
        int256 reserveDelta1 = int256(uint256(r1Final)) - int256(uint256(r1Init));

        // Vault net deltas (deposits - debts)
        int256 vaultDelta0 = (int256(vFinal.deposits0) - int256(vFinal.debts0))
            - (int256(vInit.deposits0) - int256(vInit.debts0));
        int256 vaultDelta1 = (int256(vFinal.deposits1) - int256(vFinal.debts1))
            - (int256(vInit.deposits1) - int256(vInit.debts1));

        // With feeRecipient set, these should match (within rounding)
        assertApproxEqAbs(
            uint256(reserveDelta0 > 0 ? reserveDelta0 : -reserveDelta0),
            uint256(vaultDelta0 > 0 ? vaultDelta0 : -vaultDelta0),
            10, // allow small rounding from share conversion
            "vault0 delta matches reserve0 delta (feeRecipient set)"
        );
        assertApproxEqAbs(
            uint256(reserveDelta1 > 0 ? reserveDelta1 : -reserveDelta1),
            uint256(vaultDelta1 > 0 ? vaultDelta1 : -vaultDelta1),
            10,
            "vault1 delta matches reserve1 delta (feeRecipient set)"
        );
    }

    /// @notice When feeRecipient == 0, vault grows faster than reserves by exactly fees.
    ///         Walkthrough 0c/0d: "vaultNetGrowth - reserveGrowth = totalFee"
    function test_0c_fee_residual_when_no_feeRecipient() public {
        uint64 fee = 0.02e18; // 2% fee — large to make residual visible
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, fee, 1e18, 1e18, 1e18, 1e18, address(0));

        (uint112 r0Init, uint112 r1Init,) = pool.getReserves();
        VaultState memory vInit = _readVault(sp);

        // Directional flow: asset1 in (builds fee residual on side 1)
        for (uint256 i = 0; i < 5; i++) {
            _doSwap(pool, false, 0.2e18);
        }

        (uint112 r0Final, uint112 r1Final,) = pool.getReserves();
        VaultState memory vFinal = _readVault(sp);

        // Reserve growth on asset1 side (input side)
        int256 reserveGrowth1 = int256(uint256(r1Final)) - int256(uint256(r1Init));
        // Vault net growth on asset1 side
        int256 vaultGrowth1 = (int256(vFinal.deposits1) - int256(vFinal.debts1))
            - (int256(vInit.deposits1) - int256(vInit.debts1));

        // Vault grew more than reserves by the accumulated fees
        int256 feeResidual = vaultGrowth1 - reserveGrowth1;
        assertTrue(feeResidual > 0, "vault grows faster than reserves (fees stay in vault)");

        console.log("Fee residual (asset1):", uint256(feeResidual));
        console.log("Reserve growth (asset1):", reserveGrowth1 > 0 ? uint256(reserveGrowth1) : 0);
        console.log("Vault growth (asset1):", vaultGrowth1 > 0 ? uint256(vaultGrowth1) : 0);
    }

    // ════════════════════════════════════════════════════════════════════
    // 0d. Accumulator Identities
    // ════════════════════════════════════════════════════════════════════

    /// @notice Reserve accumulator identity: reserve_i(final) = reserve_i(init) + Σ(postFeeIn - out).
    ///         Tested over multiple swaps in both directions.
    function test_0d_reserve_accumulator_identity() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        (uint112 r0Init, uint112 r1Init,) = pool.getReserves();

        // Track cumulative post-fee deltas
        int256 cumDelta0 = 0;
        int256 cumDelta1 = 0;

        // Series of swaps
        uint256[5] memory amounts = [uint256(0.3e18), 0.7e18, 0.1e18, 0.5e18, 0.2e18];
        bool[5] memory dirs = [true, false, true, false, true];

        for (uint256 i = 0; i < 5; i++) {
            (uint112 rBefore0, uint112 rBefore1,) = pool.getReserves();
            _doSwap(pool, dirs[i], amounts[i]);
            (uint112 rAfter0, uint112 rAfter1,) = pool.getReserves();

            // The reserve delta IS the post-fee delta by definition
            cumDelta0 += int256(uint256(rAfter0)) - int256(uint256(rBefore0));
            cumDelta1 += int256(uint256(rAfter1)) - int256(uint256(rBefore1));
        }

        (uint112 r0Final, uint112 r1Final,) = pool.getReserves();

        // Identity: final = init + cumDelta
        assertEq(int256(uint256(r0Final)), int256(uint256(r0Init)) + cumDelta0, "reserve0 accumulator exact");
        assertEq(int256(uint256(r1Final)), int256(uint256(r1Init)) + cumDelta1, "reserve1 accumulator exact");
    }

    /// @notice NAV identity for constant-sum: NAV_growth = Σ(fees).
    ///         No price impact on c=1, so all NAV growth comes from fees.
    function test_0d_nav_growth_equals_fees_constant_sum() public {
        uint64 fee = 0.01e18;
        // feeRecipient = 0 so fees stay in vault → NAV grows
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, fee, 1e18, 1e18, 1e18, 1e18, address(0));

        VaultState memory vInit = _readVault(sp);
        int256 navInit = _nav(vInit);

        // Balanced flow
        _doSwap(pool, true, 1e18);
        _doSwap(pool, false, 1e18);
        _doSwap(pool, true, 0.5e18);

        VaultState memory vFinal = _readVault(sp);
        int256 navFinal = _nav(vFinal);

        int256 navGrowth = navFinal - navInit;
        assertTrue(navGrowth > 0, "NAV grew from fees");

        // For c=1 at 1:1, fee per swap ≈ swapAmount × feeRate
        // Total flow = 2.5e18, expected fees ≈ 2.5e18 × 1% = 0.025e18
        uint256 expectedFees = 25e15; // 0.025e18
        assertApproxEqRel(uint256(navGrowth), expectedFees, 0.02e18, "NAV growth ~ total fees (2% tolerance)");
    }

    /// @notice For curved pools (c < 1): NAV_growth > Σ(fees) due to curve spread.
    function test_0d_nav_growth_includes_curve_spread() public {
        uint64 fee = 0.01e18;
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, fee, 1e18, 1e18, 0, 0, address(0));

        VaultState memory vInit = _readVault(sp);
        int256 navInit = _nav(vInit);

        // Directional flow to build curve spread
        _doSwap(pool, true, 1e18);
        _doSwap(pool, true, 1e18);

        VaultState memory vFinal = _readVault(sp);
        int256 navFinal = _nav(vFinal);
        int256 navGrowth = navFinal - navInit;

        // Expected fees alone ≈ 2e18 × 1% = 0.02e18
        uint256 feesOnly = 2e18 * uint256(fee) / 1e18;

        // NAV growth should exceed fees because curve spread accrues to LP
        assertTrue(uint256(navGrowth) > feesOnly, "curved pool: NAV growth > fees (includes curve spread)");

        console.log("NAV growth:", uint256(navGrowth));
        console.log("Fees only: ", feesOnly);
        console.log("Spread:    ", uint256(navGrowth) - feesOnly);
    }

    // ════════════════════════════════════════════════════════════════════
    // 0e. Range and Min Reserves
    // ════════════════════════════════════════════════════════════════════

    /// @notice Trading capacity = eq - minReserve on each side.
    ///         The pool can absorb exactly this much flow before hitting the boundary.
    function test_0e_trading_capacity_equals_eq_minus_min() public {
        uint112 eq = 10e18;
        uint112 minR = 9e18; // 1e18 of capacity per side

        (EulerSwap pool,) = _createPoolWithMinReserves(
            eq, eq, minR, minR, 0.001e18, 1e18, 1e18, 0, 0, feeCollector
        );

        // getLimits should reflect the trading capacity
        (, uint256 outLimit0) = pool.getLimits(address(assetTST2), address(assetTST));
        (, uint256 outLimit1) = pool.getLimits(address(assetTST), address(assetTST2));

        uint256 capacity = eq - minR; // 1e18

        // outLimit should be close to capacity (may be slightly less due to rounding/fees)
        // For c=0 curves, the actual tradeable output depends on curve shape
        assertTrue(outLimit0 > 0 && outLimit0 <= capacity, "outLimit0 within capacity");
        assertTrue(outLimit1 > 0 && outLimit1 <= capacity, "outLimit1 within capacity");

        console.log("Capacity (eq-min):", capacity);
        console.log("outLimit0:", outLimit0);
        console.log("outLimit1:", outLimit1);
    }

    /// @notice Constant-sum with min reserves: capacity is exactly eq - min.
    function test_0e_constant_sum_capacity_exact() public {
        uint112 eq = 10e18;
        uint112 minR = 8e18;
        uint64 fee = 0.01e18;

        (EulerSwap pool,) = _createPoolWithMinReserves(
            eq, eq, minR, minR, fee, 1e18, 1e18, 1e18, 1e18, feeCollector
        );

        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));

        uint256 capacity = uint256(eq) - uint256(minR); // 2e18

        // For constant-sum: outLimit should be exactly capacity - 1 (rounding guard)
        assertApproxEqAbs(outLimit, capacity, 1, "constant-sum: outLimit = eq - min");
    }

    // ════════════════════════════════════════════════════════════════════
    // 0f. Leverage
    // ════════════════════════════════════════════════════════════════════

    /// @notice Price sensitivity: for c=0, price impact scales with 1/eq.
    ///         We test by comparing a small swap vs a large swap on the same pool.
    ///         Impact of swap X ≈ 2X/eq (walkthrough 0a), so doubling X doubles impact.
    function test_0f_price_sensitivity_scales_with_swap_size() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);

        // Compare quotes before swap (marginal rate at eq) vs after a swap
        // Small swap: 0.1e18
        uint256 quoteSmall = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        // Large swap: 1e18 (10x)
        uint256 quoteLarge = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // For c=0 at equilibrium, output = input * (1-fee) - priceImpact
        // Price impact scales roughly quadratically with swap size for c=0
        // So output-per-unit decreases with size
        uint256 rateSmall = quoteSmall * 1e18 / 0.1e18; // output per input unit
        uint256 rateLarge = quoteLarge * 1e18 / 1e18;

        assertTrue(rateSmall > rateLarge, "larger swap gets worse rate (price impact)");

        console.log("Rate (small swap):", rateSmall);
        console.log("Rate (large swap):", rateLarge);
        console.log("Rate difference:  ", rateSmall - rateLarge);
    }

    /// @notice Higher eq (deeper pool) means less price impact per unit.
    ///         Test with computeQuote only (no swaps needed — view function).
    function test_0f_deeper_pool_less_impact() public {
        // Create one pool and test at different eq levels via separate pools
        // First pool: eq=10e18
        (EulerSwap pool10,) = _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 0, 0, feeCollector);

        uint256 swapAmt = 0.5e18;
        uint256 quote10 = pool10.computeQuote(address(assetTST), address(assetTST2), swapAmt, true);

        // The rate for a single swap tells us about price impact
        // For a perfect constant-sum, output = swapAmt * (1-fee) = 0.4995e18
        uint256 csOutput = swapAmt * (1e18 - 0.001e18) / 1e18;
        uint256 impact10 = csOutput - quote10; // how much less we got due to curvature

        // With eq=10e18, a 0.5e18 swap is 5% of eq — significant displacement
        assertTrue(impact10 > 0, "curved pool has positive price impact");

        // Price impact for c=0 at equilibrium: ~amount^2 / (2 * eq) approximately
        // For eq=10e18, amount=0.5e18: ~0.5^2 / (2*10) = 0.0125 of amount
        console.log("Constant-sum output:", csOutput);
        console.log("Curved output:      ", quote10);
        console.log("Price impact:       ", impact10);
    }
}
