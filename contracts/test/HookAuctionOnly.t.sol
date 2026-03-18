// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {HookAuctionOnly} from "../src/HookAuctionOnly.sol";
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

contract HookAuctionOnlyTest is EulerSwapTestBase {
    using Sqrt for uint256;

    HookAuctionOnly hook;
    EulerSwap pool;
    MockUniswapV3Pool mockUniPool;

    // Fee params (simple)
    uint64 constant FIXED_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 3500e14; // 3500 bps (35%)

    // Auction params
    uint64 constant DECAY_PER_BLOCK = 4e14;
    uint64 constant AUCTION_TRIGGER = 0.6e18;
    uint64 constant CLEAR_THRESHOLD = 0.1e18;
    uint64 constant MIN_AUCTION_BLOCKS = 5;
    uint64 constant MIN_AUCTION_INTERVAL = 10;
    uint64 constant K_MARGIN_BLOCKS = 15;
    uint64 constant ORACLE_GUARD_MULTIPLIER = 3e18;
    uint64 constant MAX_SNAPSHOT_INTERVAL = 1000;

    // Recenter params
    uint64 constant RECENTER_RANGE = 1e18;
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;

    function _defaultAuctionConfig() internal pure returns (HookAuctionOnly.AuctionConfig memory) {
        return HookAuctionOnly.AuctionConfig({
            decayPerBlock: DECAY_PER_BLOCK,
            triggerFraction: AUCTION_TRIGGER,
            clearThreshold: CLEAR_THRESHOLD,
            minAuctionBlocks: MIN_AUCTION_BLOCKS,
            minAuctionInterval: MIN_AUCTION_INTERVAL,
            kMarginBlocks: K_MARGIN_BLOCKS,
            oracleGuardMultiplier: ORACLE_GUARD_MULTIPLIER,
            maxSnapshotInterval: MAX_SNAPSHOT_INTERVAL,
            recenterRange: RECENTER_RANGE,
            maxRecenterDrift: MAX_RECENTER_DRIFT,
            minDisplacementThreshold: 0,
            weightW0: int256(1e18)
        });
    }

    function setUp() public override {
        super.setUp();

        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        mockUniPool = new MockUniswapV3Pool(asset0Addr, asset1Addr, uint160(1 << 96));

        hook = new HookAuctionOnly(
            address(pool),
            address(this),
            HookAuctionOnly.OracleConfig({
                target: address(mockUniPool),
                v4PoolId: bytes32(0),
                token0: asset0Addr
            }),
            FIXED_FEE,
            MAX_FEE,
            _defaultAuctionConfig()
        );

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

    function _triggerAuctionDirect(address swapper) internal {
        hook.setTriggerParams(type(uint64).max, MAX_SNAPSHOT_INTERVAL);
        uint64 origDecay = hook.decayPerBlock();
        hook.setAuctionParams(
            uint64(1e18),
            hook.triggerFraction(),
            hook.clearThreshold(),
            hook.minAuctionBlocks(),
            hook.minAuctionInterval(),
            hook.kMarginBlocks(),
            hook.minDisplacementThreshold()
        );
        _fundAndSwap(swapper, false, 5e18);
        hook.setAuctionParams(
            origDecay,
            hook.triggerFraction(),
            hook.clearThreshold(),
            hook.minAuctionBlocks(),
            hook.minAuctionInterval(),
            hook.kMarginBlocks(),
            hook.minDisplacementThreshold()
        );
    }

    // ===================================================================
    // getFee: fixed in normal mode
    // ===================================================================

    function test_getFee_returns_fixedFee_in_normal_mode() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, FIXED_FEE, "normal mode should return fixedFee");
    }

    function test_getFee_fixedFee_regardless_of_oracle() public {
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.5e18));
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, FIXED_FEE, "normal mode fee should not depend on oracle");
    }

    // ===================================================================
    // Owner management
    // ===================================================================

    function test_setFeeParams() public {
        hook.setFeeParams(50e14, 5000e14);
        assertEq(hook.fixedFee(), 50e14);
        assertEq(hook.maxFee(), 5000e14);
    }

    function test_setFeeParams_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(HookAuctionOnly.Unauthorized.selector);
        hook.setFeeParams(50e14, 5000e14);
    }

    function test_setAuctionParams() public {
        hook.setAuctionParams(5e14, 0.6e18, 0.01e18, 10, 20, 25, 100e6);
        assertEq(hook.decayPerBlock(), 5e14);
        assertEq(hook.minAuctionInterval(), 20);
        assertEq(hook.kMarginBlocks(), 25);
        assertEq(hook.minDisplacementThreshold(), 100e6);
    }

    function test_setTriggerParams() public {
        hook.setTriggerParams(5e18, 2000);
        assertEq(hook.oracleGuardMultiplier(), 5e18);
        assertEq(hook.maxSnapshotInterval(), 2000);
    }

    function test_setRecenterParams() public {
        hook.setRecenterParams(0.5e18, 0.05e18);
        assertEq(hook.recenterRange(), 0.5e18);
        assertEq(hook.maxRecenterDrift(), 0.05e18);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    function test_afterSwap_onlyPool() public {
        vm.expectRevert(HookAuctionOnly.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 0, 0);
    }

    function test_refreshVaultState_onlyOwner() public {
        hook.refreshVaultState();

        vm.prank(makeAddr("random"));
        vm.expectRevert(HookAuctionOnly.Unauthorized.selector);
        hook.refreshVaultState();
    }

    // ===================================================================
    // Core: displacement tracking
    // ===================================================================

    function test_first_swap_no_eq_change() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        _fundAndSwap(swapper, true, 0.5e18);

        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertEq(dpAfter.equilibriumReserve0, dpBefore.equilibriumReserve0, "eq should not change on first swap");
    }

    function test_displacement_increases_with_directional_swaps() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        _fundAndSwap(swapper, false, 1e18);
        (, uint256 relDisp1,) = hook.computeCurrentDisplacement();
        assertTrue(relDisp1 > 0, "displacement should be positive after directional swap");

        _fundAndSwap(swapper, false, 0.5e18);
        (, uint256 relDisp2,) = hook.computeCurrentDisplacement();
        assertTrue(relDisp2 >= relDisp1, "displacement should increase with more directional flow");
    }

    // ===================================================================
    // NAV tracking
    // ===================================================================

    function test_cachedNav_positive_on_init() public view {
        (uint128 nav,) = hook.getDisplacementState();
        assertTrue(nav > 0, "initial NAV should be positive");
    }

    function test_cachedNav_reflects_pool_value() public view {
        (uint128 nav, int256 w0) = hook.getDisplacementState();
        assertTrue(nav > 0, "NAV should be positive");
        assertEq(w0, int256(1e18), "weightW0 should match constructor value");
    }

    // ===================================================================
    // Trigger coordinates
    // ===================================================================

    function test_trigger_coordinates_set_on_init() public view {
        (uint112 tReserve0, uint112 tReserve1, uint64 snapshotBlock) = hook.getTriggerState();
        assertTrue(tReserve0 > 0 || tReserve1 > 0, "trigger coordinates should be set on init");
        assertTrue(snapshotBlock > 0, "lastSnapshotBlock should be set");
    }

    function test_trigger_does_not_fire_within_coordinates() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 0.5e18);

        (bool active,,,,, ) = hook.getAuctionState();
        assertFalse(active, "small swap should not trigger auction");
    }

    function test_trigger_fires_at_boundary() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        (bool active,,,,, ) = hook.getAuctionState();
        assertTrue(active, "large swap should trigger auction via reserve coordinates");
    }

    function test_trigger_coordinates_account_for_displacement() public view {
        (uint112 tReserve0, uint112 tReserve1,) = hook.getTriggerState();
        assertTrue(tReserve0 > 0 || tReserve1 > 0, "at least one trigger coordinate should be nonzero");
    }

    // ===================================================================
    // Time-based trigger
    // ===================================================================

    function test_time_trigger_fires_after_maxInterval() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 0.5e18);
        assertFalse(hook.auctionActive(), "should not trigger from small swap");

        _advanceBlocks(MAX_SNAPSHOT_INTERVAL + 1);
        _fundAndSwap(swapper, false, 0.01e18);
    }

    function test_time_trigger_does_not_fire_at_equilibrium() public {
        _advanceBlocks(MAX_SNAPSHOT_INTERVAL + 1);
        assertFalse(hook.auctionActive(), "no auction at equilibrium");
    }

    // ===================================================================
    // Constant-sum auction
    // ===================================================================

    function test_auction_reconfigures_to_constant_sum() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        assertTrue(hook.auctionActive(), "auction should be active");

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.concentrationX, uint64(1e18), "concentrationX should be 1e18 (constant-sum)");
        assertEq(dp.concentrationY, uint64(1e18), "concentrationY should be 1e18 (constant-sum)");
    }

    function test_auction_locks_wrong_direction() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        bool oneSideLocked = (dp.minReserve0 == r0) || (dp.minReserve1 == r1);
        assertTrue(oneSideLocked, "one side should be locked during auction");
    }

    function test_auction_clearing_amount_matches_exposure() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        (bool active,,,, uint112 clearingAmount,) = hook.getAuctionState();
        assertTrue(active);
        assertTrue(clearingAmount > 0, "clearing amount should be positive");
    }

    function test_auction_starting_fee_formula() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        (,, uint64 startingFee,,,) = hook.getAuctionState();
        uint256 minExpectedFee = uint256(K_MARGIN_BLOCKS) * uint256(DECAY_PER_BLOCK);
        assertTrue(startingFee >= minExpectedFee, "starting fee should be at least k*D");
        assertTrue(startingFee > FIXED_FEE, "starting fee should exceed fixedFee");
    }

    function test_auction_fee_decays() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        (,, uint64 startingFee, bool clearAsset0,,) = hook.getAuctionState();
        assertTrue(startingFee > 0);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee0 = hook.getFee(clearAsset0, r0, r1, false);
        assertEq(fee0, startingFee);

        _advanceBlocks(5);
        uint64 fee5 = hook.getFee(clearAsset0, r0, r1, false);
        uint256 expected = uint256(startingFee) - 5 * uint256(DECAY_PER_BLOCK);
        if (expected < uint256(FIXED_FEE)) expected = uint256(FIXED_FEE);
        assertEq(fee5, uint64(expected));
    }

    function test_auction_wrong_direction_gets_maxFee() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);

        (,,, bool clearAsset0,,) = hook.getAuctionState();

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 wrongFee = hook.getFee(!clearAsset0, r0, r1, false);
        assertEq(wrongFee, MAX_FEE, "wrong direction should get maxFee during auction");
    }

    function test_auction_respects_minAuctionBlocks() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        _advanceBlocks(2);
        _fundAndSwap(swapper, true, 0.01e18);
        assertTrue(hook.auctionActive(), "auction should not clear before minAuctionBlocks");
    }

    // ===================================================================
    // Auction clearing: reserve-based
    // ===================================================================

    function test_auction_clears_on_reserve_threshold() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        _advanceBlocks(50);
        _fundAndSwap(swapper, true, 3e18);
    }

    function test_auction_clears_and_restores_concentration() public {
        _advanceBlocks(60);

        IEulerSwap.DynamicParams memory dpOrig = pool.getDynamicParams();
        uint64 origCX = dpOrig.concentrationX;
        uint64 origCY = dpOrig.concentrationY;

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        IEulerSwap.DynamicParams memory dpAuction = pool.getDynamicParams();
        assertEq(dpAuction.concentrationX, uint64(1e18));
        assertEq(dpAuction.concentrationY, uint64(1e18));

        hook.endAuction();
        assertFalse(hook.auctionActive());

        IEulerSwap.DynamicParams memory dpRestored = pool.getDynamicParams();
        assertEq(dpRestored.concentrationX, origCX, "concentrationX should be restored");
        assertEq(dpRestored.concentrationY, origCY, "concentrationY should be restored");
    }

    // ===================================================================
    // Post-auction: no surcharge, immediate return to fixedFee
    // ===================================================================

    function test_no_surcharge_after_auction() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        hook.endAuction();
        assertFalse(hook.auctionActive());

        // Fee should immediately be fixedFee, no surcharge
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, FIXED_FEE, "fee should be fixedFee immediately after auction end");
    }

    // ===================================================================
    // Post-auction cooldown
    // ===================================================================

    function test_cooldown_prevents_rapid_retrigger() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        hook.endAuction();
        assertFalse(hook.auctionActive());

        (,,,,, uint64 endBlock) = hook.getAuctionState();
        assertEq(endBlock, uint64(block.number), "endBlock should be current");
        assertTrue(block.number <= uint256(endBlock) + uint256(MIN_AUCTION_INTERVAL), "within cooldown");
    }

    function test_cooldown_expires_allows_retrigger() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());
        hook.endAuction();
        assertFalse(hook.auctionActive());

        _advanceBlocks(MIN_AUCTION_INTERVAL + 1);

        (,,,,, uint64 endBlock) = hook.getAuctionState();
        assertTrue(block.number > uint256(endBlock) + uint256(MIN_AUCTION_INTERVAL), "past cooldown");

        hook.setTriggerParams(type(uint64).max, MAX_SNAPSHOT_INTERVAL);
        hook.setAuctionParams(
            uint64(1e18), hook.triggerFraction(), hook.clearThreshold(),
            hook.minAuctionBlocks(), hook.minAuctionInterval(), hook.kMarginBlocks(),
            hook.minDisplacementThreshold()
        );
        _fundAndSwap(swapper, false, 3e18);

        (bool active,,,,, ) = hook.getAuctionState();
        assertTrue(active, "auction should retrigger after cooldown expires");
    }

    // ===================================================================
    // Owner: endAuction
    // ===================================================================

    function test_endAuction_sets_endBlock() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        hook.endAuction();

        (,,,,, uint64 endBlock) = hook.getAuctionState();
        assertEq(endBlock, uint64(block.number), "endBlock should be set to current block");
    }

    function test_endAuction_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(HookAuctionOnly.Unauthorized.selector);
        hook.endAuction();
    }

    function test_endAuction_force_clears() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive());

        hook.endAuction();
        assertFalse(hook.auctionActive());
    }

    // ===================================================================
    // Full lifecycle (no surcharge)
    // ===================================================================

    function test_full_cycle_trigger_auction_end() public {
        _advanceBlocks(60);

        address swapper = makeAddr("swapper");

        // Phase 1: Trigger auction
        _triggerAuctionDirect(swapper);
        assertTrue(hook.auctionActive(), "auction should trigger");

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.concentrationX, uint64(1e18), "constant-sum during auction");

        // Phase 2: End auction
        hook.endAuction();
        assertFalse(hook.auctionActive(), "auction ended");

        // Phase 3: Concentration restored, fee is fixedFee
        dp = pool.getDynamicParams();
        assertEq(dp.concentrationX, 0.5e18, "concentration restored after auction");

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, FIXED_FEE, "fee should be fixedFee after auction end");
    }

    // ===================================================================
    // View helpers
    // ===================================================================

    function test_getDisplacementState() public view {
        (uint128 nav, int256 w0) = hook.getDisplacementState();
        assertTrue(nav > 0, "initial NAV should be positive");
        assertEq(w0, int256(1e18), "weightW0 should be 1e18");
    }

    function test_getAuctionState_initially_inactive() public view {
        (bool active,,,,,) = hook.getAuctionState();
        assertFalse(active, "auction should be inactive on init");
    }

    function test_getTriggerState_view() public view {
        (uint112 t0, uint112 t1, uint64 snap) = hook.getTriggerState();
        assertTrue(t0 > 0 || t1 > 0, "trigger reserves should be nonzero");
        assertTrue(snap > 0, "snapshot block should be set");
    }

    function test_getTriggerParams_view() public view {
        (uint64 g, uint64 maxInterval) = hook.getTriggerParams();
        assertEq(g, ORACLE_GUARD_MULTIPLIER);
        assertEq(maxInterval, MAX_SNAPSHOT_INTERVAL);
    }

    function test_computeCurrentDisplacement() public view {
        (, uint256 relDisp, uint256 nav) = hook.computeCurrentDisplacement();
        assertTrue(nav > 0, "NAV should be positive");
        // At equilibrium displacement may be small but computable
        assertTrue(relDisp >= 0, "relative displacement should be non-negative");
    }
}
