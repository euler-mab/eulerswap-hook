// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV3} from "../src/LPAgentHookV3.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @dev Mock Uniswap V3 pool that returns a configurable sqrtPriceX96
contract MockUniswapV3Pool {
    uint160 public currentSqrtPriceX96;
    address public token0;
    address public token1;
    bool public shouldRevert;

    constructor(address _token0, address _token1, uint160 _sqrtPriceX96) {
        token0 = _token0;
        token1 = _token1;
        currentSqrtPriceX96 = _sqrtPriceX96;
    }

    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        currentSqrtPriceX96 = _sqrtPriceX96;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        require(!shouldRevert, "mock revert");
        return (currentSqrtPriceX96, 0, 0, 0, 0, 0, true);
    }
}

contract LPAgentHookV3Test is EulerSwapTestBase {
    using Sqrt for uint256;

    LPAgentHookV3 hook;
    EulerSwap pool;
    MockUniswapV3Pool mockUniPool;

    uint64 constant BASE_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 100e14; // 100 bps
    uint64 constant GAS_COEFF = 0;
    uint64 constant EXTERNAL_FEE = 5e14; // 5 bps
    uint256 constant CAPTURE_RATE = 10e18; // 10x
    uint256 constant ATTRACT_RATE = 0;

    function setUp() public override {
        super.setUp();

        // 1. Create pool without hook (equal reserves, 1:1 price, c=0.5)
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        // 2. Get asset addresses from pool
        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        // 3. Deploy mock Uniswap pool at 1:1 price
        mockUniPool = new MockUniswapV3Pool(
            asset0Addr, asset1Addr, uint160(1 << 96)
        );

        // 4. Deploy hook pointing at pool + mock Uniswap
        hook = new LPAgentHookV3(
            address(pool), address(this), address(mockUniPool),
            BASE_FEE, MAX_FEE, GAS_COEFF, EXTERNAL_FEE, CAPTURE_RATE, ATTRACT_RATE
        );

        // 5. Reconfigure pool to install hook with GET_FEE + AFTER_SWAP
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

    // --- Helpers ---

    function _wadToSqrtPriceX96(uint256 priceWad) internal pure returns (uint160) {
        uint256 sqrtPriceWad = priceWad.sqrt();
        return uint160(sqrtPriceWad * (1 << 96) / 1e9);
    }

    function _fundAndSwap(address swapper, bool asset0In, uint256 amount) internal {
        if (asset0In) {
            assetTST.mint(swapper, amount);
            vm.prank(swapper);
            assetTST.transfer(address(pool), amount);

            uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), amount, true);
            vm.prank(swapper);
            pool.swap(0, quote, swapper, "");
        } else {
            assetTST2.mint(swapper, amount);
            vm.prank(swapper);
            assetTST2.transfer(address(pool), amount);

            uint256 quote = pool.computeQuote(address(assetTST2), address(assetTST), amount, true);
            vm.prank(swapper);
            pool.swap(quote, 0, swapper, "");
        }
    }

    function _setupAuctionParams() internal {
        // NAV = 3e18 (simulates leveraged pool where NAV << virtual reserves).
        // triggerBps = 5000 (50%) → threshold = 1.5e18.
        // With eq = 10e18 each at 1:1 price, a 2e18 swap gives ~1.8e18 exposure → triggers.
        hook.setAuctionParams(
            3e18,   // nav: LP real equity in asset0 terms
            5000,   // triggerBps: 50% of NAV
            50e14,  // delta: 50 bps off-market shift
            50e14,  // startFee: 50 bps starting fee
            1e14    // decayPerSecond: 1 bps per second
        );
    }

    // ===================================================================
    // Mode 2 tests (getFee - identical logic to V2)
    // ===================================================================

    function test_getFee_baseFee_when_no_mismatch() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 fee0In = hook.getFee(true, r0, r1, false);
        uint64 fee1In = hook.getFee(false, r0, r1, false);

        assertApproxEqAbs(fee0In, BASE_FEE, 1e12, "fee0In should be ~baseFee");
        assertApproxEqAbs(fee1In, BASE_FEE, 1e12, "fee1In should be ~baseFee");
    }

    function test_getFee_elevated_on_arb_direction() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false);
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false);

        assertTrue(feeAsset1In > BASE_FEE, "arb direction should exceed baseFee");
        assertEq(feeAsset0In, BASE_FEE, "counter-direction should be baseFee when attractRate=0");
    }

    function test_getFee_clamped_to_maxFee() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false);

        assertEq(fee, MAX_FEE, "fee should be clamped to maxFee");
    }

    function test_getFee_baseFee_when_uniswap_fails() public {
        mockUniPool.setShouldRevert(true);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);

        assertEq(fee, BASE_FEE, "Uniswap failure should fallback to baseFee");
    }

    function test_getFee_attract_side_elevated() public {
        hook.setFeeParams(5e14, 3500e14, 0, 0, 0.8e18, 0.3e18);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.01e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 attractFee = hook.getFee(true, r0, r1, false);

        assertTrue(attractFee > 5e14, "attract side should exceed baseFee");
        assertTrue(attractFee < arbFee, "attract fee should be less than arb fee");
    }

    function test_getFee_dynamic_threshold_scales_with_gas() public {
        hook.setFeeParams(5e14, 3500e14, 3e10, 0, 0.8e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.005e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        vm.txGasPrice(10 gwei);
        uint64 feeLowGas = hook.getFee(false, r0, r1, false);
        vm.txGasPrice(40 gwei);
        uint64 feeHighGas = hook.getFee(false, r0, r1, false);

        assertTrue(feeLowGas > 5e14, "low gas -> threshold < mismatch -> elevated fee");
        assertEq(feeHighGas, 5e14, "high gas -> threshold > mismatch -> baseFee");
    }

    function test_setFeeParams_onlyOwner() public {
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
        assertEq(hook.baseFee(), 30e14);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV3.Unauthorized.selector);
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
    }

    function test_setFeeParams_validates_ordering() public {
        vm.expectRevert("invalid fee ordering");
        hook.setFeeParams(300e14, 200e14, 0, 0, 0.8e18, 0);
    }

    function test_setFeeParams_rejects_maxFee_100_percent() public {
        vm.expectRevert("max fee >= 100%");
        hook.setFeeParams(25e14, uint64(1e18), 0, 0, 0.8e18, 0);
    }

    function test_getFeeParams() public view {
        (uint64 base, uint64 max, uint64 coeff, uint64 ext, uint256 capture, uint256 attract) = hook.getFeeParams();
        assertEq(base, BASE_FEE);
        assertEq(max, MAX_FEE);
        assertEq(coeff, GAS_COEFF);
        assertEq(ext, EXTERNAL_FEE);
        assertEq(capture, CAPTURE_RATE);
        assertEq(attract, ATTRACT_RATE);
    }

    function test_swap_uses_dynamic_fee() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18);
        _fundAndSwap(swapper, false, 1e18);
    }

    function test_setFeeParams_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHookV3.FeeParamsUpdated(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    // ===================================================================
    // Auction tests (Mode 1 - V3 exposure-based)
    // ===================================================================

    // --- afterSwap: no-op cases ---

    function test_afterSwap_noOp_when_nav_zero() public {
        // No auction params set → nav=0 → afterSwap is a no-op
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18);
        assertFalse(hook.auctionActive(), "auction should not activate when nav is zero");
    }

    function test_afterSwap_noOp_when_exposure_below_threshold() public {
        _setupAuctionParams();
        // Small swap: exposure < 1.5e18 threshold
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 0.5e18);

        assertFalse(hook.auctionActive(), "auction should not activate when exposure below threshold");
    }

    // --- afterSwap: auction trigger ---

    function test_afterSwap_triggers_auction_asset1_outflow() public {
        _setupAuctionParams();

        // Large swap: send asset0 in → asset1 out → reserve1 drops below eq1
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        assertTrue(hook.auctionActive(), "auction should be active");
        assertTrue(hook.auctionAttractAsset1(), "should attract asset1 (reserve1 depleted)");
        assertEq(hook.auctionStart(), block.timestamp, "auction start should be current timestamp");
    }

    function test_afterSwap_triggers_auction_asset0_outflow() public {
        _setupAuctionParams();

        // Swap asset1 in → asset0 out → reserve0 drops below eq0
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 2e18);

        assertTrue(hook.auctionActive(), "auction should be active");
        assertFalse(hook.auctionAttractAsset1(), "should attract asset0 (reserve0 depleted)");
    }

    function test_afterSwap_reconfigure_sets_equilibrium() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        // After trigger, eq should be set to post-swap reserves
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(dp.equilibriumReserve0, r0, "eq0 should match current reserve0");
        assertEq(dp.equilibriumReserve1, r1, "eq1 should match current reserve1");
    }

    function test_afterSwap_reconfigure_shifts_priceY_up_for_asset1_attract() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyBefore = dpBefore.priceY;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertTrue(dpAfter.priceY > pyBefore, "priceY should increase to attract asset1");
        uint80 expectedPy = uint80(uint256(pyBefore) * (1e18 + 50e14) / 1e18);
        assertEq(dpAfter.priceY, expectedPy, "priceY should be shifted by +delta");
    }

    function test_afterSwap_reconfigure_shifts_priceY_down_for_asset0_attract() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyBefore = dpBefore.priceY;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 2e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertTrue(dpAfter.priceY < pyBefore, "priceY should decrease to attract asset0");
    }

    function test_afterSwap_relaxes_minReserves() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.minReserve0, 0, "minReserve0 should be relaxed during auction");
        assertEq(dp.minReserve1, 0, "minReserve1 should be relaxed during auction");
    }

    // --- getFee during auction ---

    function test_getFee_decaying_during_auction() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // At t=0: attract direction (asset1 in, asset0IsInput=false) gets startFee
        uint64 feeT0 = hook.getFee(false, r0, r1, false);
        assertEq(feeT0, 50e14, "at t=0, attract fee should be startFee");

        // At t=10s: fee should decay by 10 bps
        vm.warp(block.timestamp + 10);
        uint64 feeT10 = hook.getFee(false, r0, r1, false);
        assertEq(feeT10, 40e14, "at t=10s, fee should have decayed by 10 bps");

        // At t=50s: fee fully decayed to 0
        vm.warp(block.timestamp + 40);
        uint64 feeT50 = hook.getFee(false, r0, r1, false);
        assertEq(feeT50, 0, "at t=50s, fee should have decayed to 0");

        // At t=100s: fee stays at 0 (no underflow)
        vm.warp(block.timestamp + 50);
        uint64 feeT100 = hook.getFee(false, r0, r1, false);
        assertEq(feeT100, 0, "fee should stay at 0 after full decay");
    }

    function test_getFee_blocks_wrong_direction() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Wrong direction: asset0 in (but we want asset1 in)
        uint64 wrongDirFee = hook.getFee(true, r0, r1, false);
        assertEq(wrongDirFee, MAX_FEE, "wrong direction should get maxFee");
    }

    function test_getFee_normal_when_no_auction() public view {
        // No auction params set → normal Mode 2 behavior
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertApproxEqAbs(fee, BASE_FEE, 1e12, "should use Mode 2 when no auction");
    }

    // --- Auction clearing (V3: attracted reserve returns to pre-drift eq) ---

    function test_auction_clears_when_reserve_returns_to_original_eq() public {
        _setupAuctionParams();

        // Record original eq (the neutral state / clearing target)
        IEulerSwap.DynamicParams memory dpOrig = pool.getDynamicParams();
        uint112 origEq1 = dpOrig.equilibriumReserve1;

        address swapper = makeAddr("swapper");

        // Trigger: asset0 in → depletes reserve1 → attractAsset1=true
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive(), "auction should be active");

        // Wait for fee decay, then send asset1 in (attract direction)
        // Need enough to push reserve1 back to original eq1 (10e18)
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 3e18);

        // reserve1 should now be >= original eq1 → auction clears
        (, uint112 r1After,) = pool.getReserves();
        assertTrue(r1After >= origEq1, "reserve1 should be above original eq1");
        assertFalse(hook.auctionActive(), "auction should have cleared");
    }

    function test_auction_clears_asset0_attract() public {
        _setupAuctionParams();

        IEulerSwap.DynamicParams memory dpOrig = pool.getDynamicParams();
        uint112 origEq0 = dpOrig.equilibriumReserve0;

        address swapper = makeAddr("swapper");

        // Trigger: asset1 in → depletes reserve0 → attractAsset1=false
        _fundAndSwap(swapper, false, 2e18);
        assertTrue(hook.auctionActive(), "auction should be active");
        assertFalse(hook.auctionAttractAsset1(), "should attract asset0");

        // Wait for fee decay, then send asset0 in (attract direction)
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, true, 3e18);

        (uint112 r0After,,) = pool.getReserves();
        assertTrue(r0After >= origEq0, "reserve0 should be above original eq0");
        assertFalse(hook.auctionActive(), "auction should have cleared");
    }

    function test_auction_does_not_clear_below_original_eq() public {
        _setupAuctionParams();

        IEulerSwap.DynamicParams memory dpOrig = pool.getDynamicParams();
        uint112 origEq1 = dpOrig.equilibriumReserve1;

        address swapper = makeAddr("swapper");

        // Trigger: depletes reserve1
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Small reverse swap - pushes reserve1 above trigger-time eq
        // but NOT above original eq1 → should NOT clear
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 0.5e18);

        (, uint112 r1After,) = pool.getReserves();
        assertTrue(r1After < origEq1, "reserve1 should still be below original eq1");
        assertTrue(hook.auctionActive(), "auction should NOT clear - exposure not fully reversed");
    }

    // --- Restore after clearing (V3: BOUNDARY_FACTOR = 0.9759e18) ---

    function test_auction_restores_priceY_on_clear() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyOriginal = dpBefore.priceY;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Trigger
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Verify priceY shifted
        IEulerSwap.DynamicParams memory dpAuction = pool.getDynamicParams();
        assertTrue(dpAuction.priceY > pyOriginal, "priceY should be shifted during auction");

        // Clear (need enough to reach original eq1)
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 3e18);
        assertFalse(hook.auctionActive(), "auction should have cleared");

        // Verify restoration
        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();
        assertEq(dpRestored.priceY, pyOriginal, "priceY should be restored");
    }

    function test_auction_restore_sets_eq_to_current_reserves() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 3e18);
        assertFalse(hook.auctionActive());

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();
        assertEq(dpRestored.equilibriumReserve0, r0After, "eq0 = current reserves after restore");
        assertEq(dpRestored.equilibriumReserve1, r1After, "eq1 = current reserves after restore");
    }

    function test_auction_restore_uses_boundary_factor() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 3e18);
        assertFalse(hook.auctionActive());

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();

        // Both minReserves should use BOUNDARY_FACTOR = 0.9759e18
        uint112 expectedMin0 = uint112(uint256(r0After) * 0.9759e18 / 1e18);
        uint112 expectedMin1 = uint112(uint256(r1After) * 0.9759e18 / 1e18);
        assertEq(dpRestored.minReserve0, expectedMin0, "min0 should use BOUNDARY_FACTOR");
        assertEq(dpRestored.minReserve1, expectedMin1, "min1 should use BOUNDARY_FACTOR");
    }

    function test_restore_boundary_factor_on_asset0_attract() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Trigger asset0 attract (asset1 in → asset0 out)
        _fundAndSwap(swapper, false, 2e18);
        assertTrue(hook.auctionActive());

        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, true, 3e18);
        assertFalse(hook.auctionActive());

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();

        uint112 expectedMin0 = uint112(uint256(r0After) * 0.9759e18 / 1e18);
        uint112 expectedMin1 = uint112(uint256(r1After) * 0.9759e18 / 1e18);
        assertEq(dpRestored.minReserve0, expectedMin0, "min0 should use BOUNDARY_FACTOR");
        assertEq(dpRestored.minReserve1, expectedMin1, "min1 should use BOUNDARY_FACTOR");
    }

    // --- No re-trigger during active auction ---

    function test_no_retrigger_priceY_stable_during_auction() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        IEulerSwap.DynamicParams memory dpAfterTrigger = pool.getDynamicParams();
        uint80 pyAfterTrigger = dpAfterTrigger.priceY;
        uint40 startAfterTrigger = hook.auctionStart();

        // Another swap in the same direction (doesn't clear)
        vm.warp(block.timestamp + 30);
        _fundAndSwap(swapper, true, 0.5e18);

        // priceY should NOT have compounded
        IEulerSwap.DynamicParams memory dpAfterSecond = pool.getDynamicParams();
        assertEq(dpAfterSecond.priceY, pyAfterTrigger, "priceY must not compound on re-trigger");

        // auctionStart should NOT have reset
        assertEq(hook.auctionStart(), startAfterTrigger, "auctionStart must not reset");
    }

    function test_fee_decays_across_multiple_swaps_during_auction() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeT0 = hook.getFee(false, r0, r1, false);
        assertEq(feeT0, 50e14, "fee should be startFee at t=0");

        // Another swap at t=20 (same direction, doesn't clear)
        vm.warp(block.timestamp + 20);
        _fundAndSwap(swapper, true, 0.3e18);

        // Fee should reflect 20s of decay from ORIGINAL start
        (r0, r1,) = pool.getReserves();
        uint64 feeT20 = hook.getFee(false, r0, r1, false);
        assertEq(feeT20, 30e14, "fee should reflect 20s decay from original start");
    }

    // --- Stress test: multiple swaps during auction, restore still works ---

    function test_restore_succeeds_after_multiple_auction_swaps() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyOriginal = dpBefore.priceY;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Trigger
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Several more swaps during auction
        vm.warp(block.timestamp + 30);
        _fundAndSwap(swapper, true, 0.5e18);
        _fundAndSwap(swapper, true, 0.5e18);
        _fundAndSwap(swapper, true, 0.3e18);

        assertTrue(hook.auctionActive(), "auction should still be active");

        // Clear with large reverse swap (must reach original eq1 = 10e18)
        vm.warp(block.timestamp + 30);
        _fundAndSwap(swapper, false, 5e18);

        assertFalse(hook.auctionActive(), "auction should have cleared");

        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();
        assertEq(dpRestored.priceY, pyOriginal, "priceY must be restored after many swaps");

        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        assertEq(dpRestored.equilibriumReserve0, r0After, "eq0 = current reserves");
        assertEq(dpRestored.equilibriumReserve1, r1After, "eq1 = current reserves");

        uint112 expectedMin0 = uint112(uint256(r0After) * 0.9759e18 / 1e18);
        uint112 expectedMin1 = uint112(uint256(r1After) * 0.9759e18 / 1e18);
        assertEq(dpRestored.minReserve0, expectedMin0, "min0 uses BOUNDARY_FACTOR");
        assertEq(dpRestored.minReserve1, expectedMin1, "min1 uses BOUNDARY_FACTOR");
    }

    // --- Owner management ---

    function test_setAuctionParams_onlyOwner() public {
        hook.setAuctionParams(3e18, 5000, 50e14, 50e14, 1e14);
        assertEq(hook.nav(), 3e18);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV3.Unauthorized.selector);
        hook.setAuctionParams(3e18, 5000, 50e14, 50e14, 1e14);
    }

    function test_clearAuction_onlyOwner() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV3.Unauthorized.selector);
        hook.clearAuction();

        hook.clearAuction();
        assertFalse(hook.auctionActive(), "owner should be able to clear auction");
    }

    function test_setAuctionParams_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHookV3.AuctionParamsUpdated(3e18, 5000, 50e14, 50e14, 1e14);
        hook.setAuctionParams(3e18, 5000, 50e14, 50e14, 1e14);
    }

    function test_getAuctionState() public {
        _setupAuctionParams();

        (bool active, uint40 start, bool attractAsset1, uint112 _nav, uint64 _triggerBps) = hook.getAuctionState();
        assertFalse(active);
        assertEq(start, 0);
        assertFalse(attractAsset1);
        assertEq(_nav, 3e18);
        assertEq(_triggerBps, 5000);
    }

    function test_setAuctionParams_rejects_startFee_100_percent() public {
        vm.expectRevert("startFee >= 100%");
        hook.setAuctionParams(3e18, 5000, 50e14, uint64(1e18), 1e14);
    }

    function test_setAuctionParams_rejects_triggerBps_above_100_percent() public {
        vm.expectRevert("triggerBps > 100%");
        hook.setAuctionParams(3e18, 10001, 50e14, 50e14, 1e14);
    }

    function test_setAuctionParams_accepts_boundary_values() public {
        // triggerBps = 10000 (100%) should be valid
        hook.setAuctionParams(3e18, 10000, 50e14, 50e14, 1e14);
        assertEq(hook.triggerBps(), 10000);

        // startFee just below 100%
        hook.setAuctionParams(3e18, 5000, 50e14, uint64(1e18 - 1), 1e14);
        assertEq(hook.auctionStartFee(), uint64(1e18 - 1));
    }

    // --- afterSwap only callable by pool ---

    function test_afterSwap_reverts_if_not_pool() public {
        vm.expectRevert(LPAgentHookV3.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 10e18, 10e18);
    }

    // --- V3-specific: exposure conversion ---

    function test_exposure_asset1_converted_to_asset0_terms() public {
        // Create a pool with asymmetric prices to test px/py conversion
        EulerSwap pool2 = createEulerSwap(10e18, 10e18, 0, 2e18, 1e18, 0.5e18, 0.5e18);

        IEulerSwap.StaticParams memory sParams = pool2.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        MockUniswapV3Pool mockUni2 = new MockUniswapV3Pool(
            asset0Addr, asset1Addr, uint160(1 << 96)
        );

        LPAgentHookV3 hook2 = new LPAgentHookV3(
            address(pool2), address(this), address(mockUni2),
            BASE_FEE, MAX_FEE, GAS_COEFF, EXTERNAL_FEE, CAPTURE_RATE, ATTRACT_RATE
        );

        IEulerSwap.DynamicParams memory dParams = pool2.getDynamicParams();
        dParams.swapHook = address(hook2);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        IEulerSwap.InitialState memory initState = IEulerSwap.InitialState({
            reserve0: dParams.equilibriumReserve0,
            reserve1: dParams.equilibriumReserve1
        });

        vm.prank(holder);
        IEVC(evc).call(
            address(pool2), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, initState))
        );

        // With px=2, py=1: 1 unit of asset1 outflow = 2 units in asset0 terms
        // So the exposure threshold in asset1 terms is lower (fewer units needed)
        // NAV = 1e18 (small), triggerBps = 5000 → threshold = 0.5e18 in asset0 terms
        // An asset1 outflow of 0.5e18 → exposure = 0.5 * 2/1 = 1e18 > 0.5e18 → triggers
        hook2.setAuctionParams(1e18, 5000, 50e14, 50e14, 1e14);

        address swapper = makeAddr("swapper");
        assetTST.mint(swapper, 1e18);
        vm.prank(swapper);
        assetTST.transfer(address(pool2), 1e18);
        uint256 quote = pool2.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        vm.prank(swapper);
        pool2.swap(0, quote, swapper, "");

        assertTrue(hook2.auctionActive(), "auction should trigger with px/py conversion");
        assertTrue(hook2.auctionAttractAsset1(), "should attract asset1");
    }

    // --- Clearing uses original eq, not trigger-time eq ---

    function test_clearing_requires_original_eq_not_trigger_time() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Record original eq (the clearing target)
        IEulerSwap.DynamicParams memory dpOrig = pool.getDynamicParams();
        uint112 origEq1 = dpOrig.equilibriumReserve1;

        // Trigger: depletes reserve1
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Trigger-time eq1 = current reserve1 (lower than original)
        IEulerSwap.DynamicParams memory dpTrigger = pool.getDynamicParams();
        uint112 triggerEq1 = dpTrigger.equilibriumReserve1;
        assertTrue(triggerEq1 < origEq1, "trigger-time eq1 should be less than original eq1");

        // A small reverse swap pushes reserve1 above trigger-time eq1
        // but NOT above original eq1 → auction stays active
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 0.5e18);

        (, uint112 r1Mid,) = pool.getReserves();
        assertTrue(r1Mid > triggerEq1, "reserve1 should be above trigger-time eq1");
        assertTrue(r1Mid < origEq1, "reserve1 should still be below original eq1");
        assertTrue(hook.auctionActive(), "auction must NOT clear - need to reach original eq");

        // Now a larger swap to reach original eq1 → clears
        _fundAndSwap(swapper, false, 2e18);
        assertFalse(hook.auctionActive(), "auction should clear when reserve1 >= original eq1");
    }
}
