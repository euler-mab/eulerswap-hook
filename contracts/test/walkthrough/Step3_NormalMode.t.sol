// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {WalkthroughBase} from "./WalkthroughBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {console} from "forge-std/Test.sol";

/// @title Step3_NormalMode
/// @notice Tests for walkthrough Step 3: recenter mechanics (used at auction end),
///         oracle-reactive fee concepts, and deploy protection surcharge.
///
/// These tests validate the recenter operation itself (eq=reserves, priceY update,
/// min reserve recomputation) and the fee/surcharge math — without a hook.
/// The hook orchestrates WHEN to recenter; these tests verify WHAT happens.
contract Step3_NormalMode is WalkthroughBase {

    // ════════════════════════════════════════════════════════════════════
    // 3a. Recenter: eq = current reserves
    // ════════════════════════════════════════════════════════════════════

    /// @notice After recenter (eq = reserves), pool is at equilibrium.
    ///         Reserves == eq for both sides.
    function test_3a_recenter_sets_eq_to_reserves() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Displace
        _doSwap(pool, true, 1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();

        // Before recenter: reserves != eq
        assertTrue(r0 != dp.equilibriumReserve0, "displaced: reserve0 != eq0");

        // Recenter: eq = current reserves
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        // After recenter: eq == reserves
        IEulerSwap.DynamicParams memory dpNew = pool.getDynamicParams();
        (uint112 r0New, uint112 r1New,) = pool.getReserves();

        assertEq(dpNew.equilibriumReserve0, r0New, "post-recenter: eq0 == reserve0");
        assertEq(dpNew.equilibriumReserve1, r1New, "post-recenter: eq1 == reserve1");
    }

    /// @notice Recenter preserves vault state. Only curve params change.
    function test_3a_recenter_preserves_vault_state() public {
        (EulerSwap pool, IEulerSwap.StaticParams memory sp) =
            _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 1e18);

        VaultState memory before = _readVault(sp);

        // Recenter
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        VaultState memory after_ = _readVault(sp);

        assertEq(after_.deposits0, before.deposits0, "deposits0 unchanged");
        assertEq(after_.deposits1, before.deposits1, "deposits1 unchanged");
        assertEq(after_.debts0, before.debts0, "debts0 unchanged");
        assertEq(after_.debts1, before.debts1, "debts1 unchanged");
    }

    /// @notice After recenter, the pool can trade in both directions from the new eq.
    function test_3a_recenter_enables_bidirectional_trading() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        // Displace heavily in one direction
        _doSwap(pool, true, 3e18);

        // Recenter
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        // Both directions should have capacity
        (uint256 inLimit0,) = pool.getLimits(address(assetTST), address(assetTST2));
        (uint256 inLimit1,) = pool.getLimits(address(assetTST2), address(assetTST));
        assertTrue(inLimit0 > 0, "asset0-in has capacity after recenter");
        assertTrue(inLimit1 > 0, "asset1-in has capacity after recenter");
    }

    /// @notice Multiple recenters: each one resets the pool to fresh equilibrium.
    function test_3a_multiple_recenters() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        for (uint256 i = 0; i < 5; i++) {
            // Swap in alternating directions
            _doSwap(pool, i % 2 == 0, 0.3e18);

            // Recenter after each swap
            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
            dp.equilibriumReserve0 = r0;
            dp.equilibriumReserve1 = r1;
            _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

            // Verify eq = reserves
            IEulerSwap.DynamicParams memory dpNew = pool.getDynamicParams();
            assertEq(dpNew.equilibriumReserve0, r0, "eq0 = reserve0 after recenter");
        }
    }

    /// @notice Recenter with priceY update (oracle price change).
    ///         Simulates the hook updating priceY to match a new oracle reading.
    function test_3a_recenter_with_price_update() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        _doSwap(pool, true, 0.5e18);

        IEulerSwap.DynamicParams memory dpOld = pool.getDynamicParams();
        uint80 oldPriceY = dpOld.priceY;

        // Recenter with updated priceY (simulate oracle moved 1%)
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = dpOld;
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        dp.priceY = uint80(uint256(oldPriceY) * 101 / 100); // +1%
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        IEulerSwap.DynamicParams memory dpNew = pool.getDynamicParams();
        assertTrue(dpNew.priceY > oldPriceY, "priceY updated");

        // Pool still works
        uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), 0.1e18, true);
        assertTrue(quote > 0, "pool operational after price update");
    }

    // ════════════════════════════════════════════════════════════════════
    // 3a (extended). Min reserve recomputation after recenter
    // ════════════════════════════════════════════════════════════════════

    /// @notice After recenter, min reserves should be recomputed from new eq + range.
    ///         Formula: minReserve = eq / sqrt(1 + r/(1-c))
    function test_3a_min_reserves_recomputed_after_recenter() public {
        uint112 eq = 10e18;
        uint112 minR = 9e18; // range creates 1e18 of capacity

        (EulerSwap pool,) = _createPoolWithMinReserves(
            eq, eq, minR, minR, 0.01e18, 1e18, 1e18, 0, 0, feeCollector
        );

        // Displace
        _doSwap(pool, true, 0.3e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Recenter with new min reserves proportional to new eq
        // Maintaining the same ratio: minR/eq ≈ 0.9
        uint112 newMin0 = uint112(uint256(r0) * 9 / 10);
        uint112 newMin1 = uint112(uint256(r1) * 9 / 10);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        dp.minReserve0 = newMin0;
        dp.minReserve1 = newMin1;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        IEulerSwap.DynamicParams memory dpNew = pool.getDynamicParams();
        assertEq(dpNew.minReserve0, newMin0, "minReserve0 updated");
        assertEq(dpNew.minReserve1, newMin1, "minReserve1 updated");

        // Capacity recalculated
        (, uint256 outLimit) = pool.getLimits(address(assetTST), address(assetTST2));
        uint256 expectedCapacity = uint256(r1) - uint256(newMin1);
        assertApproxEqAbs(outLimit, expectedCapacity, 1, "capacity reflects new min reserves");
    }

    // ════════════════════════════════════════════════════════════════════
    // 3b. Oracle-reactive fee concepts (math only, no hook)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Fee changes the LP's cost/revenue per swap.
    ///         Higher fee = more revenue but less competitive routing.
    function test_3b_fee_impact_on_output() public {
        // Low fee pool
        (EulerSwap lowFee,) = _createPool(10e18, 10e18, 0.001e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Swap on low fee pool
        uint256 outputLow = lowFee.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // Create high fee pool (must be separate — only one pool per holder)
        // Instead, we reconfigure the same pool with higher fee
        (uint112 r0, uint112 r1,) = lowFee.getReserves();
        IEulerSwap.DynamicParams memory dp = lowFee.getDynamicParams();
        dp.fee0 = 0.05e18; // 5%
        dp.fee1 = 0.05e18;
        _reconfigure(lowFee, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        uint256 outputHigh = lowFee.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        assertTrue(outputLow > outputHigh, "lower fee = more output for trader");

        console.log("Output at 0.1% fee:", outputLow);
        console.log("Output at 5% fee:  ", outputHigh);
        console.log("Difference:        ", outputLow - outputHigh);
    }

    /// @notice Fee reconfiguration is possible mid-life (the hook would do this).
    function test_3b_fee_reconfigurable() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18, feeCollector);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.fee0, 0.01e18, "initial fee = 1%");

        // Update fee
        (uint112 r0, uint112 r1,) = pool.getReserves();
        dp.fee0 = 0.005e18;
        dp.fee1 = 0.005e18;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        dp = pool.getDynamicParams();
        assertEq(dp.fee0, 0.005e18, "fee updated to 0.5%");
    }

    /// @notice Asymmetric fees: fee0 != fee1. The hook can set different fees
    ///         for each direction (clearing vs non-clearing).
    function test_3b_asymmetric_fees() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        // FINDING: fee0 applies when asset0 is the INPUT (not output).
        // fee1 applies when asset1 is the INPUT.
        dp.fee0 = 0.001e18; // 0.1% fee when asset0 is INPUT
        dp.fee1 = 0.05e18;  // 5% fee when asset1 is INPUT
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        // Asset0 in: fee0 = 0.1% applies -> swapper keeps most
        uint256 outputWhenAsset0In = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        // Asset1 in: fee1 = 5% applies -> swapper loses more
        uint256 outputWhenAsset1In = pool.computeQuote(address(assetTST2), address(assetTST), 1e18, true);

        console.log("Output (asset0 in, fee0=0.1%):", outputWhenAsset0In);
        console.log("Output (asset1 in, fee1=5%):  ", outputWhenAsset1In);

        // Lower fee direction gets more output
        assertTrue(outputWhenAsset0In > outputWhenAsset1In, "low-fee direction gives more output");
    }

    // ════════════════════════════════════════════════════════════════════
    // 3c. Deploy protection surcharge (concept)
    // ════════════════════════════════════════════════════════════════════

    /// @notice High initial fee protects against exploitation at deployment.
    ///         The fee should make swaps unattractive until price is established.
    function test_3c_high_initial_fee_as_protection() public {
        // Start with a pool at low fee, then reconfigure to high fee
        // (Simulates: hook would set fee = baseFee + surcharge)
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Output at normal 1% fee
        uint256 outputNormal = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // Reconfigure to 5% fee (simulating deploy surcharge)
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.fee0 = 0.05e18;
        dp.fee1 = 0.05e18;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        uint256 outputProtected = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // High fee significantly reduces output
        assertTrue(outputNormal > outputProtected, "high fee reduces output");
        uint256 diff = outputNormal - outputProtected;
        assertTrue(diff > 0.03e18, "fee difference > 3% (deters exploitation)");

        console.log("Output at 1% fee: ", outputNormal);
        console.log("Output at 5% fee: ", outputProtected);
        console.log("Difference:       ", diff);
    }

    /// @notice Fee can be reduced over time (simulating surcharge decay).
    ///         After reducing fee, output improves.
    function test_3c_surcharge_decay_via_fee_reduction() public {
        (EulerSwap pool,) = _createPool(10e18, 10e18, 0.05e18, 1e18, 1e18, 1e18, 1e18, feeCollector);

        // Output at 5% fee
        uint256 outputHigh = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        // Reduce fee to 0.5% (simulating surcharge decayed)
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        dp.fee0 = 0.005e18;
        dp.fee1 = 0.005e18;
        _reconfigure(pool, dp, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}));

        uint256 outputLow = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);

        assertTrue(outputLow > outputHigh, "reduced fee improves output");
        console.log("Output at 5%:   ", outputHigh);
        console.log("Output at 0.5%: ", outputLow);
        console.log("Improvement:    ", outputLow - outputHigh);
    }
}
