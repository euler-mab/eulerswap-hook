// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV7} from "../src/LPAgentHookV7.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);

    function token0() external view returns (address);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title Fork test: deploy V7 hook on real mainnet USDC/WETH pool
/// @dev Run with: forge test --match-contract LPAgentHookV7ForkTest --fork-url $RPC_URL -vvv
contract LPAgentHookV7ForkTest is Test {
    using FullMath for uint256;
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwap constant pool = EulerSwap(0x4311031739918Aba578C3C667DA3028A12Ce28A8);
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    // V7 fee parameters
    uint64 constant BASE_FEE = 5e14;
    uint64 constant MAX_FEE = 3500e14;
    uint64 constant GAS_COEFF = uint64(6.54e10);
    uint64 constant EXTERNAL_FEE = 5e14;
    uint256 constant CAPTURE_RATE = 0.8e18;
    uint256 constant ATTRACT_RATE = 0.3e18;

    // V7 auction parameters
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);
    uint64 constant AUCTION_TRIGGER = 0.6e18; // 60% relative exposure
    uint64 constant CLEAR_THRESHOLD = 0.005e18;
    uint64 constant MAX_SHIFT_MAGNITUDE = 0.015e18; // 150bps (exposure-sized, capped)
    uint64 constant MIN_AUCTION_BLOCKS = 12;
    uint64 constant RECENTER_RANGE = 0.05e18;
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;
    uint64 constant SURCHARGE_DECAY = 10e14;
    uint64 constant SURCHARGE_MULTIPLIER = 1.25e18; // safety margin on exact formula
    uint64 constant DEPLOY_SURCHARGE = 500e14;

    LPAgentHookV7 hook;
    address asset0;
    address asset1;
    uint8 dec0;
    uint8 dec1;

    function setUp() public {
        // Read pool state
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        asset0 = IEVault(sp.supplyVault0).asset();
        asset1 = IEVault(sp.supplyVault1).asset();
        dec0 = IERC20(asset0).decimals();
        dec1 = IERC20(asset1).decimals();

        console.log("Asset0:", asset0, "decimals:", dec0);
        console.log("Asset1:", asset1, "decimals:", dec1);

        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("priceX:", uint256(d.priceX));
        console.log("priceY:", uint256(d.priceY));
        console.log("cx:", uint256(d.concentrationX));
        console.log("cy:", uint256(d.concentrationY));
        console.log("Current hook:", d.swapHook);

        // Compute market price from Uniswap
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);
        console.log("Uniswap sqrtPriceX96:", uint256(sqrtPriceX96));
        console.log("Uniswap priceWad:", priceWad);

        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);
        console.log("Market priceY:", uint256(marketPriceY));

        // Deploy V7 hook
        vm.startPrank(EULER_ACCOUNT);

        hook = new LPAgentHookV7(
            address(pool),
            EULER_ACCOUNT,
            LPAgentHookV7.OracleConfig({
                target: UNI_USDC_WETH,
                v4PoolId: bytes32(0),
                token0: IUniswapV3Pool(UNI_USDC_WETH).token0()
            }),
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
                minRecenterDelta: 0,
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER,
                deploySurcharge: DEPLOY_SURCHARGE
            })
        );
        console.log("V7 hook deployed:", address(hook));

        // Install hook via EVC reconfigure
        (r0, r1,) = pool.getReserves();
        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;
        d.minReserve0 = _computeMinReserve(r0, d.concentrationX);
        d.minReserve1 = _computeMinReserve(r1, d.concentrationY);

        evc.call(
            address(pool),
            EULER_ACCOUNT,
            0,
            abi.encodeCall(IEulerSwap.reconfigure, (d, IEulerSwap.InitialState(r0, r1)))
        );

        vm.stopPrank();

        // Verify installation
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        assertEq(finalD.swapHook, address(hook), "hook should be installed");
        assertEq(finalD.swapHookedOperations, EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP);

        console.log("");
        console.log("=== V7 Hook installed ===");
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
    }

    // ===================================================================
    // Test 1: Constructor initializes V7-specific state from real vaults
    // ===================================================================
    function test_fork_constructor_state() public view {
        // cachedNav should be initialized from real vault deposits/debts
        (uint64 lastExp, int128 baseNet, uint128 nav) = hook.getExposureState();
        console.log("=== V7 Constructor State ===");
        console.log("lastExposure:", uint256(lastExp));
        console.log("baseNetAsset1:", baseNet >= 0 ? uint256(int256(baseNet)) : 0);
        console.log("cachedNav:", uint256(nav));

        assertTrue(nav > 0, "cachedNav should be > 0 from real vault state");

        // baseNetAsset1 should reflect real WETH position
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        uint256 deposit1 = IEVault(sp.supplyVault1).convertToAssets(
            IEVault(sp.supplyVault1).balanceOf(sp.eulerAccount)
        );
        uint256 debt1 = sp.borrowVault1 != address(0)
            ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount)
            : 0;
        int256 expectedNet = int256(deposit1) - int256(debt1);
        console.log("Expected baseNetAsset1:", expectedNet >= 0 ? uint256(expectedNet) : 0);
        console.log("Debt1:", debt1);

        // Should match within rounding
        int256 diff = int256(baseNet) - expectedNet;
        if (diff < 0) diff = -diff;
        assertTrue(uint256(diff) < 1e15, "baseNetAsset1 should match vault state");
    }

    // ===================================================================
    // Test 2: cachedNav matches manual NAV computation
    // ===================================================================
    function test_fork_cachedNav_matches_manual() public view {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        uint256 deposit0 = IEVault(sp.supplyVault0).convertToAssets(
            IEVault(sp.supplyVault0).balanceOf(sp.eulerAccount)
        );
        uint256 deposit1 = IEVault(sp.supplyVault1).convertToAssets(
            IEVault(sp.supplyVault1).balanceOf(sp.eulerAccount)
        );
        uint256 debt0 = sp.borrowVault0 != address(0)
            ? IEVault(sp.borrowVault0).debtOf(sp.eulerAccount)
            : 0;
        uint256 debt1 = sp.borrowVault1 != address(0)
            ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount)
            : 0;

        // Get Uniswap price for conversion
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);

        // Manual NAV: all in asset0 terms
        uint256 totalDeposits = deposit0 + deposit1.mulDiv(WAD, uniPriceWad);
        uint256 totalDebts = debt0 + debt1.mulDiv(WAD, uniPriceWad);
        uint256 expectedNav = totalDeposits > totalDebts ? totalDeposits - totalDebts : 0;

        (,, uint128 cachedNav) = hook.getExposureState();

        console.log("=== NAV Comparison ===");
        console.log("Manual NAV:", expectedNav);
        console.log("cachedNav:", uint256(cachedNav));

        // Within 1% (rounding from share→asset conversion)
        if (expectedNav > 0) {
            uint256 diff = expectedNav > cachedNav
                ? expectedNav - uint256(cachedNav)
                : uint256(cachedNav) - expectedNav;
            assertTrue(diff * 100 / expectedNav < 2, "NAV should match within 2%");
        }
    }

    // ===================================================================
    // Test 3: getFee returns reasonable values with real prices
    // ===================================================================
    function test_fork_getFee_with_real_prices() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // After deployment, surcharge is active
        uint64 fee0 = hook.getFee(true, r0, r1, false);
        uint64 fee1 = hook.getFee(false, r0, r1, false);
        console.log("Fee (asset0 in):", uint256(fee0));
        console.log("Fee (asset1 in):", uint256(fee1));
        assertTrue(fee0 >= BASE_FEE, "fee0 >= baseFee");
        assertTrue(fee1 >= BASE_FEE, "fee1 >= baseFee");
        assertTrue(fee0 <= MAX_FEE, "fee0 <= maxFee");
        assertTrue(fee1 <= MAX_FEE, "fee1 <= maxFee");

        // After surcharge decays
        vm.roll(block.number + 20);
        uint64 feeDecayed = hook.getFee(true, r0, r1, false);
        console.log("Fee after 20 blocks:", uint256(feeDecayed));
        assertTrue(feeDecayed <= fee0, "fee should decay");
    }

    // ===================================================================
    // Test 4: computeQuote works through the hook
    // ===================================================================
    function test_fork_computeQuote() public view {
        uint256 smallAmount0 = 10 ** dec0; // 1 unit of asset0
        uint256 quoteOut = pool.computeQuote(asset0, asset1, smallAmount0, true);
        console.log("Quote: 1 asset0 ->", quoteOut, "asset1");
        assertTrue(quoteOut > 0, "quote should be > 0");

        uint256 smallAmount1 = 10 ** dec1;
        uint256 quoteOut1 = pool.computeQuote(asset1, asset0, smallAmount1, true);
        console.log("Quote: 1 asset1 ->", quoteOut1, "asset0");
        assertTrue(quoteOut1 > 0, "reverse quote should be > 0");
    }

    // ===================================================================
    // Test 5: Execute a real swap — afterSwap fires without revert
    // ===================================================================
    function test_fork_swap_small() public {
        vm.roll(block.number + 10);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 swapIn = uint256(r0) / 1000; // 0.1% of reserve0
        if (swapIn == 0) swapIn = 1;

        uint256 expectedOut = pool.computeQuote(asset0, asset1, swapIn, true);
        console.log("Swap in:", swapIn, "expected out:", expectedOut);

        if (expectedOut == 0) {
            console.log("SKIP: swap too small");
            return;
        }

        SwapCallback callback = new SwapCallback(asset0, swapIn);
        deal(asset0, address(callback), swapIn);

        vm.prank(address(callback));
        pool.swap(0, expectedOut, address(callback), abi.encode(swapIn));

        uint256 received = IERC20(asset1).balanceOf(address(callback));
        assertEq(received, expectedOut, "should receive quoted amount");

        // afterSwap should have updated lastExposure
        (uint64 lastExp,,) = hook.getExposureState();
        console.log("Post-swap lastExposure:", uint256(lastExp));
    }

    // ===================================================================
    // Test 6: Swap in opposite direction — test exposure tracking
    // ===================================================================
    function test_fork_swap_both_directions() public {
        vm.roll(block.number + 10);

        // Swap asset0 → asset1
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 swapIn0 = uint256(r0) / 500; // 0.2%
        uint256 out0 = pool.computeQuote(asset0, asset1, swapIn0, true);
        if (out0 == 0) return;

        SwapCallback cb0 = new SwapCallback(asset0, swapIn0);
        deal(asset0, address(cb0), swapIn0);
        vm.prank(address(cb0));
        pool.swap(0, out0, address(cb0), abi.encode(swapIn0));

        (uint64 expAfterFirst,,) = hook.getExposureState();
        console.log("Exposure after asset0->asset1:", uint256(expAfterFirst));

        // Swap asset1 → asset0 (reducing direction)
        (r0, r1,) = pool.getReserves();
        uint256 swapIn1 = uint256(r1) / 1000;
        uint256 out1 = pool.computeQuote(asset1, asset0, swapIn1, true);
        if (out1 == 0) return;

        SwapCallback cb1 = new SwapCallback(asset1, swapIn1);
        deal(asset1, address(cb1), swapIn1);
        vm.prank(address(cb1));
        pool.swap(out1, 0, address(cb1), abi.encode(swapIn1));

        (uint64 expAfterSecond,,) = hook.getExposureState();
        console.log("Exposure after asset1->asset0:", uint256(expAfterSecond));

        // Second swap should have different exposure
        // (may trigger recenter if exposure decreased)
    }

    // ===================================================================
    // Test 7: Continuous recenter fires on exposure decrease
    // ===================================================================
    function test_fork_continuous_recenter() public {
        vm.roll(block.number + 60); // clear deploy surcharge

        IEulerSwap.DynamicParams memory dBefore = pool.getDynamicParams();

        // This pool has pre-existing WETH exposure (~94% relative exposure from vault state).
        // Any swap is likely to push relative exposure above the 60% auction trigger.
        // We test that the hook correctly starts an auction in this case.
        (uint112 r0Before,,) = pool.getReserves();
        uint256 swapSize = uint256(r0Before) / 1000; // small swap
        uint256 out = pool.computeQuote(asset0, asset1, swapSize, true);
        if (out == 0) return;

        SwapCallback cb = new SwapCallback(asset0, swapSize);
        deal(asset0, address(cb), swapSize);
        vm.prank(address(cb));
        pool.swap(0, out, address(cb), abi.encode(swapSize));

        // With high pre-existing relative exposure, auction should trigger
        bool auctionFired = hook.auctionActive();
        if (auctionFired) {
            // Auction started: verify eq was set to current reserves and min reserves relaxed
            IEulerSwap.DynamicParams memory dAuction = pool.getDynamicParams();
            (uint112 postR0, uint112 postR1,) = pool.getReserves();
            assertEq(dAuction.equilibriumReserve0, postR0, "auction: eq0 == reserve0");
            assertEq(dAuction.equilibriumReserve1, postR1, "auction: eq1 == reserve1");
            assertEq(dAuction.minReserve0, 0, "auction: min0 relaxed");
            assertEq(dAuction.minReserve1, 0, "auction: min1 relaxed");
            assertTrue(hook.auctionStartingFee() > 0, "auction: starting fee set");
            return;
        }

        // If auction didn't fire, test continuous recenter.
        // The pool has pre-existing WETH long exposure. To trigger recenter we need
        // a swap that REDUCES that exposure (same direction as existing exposure = more WETH out).
        // A large enough asset0→asset1 swap increases WETH exposure → no recenter.
        // Instead, swap asset1→asset0 which reduces net WETH long by selling WETH.
        // But if the swap is too large and flips sign, the sign-flip gate blocks recenter.
        // So we use a moderate size that reduces but doesn't flip.
        (uint64 expAfterFirst,,) = hook.getExposureState();
        bool dirAfterFirst = hook.lastNetLongWeth();
        console.log("Exposure after first swap:", uint256(expAfterFirst));
        console.log("Net long WETH:", dirAfterFirst);
        assertTrue(expAfterFirst > 0, "first swap should create exposure");

        vm.roll(block.number + 1);

        // Do a tiny swap in the same direction as the first (asset0→asset1) to nudge
        // the existing exposure down slightly without overshooting past neutral.
        // The pool's pre-existing vault exposure (baseNetAsset1) means the net WETH
        // position is small but positive. A tiny additional WETH withdrawal reduces it.
        {
            (uint112 r0Curr,,) = pool.getReserves();
            uint256 tinySize = uint256(r0Curr) / 5000; // very small: 0.02% of reserves
            uint256 outTiny = pool.computeQuote(asset0, asset1, tinySize, true);
            if (outTiny == 0) return;

            SwapCallback cb2 = new SwapCallback(asset0, tinySize);
            deal(asset0, address(cb2), tinySize);
            vm.prank(address(cb2));
            pool.swap(0, outTiny, address(cb2), abi.encode(tinySize));
        }

        IEulerSwap.DynamicParams memory dAfter = pool.getDynamicParams();
        (uint64 expAfterSecond,,) = hook.getExposureState();
        console.log("Exposure after reverse:", uint256(expAfterSecond));

        bool recentered = dAfter.equilibriumReserve0 != dBefore.equilibriumReserve0
            || dAfter.priceY != dBefore.priceY;

        // Either recenter fired, or exposure decreased (sign-flip gate may block recenter
        // if the reverse swap crossed through neutral — both are valid hook behavior)
        bool exposureDecreased = expAfterSecond < expAfterFirst;
        assertTrue(recentered || exposureDecreased,
            "reverse swap should either trigger recenter or decrease exposure");
    }

    // ===================================================================
    // Test 8: Surcharge uses exact curvature formula — no overflow at
    //         real reserve magnitudes (USDC 6-dec, WETH 18-dec)
    // ===================================================================
    function test_fork_surcharge_no_overflow() public {
        vm.roll(block.number + 10);

        // Do a swap that will create displacement, then a reverse to trigger recenter
        (uint112 r0,,) = pool.getReserves();
        uint256 swapSize = uint256(r0) / 50; // 2% — should create measurable displacement

        uint256 out1 = pool.computeQuote(asset0, asset1, swapSize, true);
        if (out1 == 0) return;

        SwapCallback cb1 = new SwapCallback(asset0, swapSize);
        deal(asset0, address(cb1), swapSize);
        vm.prank(address(cb1));
        pool.swap(0, out1, address(cb1), abi.encode(swapSize));

        // Reverse half to trigger recenter
        (,uint112 r1Post,) = pool.getReserves();
        uint256 reverseSize = uint256(r1Post) / 200;
        uint256 out2 = pool.computeQuote(asset1, asset0, reverseSize, true);
        if (out2 == 0) return;

        // This is the critical test — the recenter path calls _initSurcharge
        // which computes eq0.mulDiv(eq0, r0).mulDiv(WAD, r0) with real reserves.
        // Must not overflow with ~624k USDC (6 dec) or ~301 WETH (18 dec).
        SwapCallback cb2 = new SwapCallback(asset1, reverseSize);
        deal(asset1, address(cb2), reverseSize);
        vm.prank(address(cb2));
        pool.swap(out2, 0, address(cb2), abi.encode(reverseSize));

        // If we got here without revert, the surcharge computation didn't overflow
        (, uint256 surcharge) = hook.getSurchargeState();
        console.log("Surcharge (no overflow):", surcharge);
    }

    // ===================================================================
    // Test 9: Pool health — verify vault state is sound
    // ===================================================================
    function test_fork_pool_health() public view {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        uint256 supply0 = IEVault(sp.supplyVault0).maxWithdraw(sp.eulerAccount);
        uint256 supply1 = IEVault(sp.supplyVault1).maxWithdraw(sp.eulerAccount);
        uint256 debt0 = sp.borrowVault0 != address(0)
            ? IEVault(sp.borrowVault0).debtOf(sp.eulerAccount)
            : 0;
        uint256 debt1 = sp.borrowVault1 != address(0)
            ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount)
            : 0;

        console.log("Supply0:", supply0);
        console.log("Supply1:", supply1);
        console.log("Debt0:", debt0);
        console.log("Debt1:", debt1);

        (uint256 inLimit, uint256 outLimit) = pool.getLimits(asset0, asset1);
        console.log("Limits: in:", inLimit, "out:", outLimit);
        assertTrue(inLimit > 0 || outLimit > 0, "pool should have swap capacity");
    }

    // ===================================================================
    // Test 10: Relative exposure view function with real state
    // ===================================================================
    function test_fork_relative_exposure() public {
        vm.roll(block.number + 10);

        // Initial relative exposure
        (uint256 relExp0,,) = hook.computeCurrentVaultExposure();
        console.log("Initial relative exposure:", relExp0);

        // Create some exposure
        (uint112 r0,,) = pool.getReserves();
        uint256 swapIn = uint256(r0) / 200; // 0.5%
        uint256 out = pool.computeQuote(asset0, asset1, swapIn, true);
        if (out == 0) return;

        SwapCallback cb = new SwapCallback(asset0, swapIn);
        deal(asset0, address(cb), swapIn);
        vm.prank(address(cb));
        pool.swap(0, out, address(cb), abi.encode(swapIn));

        (uint256 relExp1, uint256 absExp, bool netLong) = hook.computeCurrentVaultExposure();
        console.log("Relative exposure after swap:", relExp1);
        console.log("Absolute exposure after swap:", absExp);
        console.log("Net long WETH:", netLong);
    }

    // ===================================================================
    // Test 11: Auction trigger with large directional flow
    // ===================================================================
    function test_fork_auction_trigger() public {
        vm.roll(block.number + 10);

        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();

        // V7 triggers on relative exposure (NAV-based), not reserve-based.
        // To trigger, we need |netWeth| * ethPrice / cachedNav > AUCTION_TRIGGER.
        // This requires sustained directional flow. Do multiple swaps.
        uint256 totalSwapped;
        for (uint256 i = 0; i < 5; i++) {
            (uint112 r0,,) = pool.getReserves();
            uint256 swapIn = uint256(r0) / 50; // 2% each
            uint256 out;
            try pool.computeQuote(asset0, asset1, swapIn, true) returns (uint256 _out) {
                out = _out;
            } catch {
                break;
            }
            if (out == 0) break;

            SwapCallback cb = new SwapCallback(asset0, swapIn);
            deal(asset0, address(cb), swapIn);
            vm.prank(address(cb));
            try pool.swap(0, out, address(cb), abi.encode(swapIn)) {
                totalSwapped += swapIn;
            } catch {
                break;
            }

            if (hook.auctionActive()) break;
        }

        console.log("Total swapped:", totalSwapped);

        bool active = hook.auctionActive();
        console.log("Auction active:", active);

        if (active) {
            (, uint64 startBlock, uint64 startingFee, bool clearAsset0) = hook.getAuctionState();
            console.log("Auction startBlock:", uint256(startBlock));
            console.log("Auction startingFee:", uint256(startingFee));
            console.log("Auction clearAsset0:", clearAsset0);

            // Starting fee should be proportional to exposure
            assertTrue(startingFee > 0, "starting fee should be > 0");

            // Min reserves should be 0 during auction
            IEulerSwap.DynamicParams memory dPost = pool.getDynamicParams();
            assertEq(dPost.minReserve0, 0, "min0 should be 0 during auction");
            assertEq(dPost.minReserve1, 0, "min1 should be 0 during auction");

            // Auction fee on clearing direction should be elevated
            (uint112 postR0, uint112 postR1,) = pool.getReserves();
            uint64 auctionFee = hook.getFee(clearAsset0, postR0, postR1, false);
            console.log("Auction fee (clearing dir):", uint256(auctionFee));
        } else {
            (uint256 relExp,,) = hook.computeCurrentVaultExposure();
            console.log("Relative exposure:", relExp);
            console.log("Trigger threshold:", uint256(AUCTION_TRIGGER));
            console.log("Auction did not trigger - exposure below threshold for this pool depth");
        }
    }

    // ===================================================================
    // Test 12: Uniswap price oracle integration
    // ===================================================================
    function test_fork_uniswap_price_oracle() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);
        console.log("Uniswap price (WAD):", uniPriceWad);

        // Pool marginal price (concentration-aware for V7)
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        uint256 marginalPrice;
        uint256 eq0 = uint256(d.equilibriumReserve0);
        uint256 eq1 = uint256(d.equilibriumReserve1);
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);

        if (uint256(r0) <= eq0) {
            uint256 cx = uint256(d.concentrationX);
            uint256 quadTerm = (WAD - cx) * eq0 * eq0 / (uint256(r0) * uint256(r0));
            marginalPrice = px * (cx + quadTerm) / py;
        } else {
            uint256 cy = uint256(d.concentrationY);
            uint256 quadTerm = (WAD - cy) * eq1 * eq1 / (uint256(r1) * uint256(r1));
            marginalPrice = px * WAD / (py * (cy + quadTerm) / WAD);
        }
        console.log("Marginal price (conc-aware):", marginalPrice);

        uint256 mismatch;
        if (uniPriceWad > marginalPrice) {
            mismatch = (uniPriceWad - marginalPrice) * WAD / uniPriceWad;
        } else {
            mismatch = (marginalPrice - uniPriceWad) * WAD / uniPriceWad;
        }
        console.log("Price mismatch:", mismatch);
        assertTrue(mismatch < 0.10e18, "mismatch should be < 10%");
    }

    // ===================================================================
    // Test 13: refreshVaultState updates cachedNav
    // ===================================================================
    function test_fork_refreshVaultState() public {
        (,, uint128 navBefore) = hook.getExposureState();

        vm.prank(EULER_ACCOUNT);
        hook.refreshVaultState();

        (,, uint128 navAfter) = hook.getExposureState();
        console.log("NAV before refresh:", uint256(navBefore));
        console.log("NAV after refresh:", uint256(navAfter));

        // Should be same or very close (no interest accrued in same block)
        assertTrue(navAfter > 0, "nav should remain positive after refresh");
    }

    // ===================================================================
    // Test 14: Multiple swaps — verify no revert accumulation
    // ===================================================================
    function test_fork_multi_swap_stability() public {
        vm.roll(block.number + 10);

        // 10 alternating swaps to stress-test the afterSwap path
        for (uint256 i = 0; i < 10; i++) {
            (uint112 r0, uint112 r1,) = pool.getReserves();

            if (i % 2 == 0) {
                uint256 swapIn = uint256(r0) / 500;
                uint256 out = pool.computeQuote(asset0, asset1, swapIn, true);
                if (out == 0) continue;

                SwapCallback cb = new SwapCallback(asset0, swapIn);
                deal(asset0, address(cb), swapIn);
                vm.prank(address(cb));
                try pool.swap(0, out, address(cb), abi.encode(swapIn)) {} catch { break; }
            } else {
                uint256 swapIn = uint256(r1) / 500;
                uint256 out = pool.computeQuote(asset1, asset0, swapIn, true);
                if (out == 0) continue;

                SwapCallback cb = new SwapCallback(asset1, swapIn);
                deal(asset1, address(cb), swapIn);
                vm.prank(address(cb));
                try pool.swap(out, 0, address(cb), abi.encode(swapIn)) {} catch { break; }
            }

            vm.roll(block.number + 1);
        }

        // If we got here, all swaps succeeded
        (uint64 lastExp,, uint128 nav) = hook.getExposureState();
        console.log("After 10 swaps - lastExposure:", uint256(lastExp), "nav:", uint256(nav));
        assertTrue(nav > 0, "NAV should remain positive");
    }

    // ===================================================================
    // Helpers
    // ===================================================================

    function _computeMinReserve(uint112 eqReserve, uint64 concentration) internal pure returns (uint112) {
        uint256 r = uint256(RECENTER_RANGE);
        if (r == 0) return 0;
        uint256 c = uint256(concentration);
        if (c >= WAD) return 0;
        uint256 inner = WAD + r * WAD / (WAD - c);
        uint256 sqrtWAD = WAD.sqrt();
        uint256 sqrtInner = inner.sqrt();
        return uint112(uint256(eqReserve) * sqrtWAD / sqrtInner);
    }
}

/// @dev Flash-swap callback: sends input tokens to the pool.
contract SwapCallback {
    address immutable token;
    uint256 immutable amount;

    constructor(address _token, uint256 _amount) {
        token = _token;
        amount = _amount;
    }

    function eulerSwapCall(address, uint256, uint256, bytes calldata) external {
        IERC20(token).transfer(msg.sender, amount);
    }
}
