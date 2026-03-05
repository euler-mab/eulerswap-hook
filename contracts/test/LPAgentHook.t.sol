// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHook} from "../src/LPAgentHook.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

contract LPAgentHookTest is EulerSwapTestBase {
    LPAgentHook hook;
    EulerSwap pool;

    uint64 constant BASE_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 100e14; // 100 bps
    uint64 constant MIN_FEE = 1e14; // 1 bp
    uint256 constant MISMATCH_SCALE = 10e18; // 10x mismatch multiplier

    function setUp() public override {
        super.setUp();

        // 1. Create pool without hook
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        // 2. Deploy hook pointing at pool
        hook = new LPAgentHook(address(pool), address(this), BASE_FEE, MAX_FEE, MIN_FEE, MISMATCH_SCALE);

        // 3. Reconfigure pool to install hook
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: dParams.equilibriumReserve0, reserve1: dParams.equilibriumReserve1});

        vm.prank(holder);
        IEVC(evc).call(
            address(pool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, initialState))
        );
    }

    // --- getFee tests ---

    function test_getFee_symmetric_at_equilibrium() public view {
        // At equilibrium, reserves match oracle → mismatch ≈ 0 → both directions get baseFee
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 fee0In = hook.getFee(true, r0, r1, false);
        uint64 fee1In = hook.getFee(false, r0, r1, false);

        // Both should be close to baseFee (small rounding allowed)
        assertApproxEqAbs(fee0In, BASE_FEE, 1e12, "fee0In should be ~baseFee at equilibrium");
        assertApproxEqAbs(fee1In, BASE_FEE, 1e12, "fee1In should be ~baseFee at equilibrium");
    }

    function test_getFee_asymmetric_when_mispriced() public {
        // Change oracle price so asset0 is worth 1.1 asset1 (oracle > marginal)
        // Pool still has 10:10 reserves (marginal = 1.0)
        // Oracle says 1.1 → pool underprices asset0 on output
        oracle.setPrice(address(assetTST), unitOfAccount, 1.1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false); // selling asset0 (cheap side)
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false); // buying asset0 (expensive side)

        // oracle > marginal → pool underprices asset0 (poolUnderpriced0=true):
        //   asset0 input → LOW fee  (pool receives the cheap asset — welcome flow)
        //   asset1 input → HIGH fee (pool gives away underpriced asset0 — adverse flow)
        assertTrue(feeAsset1In > feeAsset0In, "should charge more to buy underpriced asset0");
        assertTrue(feeAsset1In > BASE_FEE, "high side should exceed base fee");
    }

    function test_getFee_returns_maxFee_when_paused() public {
        hook.setPaused(true);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);

        assertEq(fee, MAX_FEE, "paused should return maxFee");
    }

    function test_getFee_clamped_to_bounds() public {
        // Set massive price deviation to test clamping
        oracle.setPrice(address(assetTST), unitOfAccount, 10e18); // 10x mismatch

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false); // high side

        assertEq(fee, MAX_FEE, "fee should be clamped to maxFee");
    }

    // --- afterSwap tests ---

    function test_afterSwap_tracks_stats() public {
        // Execute a swap through the pool to trigger afterSwap
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18); // swap 1 token0 in

        assertEq(hook.tradeCount(), 1, "trade count should be 1");
        assertTrue(hook.cumulativeVolume0() > 0, "volume0 should be tracked");
        assertTrue(hook.cumulativeVolume1() > 0, "volume1 should be tracked");
        assertEq(hook.lastTradeBlock(), block.number, "last trade block");
    }

    function test_afterSwap_multiple_trades() public {
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18);
        _fundAndSwap(swapper, false, 1e18);

        assertEq(hook.tradeCount(), 2, "trade count should be 2");
    }

    // --- Access control tests ---

    function test_setFeeParams_onlyOwner() public {
        hook.setFeeParams(30e14, 200e14, 2e14, 20e18);
        assertEq(hook.baseFee(), 30e14);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHook.Unauthorized.selector);
        hook.setFeeParams(30e14, 200e14, 2e14, 20e18);
    }

    function test_setPaused_onlyOwner() public {
        hook.setPaused(true);
        assertTrue(hook.paused());

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHook.Unauthorized.selector);
        hook.setPaused(true);
    }

    function test_setFeeParams_validates_ordering() public {
        // minFee > baseFee should revert
        vm.expectRevert("invalid fee ordering");
        hook.setFeeParams(10e14, 200e14, 20e14, 10e18);

        // baseFee > maxFee should revert
        vm.expectRevert("invalid fee ordering");
        hook.setFeeParams(300e14, 200e14, 1e14, 10e18);
    }

    // --- View helpers ---

    function test_getTradeStats() public view {
        (uint256 count, uint256 vol0, uint256 vol1,,,) = hook.getTradeStats();
        assertEq(count, 0);
        assertEq(vol0, 0);
        assertEq(vol1, 0);
    }

    function test_getFeeParams() public view {
        (uint64 base, uint64 max, uint64 min, uint256 scale, bool isPaused) = hook.getFeeParams();
        assertEq(base, BASE_FEE);
        assertEq(max, MAX_FEE);
        assertEq(min, MIN_FEE);
        assertEq(scale, MISMATCH_SCALE);
        assertFalse(isPaused);
    }

    // --- Swap integration ---

    function test_swap_uses_dynamic_fee() public {
        // After making oracle asymmetric, swaps should use the hook's fee
        oracle.setPrice(address(assetTST), unitOfAccount, 1.05e18);

        address swapper = makeAddr("swapper");

        // Swap in both directions
        _fundAndSwap(swapper, true, 1e18);
        _fundAndSwap(swapper, false, 1e18);

        // After two swaps, trade count should be 2
        assertEq(hook.tradeCount(), 2);
    }

    // --- getFee edge cases ---

    function test_getFee_fallback_baseFee_when_oracle_zero() public {
        // Set asset1 oracle price to 0 → price1=0 → _getOraclePrice returns 0 → baseFee fallback
        oracle.setPrice(address(assetTST2), unitOfAccount, 0);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee0 = hook.getFee(true, r0, r1, false);
        uint64 fee1 = hook.getFee(false, r0, r1, false);

        assertEq(fee0, BASE_FEE, "oracle=0 should fallback to baseFee (asset0In)");
        assertEq(fee1, BASE_FEE, "oracle=0 should fallback to baseFee (asset1In)");
    }

    function test_getFee_low_side_returns_minFee() public {
        // 10% oracle deviation with 10x scale → scaledMismatch >> baseFee → low side returns minFee
        oracle.setPrice(address(assetTST), unitOfAccount, 1.1e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // oracle > marginal → poolUnderpriced0=true → asset0 input is LOW side
        uint64 lowFee = hook.getFee(true, r0, r1, false);
        assertEq(lowFee, MIN_FEE, "low side should clamp to minFee when scaledMismatch > baseFee");
    }

    function test_getFee_reversed_direction_when_oracle_below_marginal() public {
        // Set oracle BELOW marginal: pool OVERPRICES asset0
        oracle.setPrice(address(assetTST), unitOfAccount, 0.9e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false);
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false);

        // oracle < marginal → poolUnderpriced0=false:
        //   asset0 input → HIGH (user sells overpriced asset0 — adverse)
        //   asset1 input → LOW (user buys overpriced asset0 — welcome retail)
        assertTrue(feeAsset0In > feeAsset1In, "asset0In should be HIGH when pool overprices asset0");
        assertTrue(feeAsset0In > BASE_FEE, "high side should exceed baseFee");
    }

    function test_getFee_exact_math() public {
        // Use specific params for predictable math
        // baseFee=100bps, minFee=10bps, maxFee=1000bps, scale=0.5x
        hook.setFeeParams(100e14, 1000e14, 10e14, 0.5e18);

        // 1% oracle deviation: oracle=1.01, marginal=1.0
        oracle.setPrice(address(assetTST), unitOfAccount, 1.01e18);

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Expected computation:
        //   oraclePrice = 1.01e18, marginalPrice = 1e18
        //   mismatch = (0.01e18 * WAD) / 1.01e18 ≈ 9900990099009900
        //   scaledMismatch = 0.5e18 * 9900990099009900 / 1e18 ≈ 4950495049504950
        //   High: 100e14 + ~49.5e14 ≈ ~149.5 bps
        //   Low:  100e14 - ~49.5e14 ≈ ~50.5 bps

        // oracle > marginal → poolUnderpriced0=true
        // High side = asset1 input (!asset0IsInput)
        uint64 highFee = hook.getFee(false, r0, r1, false);
        // Low side = asset0 input
        uint64 lowFee = hook.getFee(true, r0, r1, false);

        // Verify high > base > low > minFee
        assertTrue(highFee > 100e14, "high side > baseFee");
        assertTrue(lowFee < 100e14, "low side < baseFee");
        assertTrue(lowFee > 10e14, "low side > minFee (no underflow)");

        // Verify approximate values (±1 bps tolerance)
        assertApproxEqAbs(highFee, 149.5e14, 1e14, "high side ~149.5 bps");
        assertApproxEqAbs(lowFee, 50.5e14, 1e14, "low side ~50.5 bps");

        // Verify symmetry: high + low ~ 2 * baseFee
        assertApproxEqAbs(uint256(highFee) + uint256(lowFee), 200e14, 2e14, "high+low ~2*baseFee");
    }

    // --- setFeeParams validation ---

    function test_setFeeParams_rejects_maxFee_100_percent() public {
        vm.expectRevert("max fee >= 100%");
        hook.setFeeParams(25e14, uint64(1e18), 1e14, 10e18); // maxFee = WAD = 100%
    }

    // --- Event emission tests ---

    function test_setFeeParams_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHook.FeeParamsUpdated(30e14, 200e14, 2e14, 20e18);
        hook.setFeeParams(30e14, 200e14, 2e14, 20e18);
    }

    function test_setPaused_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHook.Paused(true);
        hook.setPaused(true);
    }

    // --- Access control ---

    function test_afterSwap_rejects_non_pool() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHook.OnlyPool.selector);
        hook.afterSwap(1e18, 0, 0, 1e18, 25e14, 0, address(0), address(0), 0, 0);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    // --- Pause toggle ---

    function test_setPaused_unpause_restores_normal_fee() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Pause → maxFee
        hook.setPaused(true);
        assertEq(hook.getFee(true, r0, r1, false), MAX_FEE, "paused should return maxFee");

        // Unpause → back to baseFee
        hook.setPaused(false);
        uint64 feeAfter = hook.getFee(true, r0, r1, false);
        assertApproxEqAbs(feeAfter, BASE_FEE, 1e12, "unpaused should return ~baseFee");
    }

    // --- afterSwap precision ---

    function test_afterSwap_precise_stats() public {
        address swapper = makeAddr("swapper");

        // Trade 1: 1e18 asset0 in
        _fundAndSwap(swapper, true, 1e18);

        assertEq(hook.tradeCount(), 1);
        assertTrue(hook.lastTradeAsset0In(), "last trade should be asset0 in");
        // lastTradeSize = amount0In from afterSwap, which is post-fee (input minus hook fee)
        assertApproxEqRel(hook.lastTradeSize(), 1e18, 0.01e18, "last trade size ~1e18 (minus fee)");
        assertEq(hook.lastTradeBlock(), block.number);
        // Volumes are post-fee amounts from afterSwap callback
        assertApproxEqRel(hook.cumulativeVolume0(), 1e18, 0.01e18, "volume0 ~1e18 input (minus fee)");
        assertTrue(hook.cumulativeVolume1() > 0, "volume1 includes output");

        uint256 vol0After1 = hook.cumulativeVolume0();
        uint256 vol1After1 = hook.cumulativeVolume1();

        // Trade 2: 2e18 asset1 in
        _fundAndSwap(swapper, false, 2e18);

        assertEq(hook.tradeCount(), 2);
        assertFalse(hook.lastTradeAsset0In(), "last trade should be asset1 in");
        assertApproxEqRel(hook.lastTradeSize(), 2e18, 0.02e18, "last trade size ~2e18 (minus fee)");
        assertTrue(hook.cumulativeVolume0() > vol0After1, "volume0 increased");
        assertTrue(hook.cumulativeVolume1() > vol1After1, "volume1 increased");
    }

    // --- Helpers ---

    function _fundAndSwap(address swapper, bool asset0In, uint256 amount) internal {
        if (asset0In) {
            // Fund swapper with asset0, send to pool, then call swap for asset1 out
            assetTST.mint(swapper, amount);
            vm.prank(swapper);
            assetTST.transfer(address(pool), amount);

            // Compute how much we'll get out (approximate — just request a small amount)
            uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), amount, true);
            vm.prank(swapper);
            pool.swap(0, quote, swapper, "");
        } else {
            // Fund swapper with asset1
            assetTST2.mint(swapper, amount);
            vm.prank(swapper);
            assetTST2.transfer(address(pool), amount);

            uint256 quote = pool.computeQuote(address(assetTST2), address(assetTST), amount, true);
            vm.prank(swapper);
            pool.swap(quote, 0, swapper, "");
        }
    }
}
