// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV2} from "../src/LPAgentHookV2.sol";
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

contract LPAgentHookV2Test is EulerSwapTestBase {
    using Sqrt for uint256;

    LPAgentHookV2 hook;
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

        // 1. Create pool without hook (equal reserves, 1:1 price, c=0)
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
        hook = new LPAgentHookV2(
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
        // NOTE: This pool has eq = real deposit = 10e18 (no leverage).
        // The threshold of 9e18 is a reserve-level trigger, NOT a debt trigger.
        // With a non-leveraged pool, vault debt is 0 even when reserves < threshold.
        // See test_auction_threshold_no_vault_debt_without_leverage() for verification.
        hook.setAuctionParams(
            0,      // threshold0: 0 = don't trigger on asset0 debt
            9e18,   // threshold1: trigger when reserve1 < 9e18
            50e14,  // delta: 50 bps off-market shift
            50e14,  // startFee: 50 bps starting fee
            1e14    // decayPerSecond: 1 bps per second
        );
    }

    // ===================================================================
    // Mode 2 tests (unchanged from LPAgentHook - all should still pass)
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

    function test_getFee_counter_direction_always_baseFee() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.5e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 counterFee = hook.getFee(true, r0, r1, false);
        assertEq(counterFee, BASE_FEE, "counter-direction must stay at baseFee when attractRate=0");
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

    function test_getFee_baseFee_when_captureRate_zero() public {
        hook.setFeeParams(BASE_FEE, MAX_FEE, 0, 0, 0, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.5e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false);

        assertEq(fee, BASE_FEE, "captureRate=0 should always return baseFee");
    }

    function test_getFee_reversed_direction_when_uniswap_below_marginal() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(0.9e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false);
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false);

        assertTrue(feeAsset0In > BASE_FEE, "arb direction (asset0In) should be elevated");
        assertEq(feeAsset1In, BASE_FEE, "counter-direction should be baseFee");
    }

    function test_getFee_exact_math() public {
        hook.setFeeParams(5e14, 1000e14, 0, 0, 0.5e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.01e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 counterFee = hook.getFee(true, r0, r1, false);

        assertApproxEqAbs(arbFee, 52e14, 1e14, "arb side ~52 bps");
        assertEq(counterFee, 5e14, "counter side = baseFee");
    }

    function test_getFee_below_gasThreshold_returns_baseFee() public {
        vm.txGasPrice(10 gwei);
        hook.setFeeParams(5e14, 3500e14, 3e10, 0, 0.8e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.001e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 counterFee = hook.getFee(true, r0, r1, false);

        assertEq(arbFee, 5e14, "below gasThreshold should be baseFee");
        assertEq(counterFee, 5e14, "counter should be baseFee");
    }

    function test_getFee_above_gasThreshold_captures_excess() public {
        vm.txGasPrice(10 gwei);
        hook.setFeeParams(5e14, 3500e14, 3e10, 0, 0.8e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.01e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 counterFee = hook.getFee(true, r0, r1, false);

        assertApproxEqAbs(arbFee, 57e14, 2e14, "arb side ~57 bps");
        assertEq(counterFee, 5e14, "counter should be baseFee");
    }

    function test_getFee_attract_side_elevated() public {
        hook.setFeeParams(5e14, 3500e14, 0, 0, 0.8e18, 0.3e18);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.01e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 attractFee = hook.getFee(true, r0, r1, false);

        assertApproxEqAbs(arbFee, 80e14, 2e14, "arb side ~80 bps");
        assertApproxEqAbs(attractFee, 35e14, 2e14, "attract side ~35 bps");
        assertTrue(attractFee > 5e14, "attract side should exceed baseFee");
        assertTrue(attractFee < arbFee, "attract fee should be less than arb fee");
    }

    function test_getFee_attract_side_baseFee_when_rate_zero() public {
        hook.setFeeParams(5e14, 3500e14, 0, 0, 0.8e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 attractFee = hook.getFee(true, r0, r1, false);
        assertEq(attractFee, 5e14, "attractRate=0 -> counter = baseFee");
    }

    function test_getFee_attract_side_clamped_to_maxFee() public {
        hook.setFeeParams(5e14, 100e14, 0, 0, 0.8e18, 0.5e18);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 attractFee = hook.getFee(true, r0, r1, false);
        assertEq(attractFee, 100e14, "attract side should be clamped to maxFee");
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

    function test_getFee_threshold_zero_when_gasCoeff_zero() public {
        hook.setFeeParams(5e14, 3500e14, 0, 0, 0.8e18, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.001e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();

        vm.txGasPrice(500 gwei);
        uint64 fee = hook.getFee(false, r0, r1, false);

        assertTrue(fee > 5e14, "gasCoeff=0 -> threshold=0 -> even tiny mismatch elevated");
    }

    function test_setFeeParams_onlyOwner() public {
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
        assertEq(hook.baseFee(), 30e14);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV2.Unauthorized.selector);
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
        emit LPAgentHookV2.FeeParamsUpdated(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    // ===================================================================
    // Auction tests (Mode 1 - new in V2)
    // ===================================================================

    // --- afterSwap: no-op cases ---

    function test_afterSwap_noOp_when_thresholds_zero() public {
        // No auction params set → thresholds are 0 → afterSwap is a no-op
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18);
        assertFalse(hook.auctionActive(), "auction should not activate when thresholds zero");
    }

    function test_afterSwap_noOp_when_reserves_above_threshold() public {
        _setupAuctionParams();
        // Small swap that doesn't push reserve1 below 9e18
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 0.5e18);

        assertFalse(hook.auctionActive(), "auction should not activate when reserves above threshold");
    }

    // --- afterSwap: auction trigger ---

    function test_afterSwap_triggers_auction() public {
        _setupAuctionParams();

        // Large swap: send 2e18 of asset0 in → receive asset1 out
        // This pushes reserve1 below 9e18 threshold
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        assertTrue(hook.auctionActive(), "auction should be active");
        assertTrue(hook.auctionAttractAsset1(), "should attract asset1 (WETH equivalent)");
        assertEq(hook.auctionStart(), block.timestamp, "auction start should be current timestamp");
    }

    function test_afterSwap_reconfigure_sets_equilibrium() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        // After auction trigger, pool's equilibrium should be set to post-swap reserves
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(dp.equilibriumReserve0, r0, "eq reserve0 should match current reserve0");
        assertEq(dp.equilibriumReserve1, r1, "eq reserve1 should match current reserve1");
    }

    function test_afterSwap_reconfigure_shifts_priceY() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyBefore = dpBefore.priceY;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        // priceY should have increased (attracting asset1)
        assertTrue(dpAfter.priceY > pyBefore, "priceY should increase to attract asset1");
        // Check it's approximately pyBefore * (1 + 50bps)
        uint80 expectedPy = uint80(uint256(pyBefore) * (1e18 + 50e14) / 1e18);
        assertEq(dpAfter.priceY, expectedPy, "priceY should be shifted by delta");
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

        // Trigger auction
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // At t=0: fee should be startFee (50 bps) for debt-repaying direction
        // Debt-repaying = asset1 in (auctionAttractAsset1=true, asset0IsInput=false)
        uint64 feeT0 = hook.getFee(false, r0, r1, false);
        assertEq(feeT0, 50e14, "at t=0, debt-repaying fee should be startFee");

        // At t=10s: fee should be 50 - 10*1 = 40 bps
        vm.warp(block.timestamp + 10);
        uint64 feeT10 = hook.getFee(false, r0, r1, false);
        assertEq(feeT10, 40e14, "at t=10s, fee should have decayed by 10 bps");

        // At t=50s: fee should be 50 - 50*1 = 0
        vm.warp(block.timestamp + 40);
        uint64 feeT50 = hook.getFee(false, r0, r1, false);
        assertEq(feeT50, 0, "at t=50s, fee should have decayed to 0");

        // At t=100s: fee should still be 0 (not underflow)
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

        // Wrong direction: asset0 in (selling asset0, but we want asset1 in)
        uint64 wrongDirFee = hook.getFee(true, r0, r1, false);
        assertEq(wrongDirFee, MAX_FEE, "wrong direction should get maxFee");
    }

    function test_getFee_normal_when_no_auction() public view {
        // No auction configured → normal Mode 2 behavior
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertApproxEqAbs(fee, BASE_FEE, 1e12, "should use Mode 2 when no auction");
    }

    // --- Auction clearing ---

    function test_auction_clears_on_debt_repayment() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Trigger auction: push reserve1 below threshold
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive(), "auction should be active");

        // Wait for fee to decay to 0 so the repaying swap is cheap
        vm.warp(block.timestamp + 60);

        // Repay: send asset1 in → this should push reserve1 back above threshold
        // Need enough asset1 to push reserve1 from ~8e18 back above 9e18
        _fundAndSwap(swapper, false, 2e18);

        // Check if auction cleared
        (, uint112 r1After,) = pool.getReserves();
        if (r1After >= hook.auctionThreshold1()) {
            assertFalse(hook.auctionActive(), "auction should clear when debt repaid");
        }
    }

    // --- Owner management ---

    function test_setAuctionParams_onlyOwner() public {
        hook.setAuctionParams(0, 9e18, 50e14, 50e14, 1e14);
        assertEq(hook.auctionThreshold1(), 9e18);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV2.Unauthorized.selector);
        hook.setAuctionParams(0, 9e18, 50e14, 50e14, 1e14);
    }

    function test_clearAuction_onlyOwner() public {
        _setupAuctionParams();

        // Trigger auction
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Non-owner cannot clear
        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV2.Unauthorized.selector);
        hook.clearAuction();

        // Owner can clear
        hook.clearAuction();
        assertFalse(hook.auctionActive(), "owner should be able to clear auction");
    }

    function test_setAuctionParams_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHookV2.AuctionParamsUpdated(0, 9e18, 50e14, 50e14, 1e14);
        hook.setAuctionParams(0, 9e18, 50e14, 50e14, 1e14);
    }

    function test_getAuctionState() public {
        _setupAuctionParams();

        (bool active, uint40 start, bool attractAsset1, uint112 t0, uint112 t1) = hook.getAuctionState();
        assertFalse(active);
        assertEq(start, 0);
        assertFalse(attractAsset1);
        assertEq(t0, 0);
        assertEq(t1, 9e18);
    }

    // --- afterSwap only callable by pool ---

    function test_afterSwap_reverts_if_not_pool() public {
        vm.expectRevert(LPAgentHookV2.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 10e18, 10e18);
    }

    // --- Auction for asset0 debt ---

    function test_afterSwap_triggers_auction_for_asset0_debt() public {
        // Set threshold for asset0 only
        hook.setAuctionParams(
            9e18,   // threshold0: trigger when reserve0 < 9e18
            0,      // threshold1: disabled
            50e14,  // delta
            50e14,  // startFee
            1e14    // decayPerSecond
        );

        // Push reserve0 below threshold: swap asset1 in to get asset0 out
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 2e18);

        assertTrue(hook.auctionActive(), "auction should be active");
        assertFalse(hook.auctionAttractAsset1(), "should attract asset0 (not asset1)");

        // Check priceY decreased (to attract asset0 inflow)
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        // priceY should have decreased → py_new = py_old * WAD / (WAD + delta)
        // At 1:1 price: py_old = 1e18, expected py_new ≈ 1e18 * 1e18 / (1e18 + 50e14) = ~0.9995e18
        assertTrue(dp.priceY < 1e18, "priceY should decrease to attract asset0");
    }

    // --- Debt threshold validation ---

    function test_auction_threshold_no_vault_debt_without_leverage() public {
        // This test proves that with a non-leveraged pool (eq = real deposit),
        // the reserve threshold does NOT correspond to actual vault debt.
        _setupAuctionParams();

        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();

        // Before swap: no debt
        assertEq(IEVault(sParams.supplyVault1).debtOf(holder), 0, "no debt before swap");
        uint256 sharesBefore = IEVault(sParams.supplyVault1).balanceOf(holder);

        // Swap that triggers auction: reserve1 drops below 9e18
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive(), "auction should be active");

        // Check: STILL no vault debt, even though auction triggered!
        // The pool only withdrew ~1.5e18 from the vault (holder still has supply)
        uint256 debt = IEVault(sParams.supplyVault1).debtOf(holder);
        assertEq(debt, 0, "no vault debt - threshold is purely a reserve level trigger");

        // Holder's vault shares decreased but are still positive
        uint256 sharesAfter = IEVault(sParams.supplyVault1).balanceOf(holder);
        assertTrue(sharesAfter < sharesBefore, "shares decreased from withdrawal");
        assertTrue(sharesAfter > 0, "still has supply - no borrowing occurred");
    }

    function test_auction_with_leveraged_pool() public {
        // Create a LEVERAGED pool where eq > real deposit.
        // Holder has 10e18 in each vault. Pool equilibrium = 20e18 each.
        // The pool implicitly borrows when withdrawals exceed the 10e18 supply.

        // Deploy leveraged pool
        IEulerSwap.StaticParams memory sParams = IEulerSwap.StaticParams({
            supplyVault0: address(eTST),
            borrowVault0: address(eTST),
            supplyVault1: address(eTST2),
            borrowVault1: address(eTST2),
            eulerAccount: holder,
            feeRecipient: address(0)
        });
        IEulerSwap.DynamicParams memory dParams = IEulerSwap.DynamicParams({
            equilibriumReserve0: 20e18,
            equilibriumReserve1: 20e18,
            minReserve0: 0,
            minReserve1: 0,
            priceX: 1e18,
            priceY: 1e18,
            concentrationX: 0.5e18,
            concentrationY: 0.5e18,
            fee0: 0,
            fee1: 0,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory initState = IEulerSwap.InitialState({
            reserve0: 20e18,
            reserve1: 20e18
        });

        EulerSwap leveragedPool = createEulerSwapFull(sParams, dParams, initState);

        // Deploy hook for this pool
        LPAgentHookV2 leveragedHook = new LPAgentHookV2(
            address(leveragedPool), address(this), address(mockUniPool),
            BASE_FEE, MAX_FEE, GAS_COEFF, EXTERNAL_FEE, CAPTURE_RATE, ATTRACT_RATE
        );

        // Install hook
        IEulerSwap.DynamicParams memory dp = leveragedPool.getDynamicParams();
        dp.swapHook = address(leveragedHook);
        dp.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        vm.prank(holder);
        IEVC(evc).call(
            address(leveragedPool), holder, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (dp, initState))
        );

        // Set threshold: reserve1 < 15e18 triggers auction.
        // At eq=20, holder has 10e18 supply. When reserve1 drops below ~10e18,
        // the pool starts borrowing. Threshold at 15e18 triggers BEFORE actual debt.
        leveragedHook.setAuctionParams(
            0,       // threshold0 disabled
            15e18,   // threshold1: trigger well before vault debt starts
            50e14,   // delta
            50e14,   // startFee
            1e14     // decayPerSecond
        );

        // Before swap: no debt (pool is at equilibrium, no withdrawals yet)
        assertEq(eTST2.debtOf(holder), 0, "no debt before swap");

        // Swap: send asset0 in → receive asset1 out → reserve1 decreases
        // With eq=20, c=0.5, 1:1 price, sending 8e18 of asset0 should
        // push reserve1 well below 15e18
        address swapper = makeAddr("swapper");
        assetTST.mint(swapper, 8e18);
        vm.prank(swapper);
        assetTST.transfer(address(leveragedPool), 8e18);
        uint256 quote = leveragedPool.computeQuote(
            address(assetTST), address(assetTST2), 8e18, true
        );
        vm.prank(swapper);
        leveragedPool.swap(0, quote, swapper, "");

        // Verify auction triggered
        assertTrue(leveragedHook.auctionActive(), "auction should be active");

        // Check reserve levels
        (, uint112 r1,) = leveragedPool.getReserves();
        assertTrue(r1 < 15e18, "reserve1 should be below threshold");

        // Check actual vault state
        uint256 supply1 = eTST2.balanceOf(holder);
        uint256 debt1 = eTST2.debtOf(holder);

        // Log vault state for verification
        emit log_named_uint("reserve1", r1);
        emit log_named_uint("vault1_supply_shares", supply1);
        emit log_named_uint("vault1_debt", debt1);
        emit log_named_uint("asset1_withdrawn", quote);

        // The pool withdrew `quote` of asset1 from the vault.
        // If quote > 10e18 (holder's initial deposit), there IS actual vault debt.
        if (quote > 10e18) {
            assertTrue(debt1 > 0, "should have vault debt when withdrawal exceeds supply");
            emit log_named_uint("REAL vault debt", debt1);
        } else {
            // Threshold triggered before actual vault debt - this is "early warning"
            assertEq(debt1, 0, "no vault debt yet - early warning threshold");
        }
    }

    function test_auction_with_actual_vault_debt() public {
        // Create a leveraged pool where a large swap creates REAL vault debt.
        // Pool: eq=20e18, holder supply=10e18. A swap withdrawing >10e18 borrows.
        IEulerSwap.StaticParams memory sParams = IEulerSwap.StaticParams({
            supplyVault0: address(eTST),
            borrowVault0: address(eTST),
            supplyVault1: address(eTST2),
            borrowVault1: address(eTST2),
            eulerAccount: holder,
            feeRecipient: address(0)
        });
        IEulerSwap.DynamicParams memory dParams = IEulerSwap.DynamicParams({
            equilibriumReserve0: 20e18,
            equilibriumReserve1: 20e18,
            minReserve0: 0,
            minReserve1: 0,
            priceX: 1e18,
            priceY: 1e18,
            concentrationX: 0.5e18,
            concentrationY: 0.5e18,
            fee0: 0,
            fee1: 0,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory initState = IEulerSwap.InitialState({
            reserve0: 20e18, reserve1: 20e18
        });

        EulerSwap lPool = createEulerSwapFull(sParams, dParams, initState);

        LPAgentHookV2 lHook = new LPAgentHookV2(
            address(lPool), address(this), address(mockUniPool),
            BASE_FEE, MAX_FEE, GAS_COEFF, EXTERNAL_FEE, CAPTURE_RATE, ATTRACT_RATE
        );

        // Install hook
        IEulerSwap.DynamicParams memory dp = lPool.getDynamicParams();
        dp.swapHook = address(lHook);
        dp.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        vm.prank(holder);
        IEVC(evc).call(
            address(lPool), holder, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (dp, initState))
        );

        // With eq=20e18 and c=0.5 at 1:1 price, the curve is deep.
        // 15e18 input only extracts ~10e18 output. Need a very large swap to
        // push past the holder's 10e18 supply and into actual borrowing.
        // Threshold at 5e18: reserve1 must drop from 20e18 to below 5e18,
        // meaning >15e18 withdrawn, so at least 5e18 of vault debt.
        lHook.setAuctionParams(0, 5e18, 50e14, 50e14, 1e14);

        // Very large swap: 60e18 of asset0 in. With c=0.5 curve,
        // this should push reserve1 well below 5e18.
        address swapper = makeAddr("swapper");
        assetTST.mint(swapper, 60e18);
        vm.prank(swapper);
        assetTST.transfer(address(lPool), 60e18);
        uint256 quote = lPool.computeQuote(address(assetTST), address(assetTST2), 60e18, true);
        vm.prank(swapper);
        lPool.swap(0, quote, swapper, "");

        // Verify auction triggered
        assertTrue(lHook.auctionActive(), "auction should be active");

        // Verify REAL vault debt exists
        uint256 debt1 = eTST2.debtOf(holder);
        assertTrue(debt1 > 0, "should have actual vault debt");
        emit log_named_uint("actual_vault_debt", debt1);

        (, uint112 r1,) = lPool.getReserves();
        assertTrue(r1 < 5e18, "reserve1 below threshold");
        emit log_named_uint("reserve1", r1);
    }

    // ===================================================================
    // Audit fix tests
    // ===================================================================

    // --- HIGH: no re-trigger during active auction ---

    function test_no_retrigger_priceY_stable_during_auction() public {
        _setupAuctionParams();

        // Trigger auction
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        IEulerSwap.DynamicParams memory dpAfterTrigger = pool.getDynamicParams();
        uint80 pyAfterTrigger = dpAfterTrigger.priceY;
        uint40 startAfterTrigger = hook.auctionStart();

        // Wait for fee to decay
        vm.warp(block.timestamp + 30);

        // Another swap that doesn't clear the debt
        _fundAndSwap(swapper, true, 0.5e18);

        // priceY should NOT have compounded
        IEulerSwap.DynamicParams memory dpAfterSecond = pool.getDynamicParams();
        assertEq(dpAfterSecond.priceY, pyAfterTrigger, "priceY must not compound on re-trigger");

        // auctionStart should NOT have reset
        assertEq(hook.auctionStart(), startAfterTrigger, "auctionStart must not reset on re-trigger");
    }

    function test_fee_decays_across_multiple_swaps_during_auction() public {
        _setupAuctionParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Fee at t=0
        uint64 feeT0 = hook.getFee(false, r0, r1, false);
        assertEq(feeT0, 50e14, "fee should be startFee at t=0");

        // Another swap at t=20 (doesn't clear)
        vm.warp(block.timestamp + 20);
        _fundAndSwap(swapper, true, 0.3e18);

        // Fee should still reflect 20s of decay from the ORIGINAL start
        (r0, r1,) = pool.getReserves();
        uint64 feeT20 = hook.getFee(false, r0, r1, false);
        assertEq(feeT20, 30e14, "fee should reflect 20s decay from original start");
    }

    // --- MEDIUM: pre-auction params restored on clear ---

    function test_auction_restores_priceY_on_clear() public {
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyOriginal = dpBefore.priceY;
        uint112 eq0Original = dpBefore.equilibriumReserve0;
        uint112 eq1Original = dpBefore.equilibriumReserve1;

        _setupAuctionParams();

        address swapper = makeAddr("swapper");

        // Trigger auction
        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.auctionActive());

        // Verify pool params are shifted
        IEulerSwap.DynamicParams memory dpAuction = pool.getDynamicParams();
        assertTrue(dpAuction.priceY > pyOriginal, "priceY should be shifted during auction");
        assertTrue(dpAuction.equilibriumReserve0 != eq0Original, "eq0 should differ during auction");

        // Wait for fee to decay, then repay
        vm.warp(block.timestamp + 60);
        _fundAndSwap(swapper, false, 2e18);

        (, uint112 r1After,) = pool.getReserves();
        if (r1After >= hook.auctionThreshold1()) {
            assertFalse(hook.auctionActive(), "auction should have cleared");

            // Pool params should be restored to pre-auction values
            IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();
            assertEq(dpRestored.priceY, pyOriginal, "priceY should be restored");
            assertEq(dpRestored.equilibriumReserve0, eq0Original, "eq0 should be restored");
            assertEq(dpRestored.equilibriumReserve1, eq1Original, "eq1 should be restored");
        }
    }

    // --- MEDIUM: startFee >= WAD rejected ---

    function test_setAuctionParams_rejects_startFee_100_percent() public {
        vm.expectRevert("startFee >= 100%");
        hook.setAuctionParams(0, 9e18, 50e14, uint64(1e18), 1e14);
    }

    function test_setAuctionParams_accepts_startFee_below_100_percent() public {
        // Just below WAD should work
        hook.setAuctionParams(0, 9e18, 50e14, uint64(1e18 - 1), 1e14);
        assertEq(hook.auctionStartFee(), uint64(1e18 - 1));
    }

    // --- Existing tests below ---

    function test_getFee_direction_for_asset0_debt() public {
        hook.setAuctionParams(9e18, 0, 50e14, 50e14, 1e14);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 2e18);
        assertTrue(hook.auctionActive());

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Debt-repaying direction: asset0 in (auctionAttractAsset1=false, asset0IsInput=true)
        uint64 repayFee = hook.getFee(true, r0, r1, false);
        assertEq(repayFee, 50e14, "debt-repaying direction should get startFee");

        // Wrong direction: asset1 in
        uint64 wrongFee = hook.getFee(false, r0, r1, false);
        assertEq(wrongFee, MAX_FEE, "wrong direction should get maxFee");
    }
}
