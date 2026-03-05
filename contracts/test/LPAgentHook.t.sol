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

        // When oracle > marginal, buying asset0 (asset1 in) should be cheaper (attract retail)
        // and selling asset0 (asset0 in) should be more expensive (block arb)... wait.
        // Actually: poolUnderpriced0=true means:
        //   asset0IsInput=true → chargeHigh=false (pool overvalues what they're getting) → LOW fee
        //   asset0IsInput=false → chargeHigh=true (pool undervalues what they're giving) → HIGH fee
        // Wait, let me re-read the code:
        // poolUnderpriced0=true, asset0IsInput=true → chargeHigh = (true && !true) = false → LOW
        // poolUnderpriced0=true, asset0IsInput=false → chargeHigh = (true && !false) = true → HIGH

        // So: asset0 input (selling asset0 to pool) → LOW fee (pool is getting cheap asset0)
        //     asset1 input (buying asset0 from pool) → HIGH fee (pool is giving away underpriced asset0)
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
