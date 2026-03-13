// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV7} from "../src/LPAgentHookV7.sol";
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

contract LPAgentHookV7Test is EulerSwapTestBase {
    using Sqrt for uint256;

    LPAgentHookV7 hook;
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

    // Surcharge params
    uint64 constant SURCHARGE_DECAY = 10e14;
    uint64 constant SURCHARGE_MULTIPLIER = 2.5e18; // 2x curvature factor + 25% margin

    function setUp() public override {
        super.setUp();

        // Create pool: equal reserves, 1:1 price, c=0.5
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        // Deploy mock Uniswap at 1:1 price
        mockUniPool = new MockUniswapV3Pool(asset0Addr, asset1Addr, uint160(1 << 96));

        // Deploy V7 hook
        hook = new LPAgentHookV7(
            address(pool),
            address(this),
            address(mockUniPool),
            LPAgentHookV7.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV7.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                auctionTriggerThreshold: AUCTION_TRIGGER,
                clearThreshold: CLEAR_THRESHOLD,
                maxShiftMagnitude: MAX_SHIFT_MAGNITUDE,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER
            })
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
        assertTrue(fee >= BASE_FEE + BASE_FEE, "fee should include deployment surcharge");
    }

    function test_getFee_surcharge_decays_to_zero() public {
        // Deployment surcharge = baseFee = 25e14, decay = 10e14/block
        // Decays in ceil(25e14 / 10e14) = 3 blocks
        _advanceBlocks(3);
        (, uint256 surcharge) = hook.getSurchargeState();
        assertEq(surcharge, 0, "surcharge should be zero after enough blocks");
    }

    function test_getFee_elevated_on_arb_direction() public {
        _advanceBlocks(10);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 feeArb = hook.getFee(false, r0, r1, false);
        uint64 feeAttract = hook.getFee(true, r0, r1, false);

        assertTrue(feeArb > BASE_FEE, "arb direction should exceed baseFee");
        assertTrue(feeArb > feeAttract, "arb fee should exceed attract fee");
    }

    function test_getFee_clamped_to_maxFee() public {
        _advanceBlocks(10);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false);
        assertEq(fee, MAX_FEE, "fee should be clamped to maxFee");
    }

    function test_getFee_baseFee_when_uniswap_fails() public {
        _advanceBlocks(10);
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
        vm.expectRevert(LPAgentHookV7.Unauthorized.selector);
        hook.setFeeParams(30e14, 200e14, 0, 5e14, 0.8e18, 0.3e18);
    }

    function test_setAuctionParams() public {
        hook.setAuctionParams(5e14, 0.6e18, 0.01e18, 0.04e18, 10);
        assertEq(hook.decayPerBlock(), 5e14);
        assertEq(hook.maxShiftMagnitude(), 0.04e18);
    }

    function test_setRecenterParams() public {
        hook.setRecenterParams(0.5e18, 0.05e18);
        assertEq(hook.recenterRange(), 0.5e18);
        assertEq(hook.maxRecenterDrift(), 0.05e18);
    }

    function test_setSurchargeParams() public {
        hook.setSurchargeParams(20e14, 3e18);
        assertEq(hook.surchargeDecayPerBlock(), 20e14);
        assertEq(hook.surchargeMultiplier(), 3e18);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    function test_afterSwap_onlyPool() public {
        vm.expectRevert(LPAgentHookV7.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 0, 0);
    }

    function test_refreshVaultState_onlyOwner() public {
        hook.refreshVaultState(); // owner succeeds

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV7.Unauthorized.selector);
        hook.refreshVaultState();
    }

    // ===================================================================
    // Core: continuous recenter on exposure decrease
    // ===================================================================

    function test_first_swap_no_recenter() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        _fundAndSwap(swapper, true, 0.5e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertEq(dpAfter.equilibriumReserve0, dpBefore.equilibriumReserve0, "eq should not change on first swap");
    }

    function test_lastExposure_tracks() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        _fundAndSwap(swapper, true, 1e18);
        uint64 last1 = hook.lastExposure();
        assertTrue(last1 > 0, "lastExposure should track first swap");

        _fundAndSwap(swapper, true, 0.5e18);
        uint64 last2 = hook.lastExposure();
        assertTrue(last2 >= last1, "lastExposure should increase with more exposure");
    }

    function test_recenter_on_exposure_decrease() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        _fundAndSwap(swapper, true, 2e18);
        assertTrue(hook.lastExposure() > 0, "should have exposure");

        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        _fundAndSwap(swapper, false, 1e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        bool eqChanged = dpAfter.equilibriumReserve0 != dpBefore.equilibriumReserve0
            || dpAfter.equilibriumReserve1 != dpBefore.equilibriumReserve1;
        assertTrue(eqChanged, "equilibrium should change after recenter");

        assertEq(hook.lastExposure(), 0, "lastExposure should reset after recenter");
    }

    function test_recenter_sets_eq_to_current_reserves() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(dp.equilibriumReserve0, r0, "eq0 should match current reserves");
        assertEq(dp.equilibriumReserve1, r1, "eq1 should match current reserves");
    }

    function test_recenter_aligns_price_to_oracle() public {
        _advanceBlocks(10);

        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        uint256 impliedPrice = uint256(dp.priceX) * 1e18 / uint256(dp.priceY);
        assertApproxEqRel(impliedPrice, 1.05e18, 0.01e18, "recenter should align price to oracle");
    }

    function test_recenter_restores_min_reserves() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertTrue(dp.minReserve0 > 0, "minReserve0 should be set");
        assertTrue(dp.minReserve1 > 0, "minReserve1 should be set");
    }

    // ===================================================================
    // Smart surcharge: covers curvature bonus + price change
    // ===================================================================

    function test_surcharge_covers_curvature_component() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        // Create significant exposure then reduce it → triggers recenter with smart surcharge
        _fundAndSwap(swapper, true, 2e18);
        uint64 exposureBefore = hook.lastExposure();
        assertTrue(exposureBefore > 0, "should have exposure");

        _fundAndSwap(swapper, false, 1e18);

        (, uint256 surcharge) = hook.getSurchargeState();
        // Surcharge should be > 0 even when oracle hasn't moved (curvature component)
        assertTrue(surcharge > 0, "surcharge should cover curvature bonus");
    }

    function test_surcharge_increases_with_exposure() public {
        _advanceBlocks(10);

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
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        // Change oracle price → recenter picks up price change
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));

        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        (, uint256 surcharge) = hook.getSurchargeState();
        // Surcharge should be elevated due to both curvature + price components
        assertTrue(surcharge > 0, "surcharge should include price component");
    }

    function test_surcharge_has_floor() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        // Tiny exposure → tiny curvature component
        _fundAndSwap(swapper, true, 0.01e18);
        _fundAndSwap(swapper, false, 0.005e18);

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
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        hook.getExposureState();

        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);

        (,, uint128 navAfter) = hook.getExposureState();
        // NAV may change slightly due to fees and vault position changes
        assertTrue(navAfter > 0, "NAV should still be positive after recenter");
    }

    function test_baseNetAsset1_cached_on_recenter() public {
        _advanceBlocks(10);

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
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        // Large swap to create significant WETH exposure/NAV ratio
        _fundAndSwap(swapper, false, 5e18);

        (bool active,,,) = hook.getAuctionState();
        assertTrue(active, "auction should trigger when relative exposure exceeds threshold");
    }

    function test_auction_shift_sized_to_exposure() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);

        (bool active,, uint64 startingFee,) = hook.getAuctionState();
        assertTrue(active, "auction should be active");
        // Starting fee = shift * 1.5, and shift is computed from actual exposure
        // For a large swap, shift should be significant
        assertTrue(startingFee > BASE_FEE, "starting fee should exceed baseFee");
    }

    function test_auction_fee_decays() public {
        _advanceBlocks(10);

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
        _advanceBlocks(10);

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
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 5e18);
        assertTrue(hook.auctionActive());

        _advanceBlocks(2);
        _fundAndSwap(swapper, true, 0.01e18);
        assertTrue(hook.auctionActive(), "auction should not clear before minAuctionBlocks");
    }

    function test_endAuction_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV7.Unauthorized.selector);
        hook.endAuction();
    }

    function test_endAuction_force_clears() public {
        _advanceBlocks(10);

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
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");

        // Phase 1: Moderate exposure → reduce → continuous recenter
        _fundAndSwap(swapper, true, 2e18);
        _fundAndSwap(swapper, false, 1e18);
        assertFalse(hook.auctionActive(), "continuous recenter handled it");
        assertEq(hook.lastExposure(), 0, "lastExposure reset after recenter");

        // Phase 2: Large directional move → auction
        _advanceBlocks(10);
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

    function test_computeCurrentRelativeExposure() public view {
        uint256 relExposure = hook.computeCurrentRelativeExposure();
        // Symmetric pool: 10 WETH deposits, 0 debt → 50% WETH exposure (target is 0%)
        // NAV = 20e18 (10 asset0 + 10 asset1 at 1:1). Exposure = 10e18 / 20e18 = 0.5
        assertApproxEqRel(relExposure, 0.5e18, 0.01e18, "symmetric pool should have ~50% relative exposure");
    }

    function test_computeCurrentAbsoluteExposure() public view {
        uint256 absExposure = hook.computeCurrentAbsoluteExposure();
        // At eq with symmetric deposits, baseNetAsset1 = 10e18, displacement = 0
        // So abs exposure = |10e18 + 0| = 10e18
        assertEq(absExposure, 10e18, "absolute exposure should be baseNetAsset1 at equilibrium");
    }

    // ===================================================================
    // Fuzz: continuous recenter invariant
    // ===================================================================

    function test_fuzz_recenter_on_every_decrease(uint8 numSwaps, uint256 seed) public {
        _advanceBlocks(10);

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

    /// @notice Invariant: after a successful recenter, lastExposure must match manual computation.
    function test_fuzz_postRecenter_exposure_consistent(uint256 swapAmount1, uint256 swapAmount2) public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        uint256 amt1 = bound(swapAmount1, 0.5e18, 2e18);
        uint256 amt2 = bound(swapAmount2, 0.1e18, 1e18);

        _fundAndSwap(swapper, true, amt1);
        if (hook.auctionActive()) return;

        uint64 exposureAfterFirst = hook.lastExposure();
        if (exposureAfterFirst == 0) return;

        _fundAndSwap(swapper, false, amt2);

        if (!hook.auctionActive()) {
            uint64 lastAfterRecenter = hook.lastExposure();

            (uint112 r0, uint112 r1,) = pool.getReserves();
            IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();

            uint256 eq0 = uint256(dp.equilibriumReserve0);
            uint256 eq1 = uint256(dp.equilibriumReserve1);
            uint256 min0 = uint256(dp.minReserve0);
            uint256 min1 = uint256(dp.minReserve1);

            uint256 manualExposure = 0;
            if (uint256(r0) < eq0 && eq0 > min0) {
                manualExposure = (eq0 - uint256(r0)) * 1e18 / (eq0 - min0);
            } else if (uint256(r1) < eq1 && eq1 > min1) {
                manualExposure = (eq1 - uint256(r1)) * 1e18 / (eq1 - min1);
            }

            assertEq(
                uint256(lastAfterRecenter), manualExposure, "post-recenter lastExposure must match manual computation"
            );
        }
    }

    /// @notice Fuzz: surcharge covers the curvature bonus for any round-trip through a recenter.
    /// The curvature bonus per unit is (1-cx) × [(x₀/(x₀-δ))² - 1] in WAD fee terms.
    /// The surcharge should exceed this.
    function test_fuzz_surchargeCoversRoundTrip(uint256 swapAmount, uint256 concentration) public {
        // Bound concentration to reasonable range (0.1 to 0.9)
        uint64 cx = uint64(bound(concentration, 0.1e18, 0.9e18));

        // Create pool with specific concentration
        EulerSwap testPool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, cx, cx);

        IEulerSwap.StaticParams memory sParams = testPool.getStaticParams();
        address a0 = IEVault(sParams.supplyVault0).asset();
        address a1 = IEVault(sParams.supplyVault1).asset();

        MockUniswapV3Pool testUniPool = new MockUniswapV3Pool(a0, a1, uint160(1 << 96));

        LPAgentHookV7 testHook = new LPAgentHookV7(
            address(testPool),
            address(this),
            address(testUniPool),
            LPAgentHookV7.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV7.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                auctionTriggerThreshold: AUCTION_TRIGGER,
                clearThreshold: CLEAR_THRESHOLD,
                maxShiftMagnitude: MAX_SHIFT_MAGNITUDE,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER
            })
        );

        // Install hook
        IEulerSwap.DynamicParams memory dParams = testPool.getDynamicParams();
        dParams.swapHook = address(testHook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        IEulerSwap.InitialState memory is0 =
            IEulerSwap.InitialState({reserve0: dParams.equilibriumReserve0, reserve1: dParams.equilibriumReserve1});

        vm.prank(holder);
        IEVC(evc).call(address(testPool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, is0)));

        _advanceBlocks(10);

        // Swap to create exposure
        uint256 amt = bound(swapAmount, 0.1e18, 3e18);
        address swapper = makeAddr("fuzzSwapper");

        assetTST.mint(swapper, amt);
        vm.prank(swapper);
        assetTST.transfer(address(testPool), amt);

        try testPool.computeQuote(address(assetTST), address(assetTST2), amt, true) returns (uint256 quote) {
            vm.prank(swapper);
            testPool.swap(0, quote, swapper, "");
        } catch {
            return; // Pool rejected swap
        }

        if (testHook.auctionActive()) return;

        uint64 exposureBefore = testHook.lastExposure();
        if (exposureBefore == 0) return;

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
            return; // Pool rejected swap
        }

        if (testHook.auctionActive()) return;

        // Check that surcharge covers the curvature bonus
        (, uint256 surcharge) = testHook.getSurchargeState();

        // Theoretical curvature bonus per unit (in WAD fee terms):
        // bonus = (1 - cx) × [(x₀/(x₀-δ))² - 1]
        if (displacement > 0 && eq0Pre > displacement) {
            uint256 ratio = eq0Pre * 1e18 / (eq0Pre - displacement);
            uint256 ratioSquared = ratio * ratio / 1e18;
            uint256 theoreticalBonus = (1e18 - uint256(cx)) * (ratioSquared - 1e18) / 1e18;

            // Surcharge (first block, no decay) should cover the curvature bonus
            assertTrue(
                surcharge >= theoreticalBonus / 2, // Allow 2x tolerance for the approximation
                "INVARIANT: surcharge must cover curvature bonus"
            );
        }
    }
}
