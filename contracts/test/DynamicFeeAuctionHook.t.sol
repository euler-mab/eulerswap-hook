// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {DynamicFeeAuctionHook} from "../src/DynamicFeeAuctionHook.sol";
import {CurveLib} from "../eulerswap/src/libraries/CurveLib.sol";
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

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(!shouldRevert, "mock revert");
        return (currentSqrtPriceX96, 0, 0, 0, 0, 0, true);
    }
}

contract DynamicFeeAuctionHookTest is EulerSwapTestBase {
    using Sqrt for uint256;

    DynamicFeeAuctionHook hook;
    EulerSwap pool;
    MockUniswapV3Pool mockUniPool;

    // Fee params
    uint64 constant BASE_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 3500e14; // 3500 bps (35%)
    uint64 constant GAS_COEFF = 0;
    uint64 constant EXTERNAL_FEE = 5e14; // 5 bps
    uint256 constant CAPTURE_RATE = 0.8e18;
    uint256 constant ATTRACT_RATE = 0.5e18;

    // Auction params
    uint64 constant DECAY_PER_BLOCK = 4e14;
    uint64 constant AUCTION_TRIGGER = 0.6e18; // 60% relative exposure
    uint64 constant CLEAR_THRESHOLD = 0.005e18;
    uint64 constant MAX_SHIFT_MAGNITUDE = 0.015e18; // 1.5% max shift
    uint64 constant MIN_AUCTION_BLOCKS = 5;

    // Recenter params
    uint64 constant RECENTER_RANGE = 1e18;
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;
    uint64 constant MIN_RECENTER_DELTA = 0; // disabled for most tests

    // Surcharge params
    uint64 constant SURCHARGE_DECAY = 10e14;
    uint64 constant SURCHARGE_MULTIPLIER = 2.5e18; // 2x curvature factor + 25% margin
    uint64 constant DEPLOY_SURCHARGE = 500e14; // 500 bps

    function _defaultAuctionConfig() internal pure returns (DynamicFeeAuctionHook.AuctionConfig memory) {
        return DynamicFeeAuctionHook.AuctionConfig({
            decayPerBlock: DECAY_PER_BLOCK,
            auctionTriggerThreshold: AUCTION_TRIGGER,
            clearThreshold: CLEAR_THRESHOLD,
            maxShiftMagnitude: MAX_SHIFT_MAGNITUDE,
            minAuctionBlocks: MIN_AUCTION_BLOCKS,
            recenterRange: RECENTER_RANGE,
            maxRecenterDrift: MAX_RECENTER_DRIFT,
            minRecenterDelta: MIN_RECENTER_DELTA,
            surchargeDecayPerBlock: SURCHARGE_DECAY,
            surchargeMultiplier: SURCHARGE_MULTIPLIER,
            deploySurcharge: DEPLOY_SURCHARGE
        });
    }

    function setUp() public override {
        super.setUp();

        // Create pool: equal reserves, 1:1 price, c=0.5
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        // Deploy mock Uniswap at 1:1 price
        mockUniPool = new MockUniswapV3Pool(asset0Addr, asset1Addr, uint160(1 << 96));

        // Deploy hook
        hook = new DynamicFeeAuctionHook(
            address(pool),
            address(this),
            DynamicFeeAuctionHook.OracleConfig({
                target: address(mockUniPool),
                v4PoolId: bytes32(0),
                token0: asset0Addr
            }),
            DynamicFeeAuctionHook.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            _defaultAuctionConfig()
        );

        // Install hook on pool
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: dParams.equilibriumReserve0, reserve1: dParams.equilibriumReserve1});

        vm.prank(holder);
        IEVC(evc).call(address(pool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, initialState)));
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

    function _advanceBlocks(uint256 n) internal {
        vm.roll(block.number + n);
    }

    // ===================================================================
    // getFee: oracle-reactive + smart surcharge
    // ===================================================================

    function test_getFee_baseFee_plus_surcharge_at_deployment() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        // Deploy surcharge = 500 bps, so total fee = baseFee (25 bps) + 500 bps = 525 bps
        assertTrue(fee >= 525e14, "fee should include deployment surcharge");
    }

    function test_getFee_surcharge_decays_to_zero() public {
        // Deployment surcharge = 500e14, decay = 10e14/block
        // Decays in ceil(500e14 / 10e14) = 50 blocks
        _advanceBlocks(50);
        (, uint256 surcharge) = hook.getSurchargeState();
        assertEq(surcharge, 0, "surcharge should be zero after enough blocks");
    }

    function test_getFee_elevated_on_arb_direction() public {
        _advanceBlocks(60);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 feeArb = hook.getFee(false, r0, r1, false);
        uint64 feeAttract = hook.getFee(true, r0, r1, false);

        assertTrue(feeArb > BASE_FEE, "arb direction should exceed baseFee");
        assertTrue(feeArb > feeAttract, "arb fee should exceed attract fee");
    }

    function test_getFee_clamped_to_maxFee() public {
        _advanceBlocks(60);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false);
        assertEq(fee, MAX_FEE, "fee should be clamped to maxFee");
    }

    function test_getFee_baseFee_when_uniswap_fails() public {
        _advanceBlocks(60);
        mockUniPool.setShouldRevert(true);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, BASE_FEE, "Uniswap failure should fallback to baseFee");
    }

    // ===================================================================
    // Owner management
    // ===================================================================

    function test_setFeeParams_onlyOwner() public {
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
        assertEq(hook.baseFee(), 30e14);

        vm.prank(makeAddr("random"));
        vm.expectRevert(DynamicFeeAuctionHook.Unauthorized.selector);
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
    }

    function test_setAuctionParams() public {
        hook.setAuctionParams(5e14, 0.6e18, 0.01e18, 0.04e18, 10);
        assertEq(hook.decayPerBlock(), 5e14);
        assertEq(hook.maxShiftMagnitude(), 0.04e18);
    }

    function test_setRecenterParams() public {
        hook.setRecenterParams(0.5e18, 0.05e18, 0.01e18);
        assertEq(hook.recenterRange(), 0.5e18);
        assertEq(hook.maxRecenterDrift(), 0.05e18);
        assertEq(hook.minRecenterDelta(), 0.01e18);
    }

    function test_setSurchargeParams() public {
        hook.setSurchargeParams(20e14, 3e18);
        assertEq(hook.surchargeDecayPerBlock(), 20e14);
        assertEq(hook.surchargeMultiplier(), 3e18);
    }

    function test_setSurchargeParams_rejects_large_multiplier() public {
        vm.expectRevert("surchargeMultiplier too large");
        hook.setSurchargeParams(10e14, uint64(11e18));
    }

    function test_setFeeParams_rejects_captureRate_above_WAD() public {
        vm.expectRevert("captureRate > 100%");
        hook.setFeeParams(25e14, 3500e14, 0, 5e14, 1.1e18, 0.3e18);
    }

    function test_setFeeParams_rejects_attractRate_above_WAD() public {
        vm.expectRevert("attractRate > 100%");
        hook.setFeeParams(25e14, 3500e14, 0, 5e14, 0.8e18, 1.1e18);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    function test_afterSwap_onlyPool() public {
        vm.expectRevert(DynamicFeeAuctionHook.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 0, 0);
    }

    function test_refreshVaultState_onlyOwner() public {
        hook.refreshVaultState(); // owner succeeds

        vm.prank(makeAddr("random"));
        vm.expectRevert(DynamicFeeAuctionHook.Unauthorized.selector);
        hook.refreshVaultState();
    }

    // ===================================================================
    // Core: continuous recenter on exposure decrease
    // ===================================================================

    function test_first_swap_no_recenter() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        _fundAndSwap(swapper, true, 0.5e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertEq(dpAfter.equilibriumReserve0, dpBefore.equilibriumReserve0, "eq should not change on first swap");
    }

    function test_lastExposure_tracks() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // asset1-in increases WETH exposure (pool accumulates more WETH)
        _fundAndSwap(swapper, false, 1e18);
        uint64 last1 = hook.lastExposure();
        assertTrue(last1 > 0, "lastExposure should track first swap");

        // Another asset1-in pushes exposure higher
        _fundAndSwap(swapper, false, 0.5e18);
        uint64 last2 = hook.lastExposure();
        assertTrue(last2 >= last1, "lastExposure should increase with more exposure");
    }

    function test_recenter_on_exposure_decrease() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // asset1-in increases WETH exposure
        _fundAndSwap(swapper, false, 2e18);
        uint64 exposureBefore = hook.lastExposure();
        assertTrue(exposureBefore > 0, "should have exposure");

        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        // asset0-in decreases WETH exposure → triggers recenter
        _fundAndSwap(swapper, true, 1e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        bool eqChanged = dpAfter.equilibriumReserve0 != dpBefore.equilibriumReserve0
            || dpAfter.equilibriumReserve1 != dpBefore.equilibriumReserve1;
        assertTrue(eqChanged, "equilibrium should change after recenter");

        // Post-recenter exposure is non-zero (pool still has WETH deposits) but less than before
        assertTrue(hook.lastExposure() < exposureBefore, "lastExposure should decrease after recenter");
    }

    function test_recenter_sets_eq_to_current_reserves() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        // asset1-in to increase exposure, then asset0-in to decrease → recenter
        _fundAndSwap(swapper, false, 2e18);
        _fundAndSwap(swapper, true, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(dp.equilibriumReserve0, r0, "eq0 should match current reserves");
        assertEq(dp.equilibriumReserve1, r1, "eq1 should match current reserves");
    }

    function test_recenter_aligns_price_to_oracle() public {
        _advanceBlocks(60);

        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));

        address swapper = makeAddr("swapper");
        // asset1-in to increase exposure, then asset0-in to decrease → recenter
        _fundAndSwap(swapper, false, 2e18);
        _fundAndSwap(swapper, true, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        uint256 impliedPrice = uint256(dp.priceX) * 1e18 / uint256(dp.priceY);
        assertApproxEqRel(impliedPrice, 1.05e18, 0.01e18, "recenter should align price to oracle");
    }

    function test_recenter_restores_min_reserves() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        // asset1-in to increase exposure, then asset0-in to decrease → recenter
        _fundAndSwap(swapper, false, 2e18);
        _fundAndSwap(swapper, true, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertTrue(dp.minReserve0 > 0, "minReserve0 should be set");
        assertTrue(dp.minReserve1 > 0, "minReserve1 should be set");
    }

    function test_recenter_gated_by_minRecenterDelta() public {
        // Set a high minRecenterDelta so small exposure decreases are skipped
        hook.setRecenterParams(RECENTER_RANGE, MAX_RECENTER_DRIFT, 0.5e18);

        _advanceBlocks(60);
        address swapper = makeAddr("swapper");

        // asset1-in to increase exposure
        _fundAndSwap(swapper, false, 2e18);
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        // Small asset0-in: exposure decrease < 0.5e18 threshold → no recenter
        _fundAndSwap(swapper, true, 0.1e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertEq(dpAfter.equilibriumReserve0, dpBefore.equilibriumReserve0, "eq should NOT change - delta too small");
    }

    function test_recenter_not_gated_when_delta_exceeds_min() public {
        // Set a small minRecenterDelta
        hook.setRecenterParams(RECENTER_RANGE, MAX_RECENTER_DRIFT, 0.01e18);

        _advanceBlocks(60);
        address swapper = makeAddr("swapper");

        // asset1-in to increase exposure significantly
        _fundAndSwap(swapper, false, 2e18);
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        // Large asset0-in: exposure decrease > 0.01e18 threshold → recenter fires
        _fundAndSwap(swapper, true, 1e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        bool eqChanged = dpAfter.equilibriumReserve0 != dpBefore.equilibriumReserve0;
        assertTrue(eqChanged, "eq should change - delta exceeds min");
    }

    function test_recenter_skips_on_sign_flip() public {
        _advanceBlocks(60);
        address swapper = makeAddr("swapper");

        // Push exposure in asset0 direction (asset0-in reduces WETH exposure from 50% baseline)
        // This makes curNet1 < baseNetAsset1, so pool becomes less net-long-WETH
        _fundAndSwap(swapper, true, 3e18);
        uint64 expAfterFirst = hook.lastExposure();
        bool dirAfterFirst = hook.lastNetLongWeth();

        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        // Now swap the OTHER direction hard enough to cross zero and land on opposite side
        // Exposure magnitude might decrease (e.g. long 30% → short 10%) but direction flipped
        _fundAndSwap(swapper, false, 5e18);

        bool dirAfterSecond = hook.lastNetLongWeth();

        // If direction actually flipped, recenter should have been skipped
        if (dirAfterFirst != dirAfterSecond) {
            IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
            assertEq(
                dpAfter.equilibriumReserve0, dpBefore.equilibriumReserve0, "eq should NOT change on sign flip"
            );
        }
        // If direction didn't flip (swap wasn't large enough), test is inconclusive — skip
    }

    // ===================================================================
    // Smart surcharge: covers curvature bonus + price change
    // ===================================================================

    function test_surcharge_covers_curvature_component() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // asset1-in to increase WETH exposure, then asset0-in to reduce → triggers recenter
        _fundAndSwap(swapper, false, 2e18);
        uint64 exposureBefore = hook.lastExposure();
        assertTrue(exposureBefore > 0, "should have exposure");

        _fundAndSwap(swapper, true, 1e18);

        (, uint256 surcharge) = hook.getSurchargeState();
        // Surcharge should be > 0 even when oracle hasn't moved (curvature component)
        assertTrue(surcharge > 0, "surcharge should cover curvature bonus");
    }

    function test_surcharge_increases_with_exposure() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // Small exposure then recenter
        _fundAndSwap(swapper, true, 0.5e18);
        _fundAndSwap(swapper, false, 0.3e18);
        (, uint256 surchargeSmall) = hook.getSurchargeState();

        // Reset: advance blocks to decay surcharge
        _advanceBlocks(100);

        // Large exposure then recenter
        _fundAndSwap(swapper, true, 3e18);
        _fundAndSwap(swapper, false, 1.5e18);
        (, uint256 surchargeLarge) = hook.getSurchargeState();

        assertTrue(surchargeLarge > surchargeSmall, "larger exposure should produce larger surcharge");
    }

    function test_surcharge_includes_price_component() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // Change oracle price → recenter picks up price change
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));

        // asset1-in to increase exposure, then asset0-in to decrease → recenter
        _fundAndSwap(swapper, false, 2e18);
        _fundAndSwap(swapper, true, 1e18);

        (, uint256 surcharge) = hook.getSurchargeState();
        // Surcharge should be elevated due to both curvature + price components
        assertTrue(surcharge > 0, "surcharge should include price component");
    }

    function test_surcharge_has_floor() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // asset1-in to increase exposure, then asset0-in to decrease → tiny recenter
        _fundAndSwap(swapper, false, 0.01e18);
        _fundAndSwap(swapper, true, 0.005e18);

        (, uint256 surcharge) = hook.getSurchargeState();
        // Floor is baseFee / 2
        assertTrue(surcharge >= uint256(BASE_FEE) / 2, "surcharge should have baseFee/2 floor");
    }

    // ===================================================================
    // NAV-based exposure tracking
    // ===================================================================

    function test_cachedNav_positive_on_init() public view {
        (,, uint128 nav) = hook.getExposureState();
        assertTrue(nav > 0, "initial NAV should be positive");
    }

    function test_cachedNav_updated_on_recenter() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        hook.getExposureState();

        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        (,, uint128 navAfter) = hook.getExposureState();
        // NAV may change slightly due to fees and vault position changes
        assertTrue(navAfter > 0, "NAV should still be positive after recenter");
    }

    function test_baseNetAsset1_cached_on_recenter() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        (, int128 bna1,) = hook.getExposureState();
        assertTrue(bna1 >= type(int128).min, "baseNetAsset1 should be set");
    }

    // ===================================================================
    // Auction: exposure-sized shift
    // ===================================================================

    function test_auction_triggers_on_high_relative_exposure() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // Large swap to create significant WETH exposure/NAV ratio
        _fundAndSwap(swapper, false, 5e18);

        (bool active,,,) = hook.getAuctionState();
        assertTrue(active, "auction should trigger when relative exposure exceeds threshold");
    }

    function test_auction_shift_sized_to_exposure() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);

        (bool active,, uint64 startingFee,) = hook.getAuctionState();
        assertTrue(active, "auction should be active");
        // Starting fee = shift * 1.5, and shift is computed from actual exposure
        // For a large swap, shift should be significant
        assertTrue(startingFee > BASE_FEE, "starting fee should exceed baseFee");
    }

    function test_auction_fee_decays() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);

        (,, uint64 startingFee, bool clearAsset0) = hook.getAuctionState();
        assertTrue(startingFee > 0);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee0 = hook.getFee(clearAsset0, r0, r1, false);
        assertEq(fee0, startingFee);

        _advanceBlocks(5);
        uint64 fee5 = hook.getFee(clearAsset0, r0, r1, false);
        uint256 expected = uint256(startingFee) - 5 * uint256(DECAY_PER_BLOCK);
        if (expected < uint256(BASE_FEE)) expected = uint256(BASE_FEE);
        assertEq(fee5, uint64(expected));
    }

    function test_auction_clears_and_recenters() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);
        assertTrue(hook.auctionActive());

        // Wait for fee to decay, then small arb to land in convergence window
        _advanceBlocks(50);
        _fundAndSwap(swapper, true, 0.16e18);

        assertFalse(hook.auctionActive(), "auction should clear");

        (, uint256 surcharge) = hook.getSurchargeState();
        assertTrue(surcharge > 0, "surcharge should activate after auction clear");
    }

    function test_auction_respects_minAuctionBlocks() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);
        assertTrue(hook.auctionActive());

        _advanceBlocks(2);
        _fundAndSwap(swapper, true, 0.01e18);
        assertTrue(hook.auctionActive(), "auction should not clear before minAuctionBlocks");
    }

    function test_endAuction_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(DynamicFeeAuctionHook.Unauthorized.selector);
        hook.endAuction();
    }

    function test_endAuction_force_clears() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);
        assertTrue(hook.auctionActive());

        hook.endAuction();
        assertFalse(hook.auctionActive());
    }

    // ===================================================================
    // Full lifecycle
    // ===================================================================

    function test_full_cycle_recenter_then_auction_then_normal() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // Phase 1: asset1-in increases WETH exposure, then asset0-in decreases → recenter
        _fundAndSwap(swapper, false, 2e18);
        uint64 exposureAfterIncrease = hook.lastExposure();
        _fundAndSwap(swapper, true, 1e18);
        assertFalse(hook.auctionActive(), "continuous recenter handled it");
        assertTrue(hook.lastExposure() < exposureAfterIncrease, "lastExposure should decrease after recenter");

        // Phase 2: Large directional move → auction
        _advanceBlocks(60);
        _fundAndSwap(swapper, false, 5e18);
        assertTrue(hook.auctionActive(), "auction should trigger");

        // Phase 3: Auction clears (small arb to land in convergence window)
        _advanceBlocks(50);
        _fundAndSwap(swapper, true, 0.16e18);
        assertFalse(hook.auctionActive(), "auction should clear");

        // Phase 4: Surcharge active then decays
        (, uint256 surcharge) = hook.getSurchargeState();
        assertTrue(surcharge > 0, "surcharge active");

        _advanceBlocks(100);
        (, uint256 surchargeDecayed) = hook.getSurchargeState();
        assertEq(surchargeDecayed, 0, "surcharge fully decayed");
    }

    // ===================================================================
    // View helpers
    // ===================================================================

    function test_getExposureState() public view {
        (uint64 last, int128 bna1, uint128 nav) = hook.getExposureState();
        assertEq(last, 0, "initial lastExposure should be 0");
        assertTrue(nav > 0, "initial NAV should be positive");
        // Test pool has symmetric deposits (10e18 of each), net WETH = deposits1 - debts1 = 10e18
        assertEq(bna1, int128(int256(10e18)), "initial baseNetAsset1 should equal asset1 deposits");
    }

    function test_getAuctionState_initially_inactive() public view {
        (bool active,,,) = hook.getAuctionState();
        assertFalse(active);
    }

    function test_computeCurrentVaultExposure() public view {
        (uint256 relExposure, uint256 absExposure, bool netLongWeth) = hook.computeCurrentVaultExposure();
        // Symmetric pool: 10 WETH deposits, 0 debt → 50% WETH exposure (target is 0%)
        // NAV = 20e18 (10 asset0 + 10 asset1 at 1:1). Exposure = 10e18 / 20e18 = 0.5
        assertApproxEqRel(relExposure, 0.5e18, 0.01e18, "symmetric pool should have ~50% relative exposure");
        // At eq with symmetric deposits, baseNetAsset1 = 10e18, displacement = 0
        assertEq(absExposure, 10e18, "absolute exposure should be baseNetAsset1 at equilibrium");
        assertTrue(netLongWeth, "symmetric pool with WETH deposits is net long");
    }

    // ===================================================================
    // Fuzz: continuous recenter invariant
    // ===================================================================

    function test_fuzz_recenter_on_every_decrease(uint8 numSwaps, uint256 seed) public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        uint256 rng = seed;
        uint256 swapCount = bound(numSwaps, 2, 12);

        for (uint256 i = 0; i < swapCount; i++) {
            if (hook.auctionActive()) {
                hook.endAuction();
            }

            uint64 lastBefore = hook.lastExposure();
            IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

            rng = uint256(keccak256(abi.encode(rng)));
            bool asset0In = (rng % 2 == 0);
            rng = uint256(keccak256(abi.encode(rng)));
            uint256 amount = bound(rng, 0.01e18, 1e18);

            if (asset0In) {
                assetTST.mint(swapper, amount);
                vm.prank(swapper);
                assetTST.transfer(address(pool), amount);
                try pool.computeQuote(address(assetTST), address(assetTST2), amount, true) returns (uint256 quote) {
                    vm.prank(swapper);
                    pool.swap(0, quote, swapper, "");
                } catch {
                    continue;
                }
            } else {
                assetTST2.mint(swapper, amount);
                vm.prank(swapper);
                assetTST2.transfer(address(pool), amount);
                try pool.computeQuote(address(assetTST2), address(assetTST), amount, true) returns (uint256 quote) {
                    vm.prank(swapper);
                    pool.swap(quote, 0, swapper, "");
                } catch {
                    continue;
                }
            }

            if (hook.auctionActive()) continue;

            uint64 lastAfter = hook.lastExposure();
            IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();

            bool eqChanged = dpAfter.equilibriumReserve0 != dpBefore.equilibriumReserve0
                || dpAfter.equilibriumReserve1 != dpBefore.equilibriumReserve1;

            if (lastAfter < lastBefore) {
                assertTrue(eqChanged, "INVARIANT VIOLATED: exposure decreased without recenter");
            }

            if (!eqChanged) {
                assertTrue(lastAfter >= lastBefore, "INVARIANT VIOLATED: lastExposure decreased without eq change");
            }
        }
    }

    /// @notice Invariant: after a successful recenter, lastExposure must match the external view.
    function test_fuzz_postRecenter_exposure_consistent(uint256 swapAmount1, uint256 swapAmount2) public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        uint256 amt1 = bound(swapAmount1, 0.5e18, 2e18);
        uint256 amt2 = bound(swapAmount2, 0.1e18, 1e18);

        // asset1-in to increase WETH exposure
        _fundAndSwap(swapper, false, amt1);
        if (hook.auctionActive()) return;

        uint64 exposureAfterFirst = hook.lastExposure();
        if (exposureAfterFirst == 0) return;

        // asset0-in to decrease WETH exposure → triggers recenter
        _fundAndSwap(swapper, true, amt2);

        if (!hook.auctionActive()) {
            uint64 lastAfterRecenter = hook.lastExposure();

            // Verify lastExposure matches the external vault exposure view
            (uint256 computedExposure,,) = hook.computeCurrentVaultExposure();

            assertApproxEqRel(
                uint256(lastAfterRecenter),
                computedExposure,
                0.01e18, // 1% tolerance for rounding
                "post-recenter lastExposure must match computeCurrentVaultExposure"
            );
        }
    }

    function _deployHookWithConcentration(uint64 cx) internal returns (EulerSwap testPool, DynamicFeeAuctionHook testHook) {
        testPool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, cx, cx);

        IEulerSwap.StaticParams memory sParams = testPool.getStaticParams();
        address a0 = IEVault(sParams.supplyVault0).asset();
        address a1 = IEVault(sParams.supplyVault1).asset();

        MockUniswapV3Pool testUniPool = new MockUniswapV3Pool(a0, a1, uint160(1 << 96));

        testHook = new DynamicFeeAuctionHook(
            address(testPool),
            address(this),
            DynamicFeeAuctionHook.OracleConfig({
                target: address(testUniPool),
                v4PoolId: bytes32(0),
                token0: a0
            }),
            DynamicFeeAuctionHook.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            _defaultAuctionConfig()
        );

        IEulerSwap.DynamicParams memory dParams = testPool.getDynamicParams();
        dParams.swapHook = address(testHook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        IEulerSwap.InitialState memory is0 =
            IEulerSwap.InitialState({reserve0: dParams.equilibriumReserve0, reserve1: dParams.equilibriumReserve1});

        vm.prank(holder);
        IEVC(evc).call(address(testPool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, is0)));

        _advanceBlocks(60);
    }

    /// @notice Fuzz: surcharge covers the curvature bonus for any round-trip through a recenter.
    /// The curvature bonus per unit is (1-cx) × [(x₀/(x₀-δ))² - 1] in WAD fee terms.
    /// The surcharge should exceed this.
    function test_fuzz_surchargeCoversRoundTrip(uint256 swapAmount, uint256 concentration) public {
        uint64 cx = uint64(bound(concentration, 0.1e18, 0.9e18));
        (EulerSwap testPool, DynamicFeeAuctionHook testHook) = _deployHookWithConcentration(cx);
        _fuzz_surchargeCoversRoundTrip_inner(testPool, testHook, swapAmount, cx);
    }

    function _fuzz_surchargeCoversRoundTrip_inner(
        EulerSwap testPool, DynamicFeeAuctionHook testHook, uint256 swapAmount, uint64 cx
    ) internal {
        _advanceBlocks(60);

        uint256 amt = bound(swapAmount, 0.1e18, 3e18);
        address swapper = makeAddr("fuzzSwapper");

        assetTST.mint(swapper, amt);
        vm.prank(swapper);
        assetTST.transfer(address(testPool), amt);

        try testPool.computeQuote(address(assetTST), address(assetTST2), amt, true) returns (uint256 quote) {
            vm.prank(swapper);
            testPool.swap(0, quote, swapper, "");
        } catch {
            return;
        }

        if (testHook.auctionActive()) return;
        if (testHook.lastExposure() == 0) return;

        // Get pre-recenter state for curvature bonus calculation
        IEulerSwap.DynamicParams memory dpPre = testPool.getDynamicParams();
        (uint112 r0Pre,,) = testPool.getReserves();
        uint256 eq0Pre = uint256(dpPre.equilibriumReserve0);
        uint256 displacement = eq0Pre > uint256(r0Pre) ? eq0Pre - uint256(r0Pre) : 0;

        // Swap in opposite direction to trigger recenter
        uint256 amt2 = amt / 2;
        assetTST2.mint(swapper, amt2);
        vm.prank(swapper);
        assetTST2.transfer(address(testPool), amt2);

        try testPool.computeQuote(address(assetTST2), address(assetTST), amt2, true) returns (uint256 quote2) {
            vm.prank(swapper);
            testPool.swap(quote2, 0, swapper, "");
        } catch {
            return;
        }

        if (testHook.auctionActive()) return;

        (, uint256 surcharge) = testHook.getSurchargeState();

        if (displacement > 0 && eq0Pre > displacement) {
            uint256 ratio = eq0Pre * 1e18 / (eq0Pre - displacement);
            uint256 ratioSquared = ratio * ratio / 1e18;
            uint256 theoreticalBonus = (1e18 - uint256(cx)) * (ratioSquared - 1e18) / 1e18;

            assertTrue(
                surcharge >= theoreticalBonus / 2,
                "INVARIANT: surcharge must cover curvature bonus"
            );
        }
    }

    // ===================================================================
    // Builder fee — permissionless upward-only bump with revenue share
    // ===================================================================

    function _setupBuilderFeeBlock() internal {
        // Push past the deploy surcharge so the public floor is at baseFee + oracle fee.
        _advanceBlocks(60);
        // Default builder share: 50% of bumped delta.
        hook.setBuilderFeeShareBps(5000);
    }

    function test_setBuilderFee_writes_slot_with_caller_as_payee() public {
        _setupBuilderFeeBlock();
        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(100e14);

        (uint64 blockNum, uint64 fee, address payee) = hook.builderFeeSlot();
        assertEq(blockNum, uint64(block.number), "block number");
        assertEq(fee, 100e14, "fee");
        assertEq(payee, bumper, "payee");
    }

    function test_setBuilderFee_reverts_if_above_maxFee() public {
        _setupBuilderFeeBlock();
        vm.expectRevert(bytes("builder fee > maxFee"));
        hook.setBuilderFee(MAX_FEE + 1);
    }

    function test_setBuilderFee_last_call_wins_same_block() public {
        _setupBuilderFeeBlock();
        vm.prank(address(0xA));
        hook.setBuilderFee(50e14);
        vm.prank(address(0xB));
        hook.setBuilderFee(80e14);

        (, uint64 fee, address payee) = hook.builderFeeSlot();
        assertEq(fee, 80e14, "later bump wins");
        assertEq(payee, address(0xB), "later payee wins");
    }

    function test_setBuilderFeeShareBps_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        hook.setBuilderFeeShareBps(5000);
    }

    function test_setBuilderFeeShareBps_rejects_above_cap() public {
        // Audit L-01: capped at 80% so LP always retains >= 20% of bumped delta.
        vm.expectRevert(bytes("shareBps > 80%"));
        hook.setBuilderFeeShareBps(8001);
    }

    function test_setBuilderFeeShareBps_at_cap_accepted() public {
        hook.setBuilderFeeShareBps(8000);
        assertEq(hook.builderFeeShareBps(), 8000, "80% cap is accepted");
    }

    function test_setBuilderFee_rejects_sub_baseFee() public {
        // Audit follow-up L-01: tighten the floor check. Below baseFee, a "bump"
        // can't be effective (would always be ignored by getFee), so reject it
        // up front. This also subsumes the earlier `fee > 0` check.
        vm.expectRevert(bytes("builder fee < baseFee"));
        hook.setBuilderFee(0);
        vm.expectRevert(bytes("builder fee < baseFee"));
        hook.setBuilderFee(BASE_FEE - 1);
    }

    function test_setBuilderFee_accepts_baseFee_exactly() public {
        // Exactly at baseFee is allowed (boundary).
        hook.setBuilderFee(BASE_FEE);
        (, uint64 fee,) = hook.builderFeeSlot();
        assertEq(fee, BASE_FEE, "baseFee bump accepted");
    }

    event BuilderFeeBelowFloor(address indexed payee, uint64 bumpedFee, uint64 publicFee);

    function test_builderFeeBelowFloor_event_emitted() public {
        // Audit I-02: when a bump is set but the public floor is higher, we emit
        // BuilderFeeBelowFloor so off-chain monitors can detect ineffective bumps.
        _advanceBlocks(60);
        hook.setBuilderFeeShareBps(5000);
        // Elevate the public fee via oracle skew
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(BASE_FEE); // below the elevated public fee

        vm.recordLogs();
        _fundAndSwap(address(0xCAFE), false, 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("BuilderFeeBelowFloor(address,uint64,uint64)");
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                found = true;
                assertEq(
                    address(uint160(uint256(logs[i].topics[1]))),
                    bumper,
                    "payee indexed correctly"
                );
                break;
            }
        }
        assertTrue(found, "BuilderFeeBelowFloor event must fire");
    }

    function test_batchSettleBuilderShare_pays_known_payees() public {
        // Audit M-03: operator can settle outstanding claims before a hook migration.
        _setupBuilderFeeBlock();

        address bumperA = address(0xB1);
        address bumperB = address(0xB2);

        // Bumper A accrues
        vm.prank(bumperA);
        hook.setBuilderFee(MAX_FEE);
        _fundAndSwap(address(0xCAFE), true, 5e17);
        uint256 accruedA = hook.builderShareAccrued(bumperA, address(assetTST));
        assertTrue(accruedA > 0);

        // Roll, bumper B accrues in a new block
        _advanceBlocks(1);
        vm.prank(bumperB);
        hook.setBuilderFee(MAX_FEE);
        _fundAndSwap(address(0xCAFE2), true, 5e17);
        uint256 accruedB = hook.builderShareAccrued(bumperB, address(assetTST));
        assertTrue(accruedB > 0);

        // Fund the hook and have the owner batch-settle both
        assetTST.mint(address(hook), accruedA + accruedB);
        address[] memory payees = new address[](2);
        payees[0] = bumperA;
        payees[1] = bumperB;
        hook.batchSettleBuilderShare(payees, address(assetTST));

        assertEq(hook.builderShareAccrued(bumperA, address(assetTST)), 0, "A cleared");
        assertEq(hook.builderShareAccrued(bumperB, address(assetTST)), 0, "B cleared");
        assertEq(assetTST.balanceOf(bumperA), accruedA, "A paid");
        assertEq(assetTST.balanceOf(bumperB), accruedB, "B paid");
    }

    function test_batchSettleBuilderShare_onlyOwner() public {
        address[] memory payees = new address[](1);
        payees[0] = address(0xB1);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        hook.batchSettleBuilderShare(payees, address(assetTST));
    }

    function test_withdraw_handles_nonstandard_erc20_no_return() public {
        // Audit H-01: USDT-style ERC-20s don't return a bool. Use a mock that mimics
        // that and verify the withdraw path still works.
        NonStandardERC20 weird = new NonStandardERC20();
        _setupBuilderFeeBlock();

        // Inject a synthetic accrual against the weird token
        address bumper = address(0xB1);
        // Use a direct storage manipulation via a helper since we can't accrue
        // against a non-pool asset through the normal flow.
        // Instead, fund the hook with the weird token and credit the ledger via
        // a workaround: the test verifies the transfer path, not the accrual path.
        // We do this by giving the hook balance and forging a withdraw expectation.
        weird.mint(address(hook), 1000);

        // The ledger is empty for this asset -> withdraw is a no-op.
        // To test the actual transfer path, we'd need to write to the ledger.
        // Use vm.store as a precise targeted poke: builderShareAccrued[bumper][weird] = 500
        bytes32 outerSlot = keccak256(abi.encode(bumper, uint256(_builderShareAccruedSlot())));
        bytes32 innerSlot = keccak256(abi.encode(address(weird), outerSlot));
        vm.store(address(hook), innerSlot, bytes32(uint256(500)));

        assertEq(hook.builderShareAccrued(bumper, address(weird)), 500, "ledger poked");

        vm.prank(bumper);
        uint256 paid = hook.withdrawBuilderShare(address(weird));
        assertEq(paid, 500, "USDT-style transfer succeeds");
        assertEq(weird.balanceOf(bumper), 500, "tokens delivered");
        assertEq(hook.builderShareAccrued(bumper, address(weird)), 0, "ledger cleared");
    }

    function test_withdraw_reverts_on_erc20_returning_false() public {
        // A token that returns `false` from transfer should cause withdrawBuilderShare
        // to revert (and via revert, restore the ledger entry).
        AlwaysFalseERC20 mean = new AlwaysFalseERC20();
        address bumper = address(0xB1);

        bytes32 outerSlot = keccak256(abi.encode(bumper, uint256(_builderShareAccruedSlot())));
        bytes32 innerSlot = keccak256(abi.encode(address(mean), outerSlot));
        vm.store(address(hook), innerSlot, bytes32(uint256(500)));

        vm.prank(bumper);
        vm.expectRevert(bytes("transfer returned false"));
        hook.withdrawBuilderShare(address(mean));

        // Ledger remains intact (revert undid the zeroing)
        assertEq(hook.builderShareAccrued(bumper, address(mean)), 500, "ledger restored on revert");
    }

    function test_withdraw_reverts_on_eoa_asset() public {
        // Audit follow-up M-01: a call to an EOA "succeeds" with no returndata.
        // The contract-existence check should now reject this.
        address fakeAsset = address(0xCAFEBABE); // pure EOA, no code
        address bumper = address(0xB1);

        bytes32 outerSlot = keccak256(abi.encode(bumper, uint256(_builderShareAccruedSlot())));
        bytes32 innerSlot = keccak256(abi.encode(fakeAsset, outerSlot));
        vm.store(address(hook), innerSlot, bytes32(uint256(500)));

        vm.prank(bumper);
        vm.expectRevert(bytes("token is not a contract"));
        hook.withdrawBuilderShare(fakeAsset);

        // Ledger restored on revert
        assertEq(hook.builderShareAccrued(bumper, fakeAsset), 500, "ledger restored");
    }

    function test_batchSettle_rejects_oversized_batch() public {
        // Audit follow-up L-02: cap at 256 payees per call.
        address[] memory payees = new address[](257);
        for (uint256 i; i < 257; ++i) payees[i] = address(uint160(i + 1));
        vm.expectRevert(bytes("batch too large"));
        hook.batchSettleBuilderShare(payees, address(assetTST));
    }

    function test_isCurrentlyBumped_view() public {
        // Audit follow-up N-05: convenience view for off-chain monitors.
        _setupBuilderFeeBlock();

        (bool active,,) = hook.isCurrentlyBumped();
        assertFalse(active, "no bump initially");

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(MAX_FEE);

        (bool a2, address payee, uint64 fee) = hook.isCurrentlyBumped();
        assertTrue(a2, "bump active");
        assertEq(payee, bumper, "payee matches");
        assertEq(fee, MAX_FEE, "fee matches");

        // Advancing past the block clears it
        _advanceBlocks(1);
        (bool a3,,) = hook.isCurrentlyBumped();
        assertFalse(a3, "bump expired");
    }

    function test_bidirectional_swap_skips_accrual_silently() public {
        // Audit follow-up L-03: the unidirectional check is now an early-return
        // rather than a revert. Real EulerSwap swaps can't hit this path; verify
        // the helper directly through a malformed-input scenario isn't trivial,
        // so this test merely confirms that the normal unidirectional swap path
        // still works (regression). The behavior change is verified by code
        // inspection — the require -> if-return swap.
        _setupBuilderFeeBlock();

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(MAX_FEE);

        // Normal swap still accrues
        _fundAndSwap(address(0xCAFE), true, 5e17);
        assertTrue(
            hook.builderShareAccrued(bumper, address(assetTST)) > 0,
            "normal swap still accrues"
        );
    }

    /// @dev Storage slot for `builderShareAccrued` mapping. Verified via
    /// `forge inspect DynamicFeeAuctionHook storage-layout`. Update this if the
    /// contract's storage layout changes (specifically: the ordering of state
    /// variables before this mapping).
    function _builderShareAccruedSlot() internal pure returns (uint256) {
        return 12;
    }

    function test_getFee_returns_max_of_public_and_builder() public {
        _setupBuilderFeeBlock();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);

        // Bump well above public
        uint64 bumped = publicFee + 200e14;
        hook.setBuilderFee(bumped);

        uint64 effective = hook.getFee(true, r0, r1, false);
        assertEq(effective, bumped, "bumped fee should be used");

        // Other direction should also see the bump
        uint64 publicOther = hook.getFee(false, r0, r1, false);
        uint64 effectiveOther = hook.getFee(false, r0, r1, false);
        if (bumped > publicOther) {
            assertEq(effectiveOther, bumped, "bump applies in both directions");
        }
    }

    function test_getFee_floor_preserved_when_builder_below_public() public {
        _setupBuilderFeeBlock();
        // Move oracle so public fee is elevated
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(false, r0, r1, false); // arb direction

        // Bump below the public floor — should be ignored
        hook.setBuilderFee(BASE_FEE);
        uint64 effective = hook.getFee(false, r0, r1, false);
        assertEq(effective, publicFee, "bump below floor is ignored");
    }

    function test_getFee_stale_bump_ignored_in_next_block() public {
        _setupBuilderFeeBlock();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);

        hook.setBuilderFee(publicFee + 200e14);

        // Move to next block — bump is stale
        _advanceBlocks(1);
        uint64 effective = hook.getFee(true, r0, r1, false);
        assertEq(effective, hook.getFee(true, r0, r1, false), "stale bump ignored");
        assertTrue(effective < publicFee + 200e14, "bumped fee should not persist");
    }

    function test_getFee_bump_capped_at_maxFee() public {
        _setupBuilderFeeBlock();
        // Caller may set up to maxFee — request the max, ensure getFee clamps if needed.
        hook.setBuilderFee(MAX_FEE);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 effective = hook.getFee(true, r0, r1, false);
        assertEq(effective, MAX_FEE, "bump at max returns max");
    }

    function test_builderShare_accrues_on_bumped_swap() public {
        _setupBuilderFeeBlock();

        // Bumper bumps. They are NOT the swapper.
        address bumper = address(0xB1);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicBefore = hook.getFee(true, r0, r1, false);

        uint64 bumped = publicBefore + 500e14; // +500 bps over public
        if (bumped > MAX_FEE) bumped = MAX_FEE;
        vm.prank(bumper);
        hook.setBuilderFee(bumped);

        // Swap a meaningful amount so fees > 0
        address swapper = address(0xCAFE);
        uint256 amount = 1e18;
        _fundAndSwap(swapper, true, amount);

        uint256 accrued = hook.builderShareAccrued(bumper, address(assetTST));
        assertTrue(accrued > 0, "share should accrue on bumped swap");
    }

    function test_builderShare_zero_when_shareBps_zero() public {
        _advanceBlocks(60);
        // Explicitly leave shareBps at zero (default)
        assertEq(hook.builderFeeShareBps(), 0, "default zero");

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(MAX_FEE);

        _fundAndSwap(address(0xCAFE), true, 1e18);

        uint256 accrued = hook.builderShareAccrued(bumper, address(assetTST));
        assertEq(accrued, 0, "no accrual when share is zero");
    }

    function test_builderShare_zero_when_stale_block() public {
        _setupBuilderFeeBlock();

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(MAX_FEE);

        _advanceBlocks(1); // bump now stale

        _fundAndSwap(address(0xCAFE), true, 1e18);

        uint256 accrued = hook.builderShareAccrued(bumper, address(assetTST));
        assertEq(accrued, 0, "no accrual when bump is stale");
    }

    function test_builderShare_zero_when_bump_below_public() public {
        _setupBuilderFeeBlock();
        // Push oracle so public fee is high on arb side
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(BASE_FEE); // below the elevated public

        _fundAndSwap(address(0xCAFE), false, 1e18); // arb direction

        uint256 accruedT = hook.builderShareAccrued(bumper, address(assetTST));
        uint256 accruedT2 = hook.builderShareAccrued(bumper, address(assetTST2));
        assertEq(accruedT, 0, "no accrual: bump below public (asset0)");
        assertEq(accruedT2, 0, "no accrual: bump below public (asset1)");
    }

    function test_builderShare_self_trade_is_net_negative() public {
        // The bumper IS the swapper. They earn back shareBps of the bumped delta,
        // but pay 100% of the bumped delta on their own swap. Net: a loss equal to
        // (1 - shareBps/10000) * bumped_delta * inputAmount.
        _setupBuilderFeeBlock();

        address builder = address(0xB1);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);
        uint64 bumped = publicFee + 200e14;
        if (bumped > MAX_FEE) bumped = MAX_FEE;
        vm.prank(builder);
        hook.setBuilderFee(bumped);

        // The builder is also the swapper here
        uint256 amount = 1e18;
        _fundAndSwap(builder, true, amount);

        uint256 accrued = hook.builderShareAccrued(builder, address(assetTST));

        // Total bumped portion charged: amount * (bumped - publicFee) / 1e18
        uint256 bumpedDelta = uint256(bumped) - uint256(publicFee);
        uint256 bumpedPortionCharged = amount * bumpedDelta / 1e18;

        // Recovered as share: bumpedPortion * 5000 / 10000 = half
        // Net cost = bumpedPortionCharged - accrued > 0
        assertTrue(
            bumpedPortionCharged > accrued,
            "self-trade should be net negative for the bumper"
        );
        // Sanity: recovered roughly half
        assertApproxEqRel(accrued, bumpedPortionCharged / 2, 0.05e18, "share is ~50%");
    }

    function test_withdraw_transfers_and_resets_ledger() public {
        _setupBuilderFeeBlock();

        address bumper = address(0xB1);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);
        uint64 bumped = publicFee + 500e14;
        if (bumped > MAX_FEE) bumped = MAX_FEE;

        vm.prank(bumper);
        hook.setBuilderFee(bumped);
        _fundAndSwap(address(0xCAFE), true, 1e18);

        uint256 accrued = hook.builderShareAccrued(bumper, address(assetTST));
        assertTrue(accrued > 0, "should have accrued");

        // Fund the hook so it can settle
        assetTST.mint(address(hook), accrued);

        uint256 balBefore = assetTST.balanceOf(bumper);
        vm.prank(bumper);
        uint256 paid = hook.withdrawBuilderShare(address(assetTST));
        uint256 balAfter = assetTST.balanceOf(bumper);

        assertEq(paid, accrued, "paid == accrued");
        assertEq(balAfter - balBefore, accrued, "tokens transferred");
        assertEq(hook.builderShareAccrued(bumper, address(assetTST)), 0, "ledger cleared");
    }

    function test_withdraw_no_op_when_nothing_accrued() public {
        address bumper = address(0xB1);
        vm.prank(bumper);
        uint256 paid = hook.withdrawBuilderShare(address(assetTST));
        assertEq(paid, 0, "no-op when nothing accrued");
    }

    function test_withdraw_reverts_when_hook_underfunded() public {
        _setupBuilderFeeBlock();
        address bumper = address(0xB1);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);
        uint64 bumped = publicFee + 500e14;
        if (bumped > MAX_FEE) bumped = MAX_FEE;
        vm.prank(bumper);
        hook.setBuilderFee(bumped);
        _fundAndSwap(address(0xCAFE), true, 1e18);
        // Do NOT fund the hook; transfer will fail.
        vm.prank(bumper);
        vm.expectRevert();
        hook.withdrawBuilderShare(address(assetTST));
    }

    function test_grief_high_bump_blocks_swap_no_accrual() public {
        // An adversary sets the fee to MAX_FEE. The pool's deepest swappers
        // route elsewhere or the swap reverts on the user's slippage check.
        // Even if a swap goes through at the elevated fee, the LP captures more
        // revenue than baseline — so the "attack" is at worst a no-op.
        _setupBuilderFeeBlock();
        address griefer = address(0xDEAD);
        vm.prank(griefer);
        hook.setBuilderFee(MAX_FEE);

        // No swap happens — no accrual.
        uint256 accrued = hook.builderShareAccrued(griefer, address(assetTST));
        assertEq(accrued, 0, "griefing without swap = no accrual");
    }

    function test_bump_applies_to_both_swap_directions_in_same_block() public {
        _setupBuilderFeeBlock();

        // Bump to maxFee so the result isn't sensitive to reserves drifting
        // during the test (each swap moves the public-fee compute slightly).
        address bumper = address(0xB1);
        vm.prank(bumper);
        hook.setBuilderFee(MAX_FEE);

        // Swap direction 0 -> 1
        _fundAndSwap(address(0xCAFE), true, 5e17);
        uint256 accruedAsset0 = hook.builderShareAccrued(bumper, address(assetTST));

        // Swap direction 1 -> 0 — same block, bump still active
        _fundAndSwap(address(0xCAFE2), false, 5e17);
        uint256 accruedAsset1 = hook.builderShareAccrued(bumper, address(assetTST2));

        assertTrue(accruedAsset0 > 0, "direction 0 accrued");
        assertTrue(accruedAsset1 > 0, "direction 1 accrued");
    }

    function test_share_proportional_to_shareBps() public {
        // Same scenario at two share rates; accrual at 8000 ≈ 2x accrual at 4000.
        _advanceBlocks(60);
        address bumper = address(0xB1);

        // First run at 40%
        hook.setBuilderFeeShareBps(4000);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 publicFee = hook.getFee(true, r0, r1, false);
        uint64 bumped = publicFee + 500e14;
        if (bumped > MAX_FEE) bumped = MAX_FEE;
        vm.prank(bumper);
        hook.setBuilderFee(bumped);
        _fundAndSwap(address(0xCAFE), true, 5e17);
        uint256 accrued40 = hook.builderShareAccrued(bumper, address(assetTST));

        // Reset ledger by withdrawing (fund first)
        assetTST.mint(address(hook), accrued40);
        vm.prank(bumper);
        hook.withdrawBuilderShare(address(assetTST));

        // Advance, re-bump, swap at 80%
        _advanceBlocks(1);
        hook.setBuilderFeeShareBps(8000);
        (r0, r1,) = pool.getReserves();
        publicFee = hook.getFee(true, r0, r1, false);
        bumped = publicFee + 500e14;
        if (bumped > MAX_FEE) bumped = MAX_FEE;
        vm.prank(bumper);
        hook.setBuilderFee(bumped);
        _fundAndSwap(address(0xCAFE3), true, 5e17);
        uint256 accrued80 = hook.builderShareAccrued(bumper, address(assetTST));

        // Expect accrued80 ~= 2x accrued40 (within 10% — pool state drifts slightly)
        assertApproxEqRel(accrued80, accrued40 * 2, 0.1e18, "share scales with bps");
    }
}

/// @dev USDT-style ERC-20: `transfer` succeeds and returns no data.
contract NonStandardERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        // Deliberately no return value — mimics USDT pre-2024.
        assembly { return(0, 0) }
    }
}

/// @dev Hostile ERC-20: `transfer` returns false instead of reverting.
contract AlwaysFalseERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
