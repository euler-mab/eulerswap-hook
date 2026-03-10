// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV4} from "../src/LPAgentHookV4.sol";
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

contract LPAgentHookV4Test is EulerSwapTestBase {
    using Sqrt for uint256;

    LPAgentHookV4 hook;
    EulerSwap pool;
    MockUniswapV3Pool mockUniPool;

    // Fee params
    uint64 constant BASE_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 3500e14; // 3500 bps (35%)
    uint64 constant GAS_COEFF = 0; // no gas threshold for tests
    uint64 constant EXTERNAL_FEE = 5e14; // 5 bps
    uint256 constant CAPTURE_RATE = 0.8e18; // 80%
    uint256 constant ATTRACT_RATE = 0.5e18; // 50%

    // Auction params
    uint64 constant DECAY_PER_BLOCK = 4e14; // ~4 bps/block
    uint64 constant TRIGGER_THRESHOLD = 0.15e18; // 15% of range
    uint64 constant CLEAR_THRESHOLD = 0.005e18; // 0.5% price convergence (must be < SHIFT_MAGNITUDE)
    uint64 constant SHIFT_MAGNITUDE = 0.01e18; // 1% shift

    uint64 constant SURCHARGE_DECAY = 10e14; // 10 bps/block
    uint64 constant SURCHARGE_INITIAL = 50e14; // 50 bps
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18; // 3%
    uint64 constant MIN_AUCTION_BLOCKS = 5; // minimum 5 blocks before clearing
    uint64 constant RECENTER_RANGE = 1e18; // 100% price range → min ≈ eq/√(1+r/(1-c))

    function setUp() public override {
        super.setUp();

        // 1. Create pool without hook (equal reserves, 1:1 price, c=0)
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        // 2. Get asset addresses from pool
        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        // 3. Deploy mock Uniswap pool at 1:1 price (sqrtPriceX96 = 2^96)
        mockUniPool = new MockUniswapV3Pool(
            asset0Addr, asset1Addr, uint160(1 << 96)
        );

        // 4. Deploy V4 hook
        hook = new LPAgentHookV4(
            address(pool),
            address(this),
            address(mockUniPool),
            LPAgentHookV4.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV4.AuctionConfig({
                decayPerBlock: DECAY_PER_BLOCK,
                triggerThreshold: TRIGGER_THRESHOLD,
                clearThreshold: CLEAR_THRESHOLD,
                shiftMagnitude: SHIFT_MAGNITUDE,

                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeInitialAmount: SURCHARGE_INITIAL,
                maxRecenterDrift: MAX_RECENTER_DRIFT,
                minAuctionBlocks: MIN_AUCTION_BLOCKS,
                recenterRange: RECENTER_RANGE,
                debtTriggerThreshold: 0.25e18
            })
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

    /// @dev Advance block number (foundry's vm.roll)
    function _advanceBlocks(uint256 n) internal {
        vm.roll(block.number + n);
    }

    // ===================================================================
    // Normal mode: getFee tests
    // ===================================================================

    function test_getFee_baseFee_plus_surcharge_at_deployment() public view {
        // Constructor sets surchargeStartBlock = block.number
        // At block 0: surcharge = surchargeInitialAmount = 50 bps
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);

        // baseFee + surcharge = 25 + 50 = 75 bps + attract component
        assertTrue(fee >= BASE_FEE + SURCHARGE_INITIAL, "fee should include surcharge at deployment");
    }

    function test_getFee_surcharge_decays_to_zero() public {
        // Surcharge = 50 bps, decay = 10 bps/block → fully decayed after 5 blocks
        _advanceBlocks(5);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        hook.getFee(true, r0, r1, false); // should not revert

        // After 5 blocks: surcharge = max(0, 50 - 5*10) = 0 → just normal fee
        (, uint256 surcharge) = hook.getSurchargeState();
        assertEq(surcharge, 0, "surcharge should be zero after 5 blocks");
    }

    function test_getFee_surcharge_partially_decayed() public {
        _advanceBlocks(3);

        (, uint256 surcharge) = hook.getSurchargeState();
        // 50 - 3*10 = 20 bps
        assertEq(surcharge, 20e14, "surcharge should be 20 bps after 3 blocks");
    }

    function test_getFee_baseFee_when_no_mismatch_and_surcharge_zero() public {
        _advanceBlocks(10); // surcharge fully decayed

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee0In = hook.getFee(true, r0, r1, false);
        uint64 fee1In = hook.getFee(false, r0, r1, false);

        // At 1:1 price, mismatch=0. One direction is arb (fee=baseFee), the other attract
        // (fee=baseFee + attractRate*externalFee = 25 + 0.5*5 = 27.5 bps).
        // Both should be close to baseFee.
        assertTrue(fee0In >= BASE_FEE, "fee0 should be at least baseFee");
        assertTrue(fee1In >= BASE_FEE, "fee1 should be at least baseFee");
        assertApproxEqAbs(fee0In, fee1In, 3e14, "fees near symmetric at 1:1 price");
    }

    function test_getFee_elevated_on_arb_direction() public {
        _advanceBlocks(10);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // uniPrice > marginalPrice → pool underprices asset0 → arb buys asset0 (asset1 in)
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false); // arb direction
        uint64 feeAsset0In = hook.getFee(true, r0, r1, false); // attract direction

        assertTrue(feeAsset1In > BASE_FEE, "arb direction should exceed baseFee");
        assertTrue(feeAsset1In > feeAsset0In, "arb fee should exceed attract fee");
    }

    function test_getFee_attract_captures_routing_headroom() public {
        _advanceBlocks(10);
        // 15 bps mismatch + 5 bps externalFee = 20 bps headroom
        // attractRate = 0.5 → capture 10 bps → fee = 25 + 10 = 35 bps
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.0015e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 attractFee = hook.getFee(true, r0, r1, false);

        assertTrue(attractFee > BASE_FEE, "attract fee should exceed baseFee");
    }

    function test_getFee_clamped_to_maxFee() public {
        _advanceBlocks(10);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18)); // 100% mismatch
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
        vm.expectRevert(LPAgentHookV4.Unauthorized.selector);
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

    function test_setAuctionParams() public {
        // clearThreshold (0.01) must be < shiftMagnitude (0.02)
        hook.setAuctionParams(5e14, 0.6e18, 0.01e18, 0.02e18, 0.05e18, 10, 0.5e18, 0.3e18);
        assertEq(hook.decayPerBlock(), 5e14);
        assertEq(hook.triggerThreshold(), 0.6e18);
        assertEq(hook.clearThreshold(), 0.01e18);
        assertEq(hook.shiftMagnitude(), 0.02e18);

        assertEq(hook.maxRecenterDrift(), 0.05e18);
        assertEq(hook.minAuctionBlocks(), 10);
        assertEq(hook.recenterRange(), 0.5e18);
        assertEq(hook.debtTriggerThreshold(), 0.3e18);
    }

    function test_setAuctionParams_validates_thresholds() public {
        vm.expectRevert("clear threshold must be < shift magnitude");
        hook.setAuctionParams(5e14, 0.5e18, 0.02e18, 0.01e18, 0.03e18, 5, 1e18, 0.25e18);
    }

    function test_setSurchargeParams() public {
        hook.setSurchargeParams(20e14, 100e14);
        (uint64 decay, uint64 initial) = hook.getSurchargeParams();
        assertEq(decay, 20e14);
        assertEq(initial, 100e14);
    }

    function test_endAuction_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHookV4.Unauthorized.selector);
        hook.endAuction();
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    function test_afterSwap_onlyPool() public {
        vm.expectRevert(LPAgentHookV4.OnlyPool.selector);
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 0, 0);
    }

    // ===================================================================
    // View helpers
    // ===================================================================

    function test_getFeeParams() public view {
        (uint64 base, uint64 max, uint64 coeff, uint64 ext, uint256 capture, uint256 attract) = hook.getFeeParams();
        assertEq(base, BASE_FEE);
        assertEq(max, MAX_FEE);
        assertEq(coeff, GAS_COEFF);
        assertEq(ext, EXTERNAL_FEE);
        assertEq(capture, CAPTURE_RATE);
        assertEq(attract, ATTRACT_RATE);
    }

    function test_getAuctionState_initially_inactive() public view {
        (bool active,,,) = hook.getAuctionState();
        assertFalse(active, "auction should be inactive initially");
    }

    // ===================================================================
    // Equity clearing: trigger
    // ===================================================================

    function test_auction_triggers_on_large_swap_asset0_deficit() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        // Large swap: asset1 in → asset0 out → reserve0 drops below eq0
        _fundAndSwap(swapper, false, 3e18);

        (bool active,,, bool clearAsset0) = hook.getAuctionState();
        assertTrue(active, "auction should be active after large swap");
        assertTrue(clearAsset0, "should want asset0 in (asset0 deficit)");
    }

    function test_auction_triggers_on_large_swap_asset1_deficit() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        // Large swap: asset0 in → asset1 out → reserve1 drops below eq1
        _fundAndSwap(swapper, true, 3e18);

        (bool active,,, bool clearAsset0) = hook.getAuctionState();
        assertTrue(active, "auction should be active after large swap");
        assertFalse(clearAsset0, "should want asset1 in (asset1 deficit)");
    }

    function test_auction_does_not_trigger_on_small_swap() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 0.1e18);

        (bool active,,,) = hook.getAuctionState();
        assertFalse(active, "auction should not trigger on small swap");
    }

    // ===================================================================
    // Equity clearing: shift direction
    // ===================================================================

    function test_shift_decreases_py_on_asset0_deficit() public {
        _advanceBlocks(10);
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyBefore = dpBefore.priceY;

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // asset0 deficit

        assertTrue(hook.auctionActive(), "auction should be active");
        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertTrue(dpAfter.priceY < pyBefore, "priceY should DECREASE for asset0 deficit (amplify overpricing)");

        // Verify: py_new = py_old * WAD / (WAD + shift)
        uint80 expectedPy = uint80(uint256(pyBefore) * 1e18 / (1e18 + uint256(SHIFT_MAGNITUDE)));
        assertEq(dpAfter.priceY, expectedPy, "priceY shift magnitude should match");
    }

    function test_shift_increases_py_on_asset1_deficit() public {
        _advanceBlocks(10);
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();
        uint80 pyBefore = dpBefore.priceY;

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 3e18); // asset1 deficit

        assertTrue(hook.auctionActive(), "auction should be active");
        IEulerSwap.DynamicParams memory dpAfter = pool.getDynamicParams();
        assertTrue(dpAfter.priceY > pyBefore, "priceY should INCREASE for asset1 deficit (amplify underpricing)");

        uint80 expectedPy = uint80(uint256(pyBefore) * (1e18 + uint256(SHIFT_MAGNITUDE)) / 1e18);
        assertEq(dpAfter.priceY, expectedPy, "priceY shift magnitude should match");
    }

    function test_shift_stores_preShiftPriceY() public {
        _advanceBlocks(10);
        IEulerSwap.DynamicParams memory dpBefore = pool.getDynamicParams();

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);

        assertEq(hook.preShiftPriceY(), dpBefore.priceY, "preShiftPriceY should match pre-shift value");
    }

    function test_shift_sets_eq_to_current_reserves() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(dp.equilibriumReserve0, r0, "eq0 should match current reserves");
        assertEq(dp.equilibriumReserve1, r1, "eq1 should match current reserves");
    }

    function test_shift_relaxes_min_reserves() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.minReserve0, 0, "minReserve0 should be 0 during auction");
        assertEq(dp.minReserve1, 0, "minReserve1 should be 0 during auction");
    }

    // ===================================================================
    // Equity clearing: getFee during auction
    // ===================================================================

    function test_auction_fee_decays_per_block() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // asset0 deficit → clearAsset0 = true

        (,, uint64 startingFee,) = hook.getAuctionState();
        assertTrue(startingFee > 0, "starting fee should be positive");

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Block 0: clearing direction (asset0 in) gets startingFee
        uint64 feeBlock0 = hook.getFee(true, r0, r1, false);
        assertEq(feeBlock0, startingFee, "clearing fee at block 0 = startingFee");

        // Block 5: fee decayed by 5 * decayPerBlock
        _advanceBlocks(5);
        uint64 feeBlock5 = hook.getFee(true, r0, r1, false);
        uint256 expectedFee5 = uint256(startingFee) - 5 * uint256(DECAY_PER_BLOCK);
        assertEq(feeBlock5, uint64(expectedFee5), "clearing fee should decay per block");
    }

    function test_auction_fee_floors_at_baseFee() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);

        // Advance many blocks past full decay
        _advanceBlocks(1000);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);
        assertEq(fee, BASE_FEE, "auction fee should floor at baseFee");
    }

    function test_auction_non_clearing_gets_elevated_fee() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // asset0 deficit → clearAsset0 = true

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Non-clearing direction (asset1 in) should get max(auctionFee, normalFee)
        uint64 nonClearingFee = hook.getFee(false, r0, r1, false);
        uint64 clearingFee = hook.getFee(true, r0, r1, false);

        assertTrue(nonClearingFee >= clearingFee, "non-clearing fee should be >= clearing fee");
    }

    // ===================================================================
    // Equity clearing: lifecycle (trigger → clear → recenter)
    // ===================================================================

    function test_auction_clears_and_recenters() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        // Trigger auction: asset1 in → asset0 out → asset0 deficit
        _fundAndSwap(swapper, false, 3e18);
        assertTrue(hook.auctionActive(), "auction should start");

        // After shift, eq = current reserves, min = 0
        // Any clearing trade (asset0 in) that moves reserve0 above eq0
        // will trigger the exposure flip and likely clear

        // Advance blocks for fee decay
        _advanceBlocks(25);

        // Send clearing swap — calibrated to converge marginal price to within clearThreshold of oracle.
        // With 1% shift on ~7.4e18 reserves at c=0.5, price sensitivity ~0.14%/0.01e18.
        // A 0.05e18 swap closes ~0.7% of 1% mispricing → within 0.5% threshold.
        _fundAndSwap(swapper, true, 0.05e18);

        // The auction should have cleared (exposure drops below threshold after tiny swap)
        assertFalse(hook.auctionActive(), "auction should have cleared");

        // Surcharge should be activated
        (, uint256 surcharge) = hook.getSurchargeState();
        assertTrue(surcharge > 0, "surcharge should be active after recenter");
    }

    function test_recenter_clamps_price_within_drift() public {
        _advanceBlocks(10);

        // Increase shift to 10% so the shifted marginal price is far from pre-shift
        hook.setAuctionParams(
            DECAY_PER_BLOCK,
            TRIGGER_THRESHOLD,
            0.005e18,   // clearThreshold
            0.10e18,    // 10% shift magnitude
            MAX_RECENTER_DRIFT,
            MIN_AUCTION_BLOCKS,
            RECENTER_RANGE,
            0.25e18     // debtTriggerThreshold
        );

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // trigger auction with 10% shift

        uint80 preShiftPy = hook.preShiftPriceY();
        assertTrue(hook.auctionActive(), "auction should be active");

        // After a 10% shift on asset0-deficit, py decreased by 10% → marginal price ~1.1
        // Set oracle to match the shifted marginal price so clearing succeeds
        // (marginal ≈ oracle → priceDiff < clearThreshold)
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        // Advance past minAuctionBlocks and do a tiny swap to trigger clearing check
        _advanceBlocks(25);
        _fundAndSwap(swapper, true, 0.01e18);

        assertFalse(hook.auctionActive(), "auction should clear");

        // Check that priceY was clamped
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        uint256 maxPy = uint256(preShiftPy) * (1e18 + uint256(MAX_RECENTER_DRIFT)) / 1e18;
        uint256 minPy = uint256(preShiftPy) * 1e18 / (1e18 + uint256(MAX_RECENTER_DRIFT));

        assertTrue(dp.priceY <= uint80(maxPy), "priceY should be <= maxPY after clamp");
        assertTrue(dp.priceY >= uint80(minPy), "priceY should be >= minPY after clamp");
    }

    function test_recenter_restores_min_reserves() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // trigger

        _advanceBlocks(25);
        _fundAndSwap(swapper, true, 0.05e18); // clear with price-converging swap

        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertTrue(dp.minReserve0 > 0, "minReserve0 should be restored after recenter");
        assertTrue(dp.minReserve1 > 0, "minReserve1 should be restored after recenter");

        // Verify min reserves match curve formula: min = eq / sqrt(1 + r/(1-c))
        // Pool has cx = cy = 0.5e18, recenterRange = 1e18
        // inner = 1e18 + 1e18 * 1e18 / 0.5e18 = 1e18 + 2e18 = 3e18
        // min = eq * sqrt(1e18) / sqrt(3e18) = eq / sqrt(3)
        uint256 sqrtWAD = uint256(1e18).sqrt();
        uint256 sqrtInner = uint256(3e18).sqrt();
        uint256 expectedMin0 = uint256(dp.equilibriumReserve0) * sqrtWAD / sqrtInner;
        uint256 expectedMin1 = uint256(dp.equilibriumReserve1) * sqrtWAD / sqrtInner;

        assertEq(dp.minReserve0, uint112(expectedMin0), "minReserve0 should match curve formula");
        assertEq(dp.minReserve1, uint112(expectedMin1), "minReserve1 should match curve formula");
    }

    function test_surcharge_activates_after_recenter() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);
        _advanceBlocks(25);
        _fundAndSwap(swapper, true, 0.05e18); // larger swap to converge price within clearThreshold

        assertFalse(hook.auctionActive());

        // Surcharge should be at initial amount
        (, uint256 surcharge) = hook.getSurchargeState();
        assertEq(surcharge, uint256(SURCHARGE_INITIAL), "surcharge should be at initial after recenter");

        // After decay blocks, surcharge should decrease
        _advanceBlocks(3);
        (, uint256 surchargeAfter) = hook.getSurchargeState();
        assertEq(surchargeAfter, uint256(SURCHARGE_INITIAL) - 3 * uint256(SURCHARGE_DECAY), "surcharge should decay");
    }

    // ===================================================================
    // Emergency: owner can force-end auction
    // ===================================================================

    function test_endAuction_clears_auction_state() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18);
        assertTrue(hook.auctionActive());

        hook.endAuction();
        assertFalse(hook.auctionActive(), "owner should be able to force-end auction");
    }

    // ===================================================================
    // Full lifecycle: normal → clearing → normal
    // ===================================================================

    function test_full_cycle_normal_to_clearing_to_normal() public {
        _advanceBlocks(10); // let deployment surcharge decay

        // Phase 1: Normal mode — small swaps, no auction trigger
        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 0.1e18);
        assertFalse(hook.auctionActive(), "no auction for small swap");

        // Phase 2: Large swap triggers equity clearing
        _fundAndSwap(swapper, false, 3e18);
        assertTrue(hook.auctionActive(), "auction should trigger");

        // Phase 3: Fee decay + clearing trade (calibrated to converge price)
        _advanceBlocks(25);
        _fundAndSwap(swapper, true, 0.05e18);
        assertFalse(hook.auctionActive(), "auction should clear");

        // Phase 4: Back in normal mode with surcharge
        (, uint256 surcharge) = hook.getSurchargeState();
        assertTrue(surcharge > 0, "surcharge should be active");

        // Phase 5: Surcharge decays
        _advanceBlocks(10);
        (, uint256 surchargeAfter) = hook.getSurchargeState();
        assertEq(surchargeAfter, 0, "surcharge should be fully decayed");

        // Phase 6: Verify pool is back in normal mode and can process swaps
        // After recenter with range=1e18 and c=0.5, min ≈ 57.7% of eq.
        // Use a very small swap to avoid re-triggering.
        _fundAndSwap(swapper, true, 0.001e18);
        // Pool processes the swap without reverting — normal mode restored
        // (may or may not re-trigger depending on exact reserve position)
    }

    // ===================================================================
    // Swap integration: verify swaps work with hook installed
    // ===================================================================

    function test_swap_works_in_normal_mode() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 0.5e18);
        _fundAndSwap(swapper, false, 0.5e18);

        // No reverts = success
    }

    function test_swap_works_during_auction() public {
        _advanceBlocks(10);

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, false, 3e18); // trigger auction
        assertTrue(hook.auctionActive(), "auction should be active");

        // Swap before minAuctionBlocks should not clear (even if price would converge)
        _advanceBlocks(2); // only 2 blocks, less than MIN_AUCTION_BLOCKS (5)
        _fundAndSwap(swapper, true, 0.01e18); // small clearing direction, too early
        assertTrue(hook.auctionActive(), "auction should still be active before minAuctionBlocks");

        // Non-clearing direction should work and not clear (price diverges further)
        _fundAndSwap(swapper, false, 0.01e18);
        assertTrue(hook.auctionActive(), "auction should still be active after non-clearing swap");
    }
}
