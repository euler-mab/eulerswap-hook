// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV8} from "../src/LPAgentHookV8.sol";
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

/// @title Fork test: deploy V8 hook on real mainnet USDC/WETH pool
/// @dev Run with: forge test --match-contract LPAgentHookV8ForkTest --fork-url $RPC_URL -vvv
contract LPAgentHookV8ForkTest is Test {
    using FullMath for uint256;
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwap constant pool = EulerSwap(0x4311031739918Aba578C3C667DA3028A12Ce28A8);
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    // V8 fee parameters
    uint64 constant BASE_FEE = 5e14;
    uint64 constant MAX_FEE = 3500e14;
    uint64 constant GAS_COEFF = uint64(6.54e10);
    uint64 constant EXTERNAL_FEE = 5e14;
    uint256 constant CAPTURE_RATE = 0.8e18;
    uint256 constant ATTRACT_RATE = 0.3e18;

    // V8 auction parameters (new: no maxShiftMagnitude; add cooldown, timeout, k, guard)
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);
    uint64 constant AUCTION_TRIGGER = 0.6e18;
    uint64 constant CLEAR_THRESHOLD = 0.1e18; // 10% remaining (reserve-based)
    uint64 constant MIN_AUCTION_BLOCKS = 12;
    uint64 constant MIN_AUCTION_INTERVAL = 25; // cooldown blocks
    uint64 constant K_MARGIN_BLOCKS = 15;
    uint64 constant ORACLE_GUARD_MULTIPLIER = 3e18;
    uint64 constant MAX_SNAPSHOT_INTERVAL = 7200; // ~24 min

    // Recenter / surcharge parameters
    uint64 constant RECENTER_RANGE = 0.05e18;
    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;
    uint64 constant SURCHARGE_DECAY = 10e14;
    uint64 constant SURCHARGE_MULTIPLIER = 1.25e18;
    uint64 constant DEPLOY_SURCHARGE = 500e14;

    LPAgentHookV8 hook;
    address asset0;
    address asset1;
    uint8 dec0;
    uint8 dec1;

    function setUp() public {
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

        // Compute market price from Uniswap
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Deploy V8 hook
        vm.startPrank(EULER_ACCOUNT);

        hook = new LPAgentHookV8(
            address(pool),
            EULER_ACCOUNT,
            LPAgentHookV8.OracleConfig({
                target: UNI_USDC_WETH,
                v4PoolId: bytes32(0),
                token0: IUniswapV3Pool(UNI_USDC_WETH).token0()
            }),
            LPAgentHookV8.FeeConfig({
                baseFee: BASE_FEE,
                maxFee: MAX_FEE,
                gasCoeff: GAS_COEFF,
                externalFee: EXTERNAL_FEE,
                captureRate: CAPTURE_RATE,
                attractRate: ATTRACT_RATE
            }),
            LPAgentHookV8.AuctionConfig({
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
                surchargeDecayPerBlock: SURCHARGE_DECAY,
                surchargeMultiplier: SURCHARGE_MULTIPLIER,
                deploySurcharge: DEPLOY_SURCHARGE,
                minDisplacementThreshold: 0,
                weightW0: int256(1e18)
            })
        );
        console.log("V8 hook deployed:", address(hook));

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

        console.log("");
        console.log("=== V8 Hook installed ===");
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
    }

    // ===================================================================
    // Test 1: Constructor state — NAV, baseNetAsset1, trigger coordinates
    // ===================================================================
    function test_fork_constructor_state() public view {
        (uint128 nav, int256 w0) = hook.getDisplacementState();
        console.log("=== V8 Constructor State ===");
        console.log("cachedNav:", uint256(nav));
        console.log("weightW0:", uint256(w0));

        assertTrue(nav > 0, "cachedNav should be > 0");

        // Trigger coordinates should be set
        (uint112 trig0, uint112 trig1, uint64 snapBlock) = hook.getTriggerState();
        console.log("triggerReserve0:", uint256(trig0));
        console.log("triggerReserve1:", uint256(trig1));
        console.log("snapshotBlock:", uint256(snapBlock));
        assertTrue(snapBlock > 0, "snapshot block should be set");

        // Saved concentrations should match pool
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        assertEq(hook.savedConcentrationX(), d.concentrationX, "savedCX");
        assertEq(hook.savedConcentrationY(), d.concentrationY, "savedCY");
    }

    // ===================================================================
    // Test 2: cachedNav matches manual
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

        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);

        uint256 totalDeposits = deposit0 + deposit1.mulDiv(WAD, uniPriceWad);
        uint256 totalDebts = debt0 + debt1.mulDiv(WAD, uniPriceWad);
        uint256 expectedNav = totalDeposits > totalDebts ? totalDeposits - totalDebts : 0;

        (uint128 cachedNav,) = hook.getDisplacementState();
        console.log("Manual NAV:", expectedNav);
        console.log("cachedNav:", uint256(cachedNav));

        if (expectedNav > 0) {
            uint256 diff = expectedNav > cachedNav
                ? expectedNav - uint256(cachedNav)
                : uint256(cachedNav) - expectedNav;
            assertTrue(diff * 100 / expectedNav < 2, "NAV should match within 2%");
        }
    }

    // ===================================================================
    // Test 3: getFee with real prices
    // ===================================================================
    function test_fork_getFee_with_real_prices() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 fee0 = hook.getFee(true, r0, r1, false);
        uint64 fee1 = hook.getFee(false, r0, r1, false);
        console.log("Fee (asset0 in):", uint256(fee0));
        console.log("Fee (asset1 in):", uint256(fee1));
        assertTrue(fee0 >= BASE_FEE, "fee0 >= baseFee");
        assertTrue(fee0 <= MAX_FEE, "fee0 <= maxFee");

        vm.roll(block.number + 20);
        uint64 feeDecayed = hook.getFee(true, r0, r1, false);
        assertTrue(feeDecayed <= fee0, "fee should decay");
    }

    // ===================================================================
    // Test 4: computeQuote works through hook
    // ===================================================================
    function test_fork_computeQuote() public view {
        uint256 smallAmount0 = 10 ** dec0;
        uint256 quoteOut = pool.computeQuote(asset0, asset1, smallAmount0, true);
        assertTrue(quoteOut > 0, "quote should be > 0");

        uint256 smallAmount1 = 10 ** dec1;
        uint256 quoteOut1 = pool.computeQuote(asset1, asset0, smallAmount1, true);
        assertTrue(quoteOut1 > 0, "reverse quote should be > 0");
    }

    // ===================================================================
    // Test 5: Small swap — afterSwap fires without revert
    // ===================================================================
    function test_fork_swap_small() public {
        vm.roll(block.number + 10);

        (uint112 r0,,) = pool.getReserves();
        uint256 swapIn = uint256(r0) / 1000;
        if (swapIn == 0) swapIn = 1;

        uint256 expectedOut = pool.computeQuote(asset0, asset1, swapIn, true);
        if (expectedOut == 0) return;

        SwapCallbackV8 callback = new SwapCallbackV8(asset0, swapIn);
        deal(asset0, address(callback), swapIn);

        vm.prank(address(callback));
        pool.swap(0, expectedOut, address(callback), abi.encode(swapIn));

        uint256 received = IERC20(asset1).balanceOf(address(callback));
        assertEq(received, expectedOut, "should receive quoted amount");

        (uint128 navPost,) = hook.getDisplacementState();
        console.log("Post-swap cachedNav:", uint256(navPost));
    }

    // ===================================================================
    // Test 6: Bidirectional swaps
    // ===================================================================
    function test_fork_swap_both_directions() public {
        vm.roll(block.number + 10);

        (uint112 r0,,) = pool.getReserves();
        uint256 swapIn0 = uint256(r0) / 500;
        uint256 out0 = pool.computeQuote(asset0, asset1, swapIn0, true);
        if (out0 == 0) return;

        SwapCallbackV8 cb0 = new SwapCallbackV8(asset0, swapIn0);
        deal(asset0, address(cb0), swapIn0);
        vm.prank(address(cb0));
        pool.swap(0, out0, address(cb0), abi.encode(swapIn0));

        (uint128 nav1,) = hook.getDisplacementState();
        console.log("NAV after asset0->asset1:", uint256(nav1));

        (, uint112 r1,) = pool.getReserves();
        uint256 swapIn1 = uint256(r1) / 1000;
        uint256 out1 = pool.computeQuote(asset1, asset0, swapIn1, true);
        if (out1 == 0) return;

        SwapCallbackV8 cb1 = new SwapCallbackV8(asset1, swapIn1);
        deal(asset1, address(cb1), swapIn1);
        vm.prank(address(cb1));
        pool.swap(out1, 0, address(cb1), abi.encode(swapIn1));

        (uint128 nav2,) = hook.getDisplacementState();
        console.log("NAV after asset1->asset0:", uint256(nav2));
    }

    // ===================================================================
    // Test 7: Normal mode — no eq changes on small swaps
    // ===================================================================
    function test_fork_normal_mode_no_eq_change() public {
        vm.roll(block.number + 60);

        IEulerSwap.DynamicParams memory dBefore = pool.getDynamicParams();

        // Small swap should not trigger auction or change eq
        (uint112 r0Before,,) = pool.getReserves();
        uint256 swapSize = uint256(r0Before) / 1000;
        uint256 out = pool.computeQuote(asset0, asset1, swapSize, true);
        if (out == 0) return;

        SwapCallbackV8 cb = new SwapCallbackV8(asset0, swapSize);
        deal(asset0, address(cb), swapSize);
        vm.prank(address(cb));
        pool.swap(0, out, address(cb), abi.encode(swapSize));

        IEulerSwap.DynamicParams memory dAfter = pool.getDynamicParams();

        // V8 has no continuous recentering — eq should not change on normal swaps
        if (!hook.auctionActive()) {
            assertEq(dAfter.equilibriumReserve0, dBefore.equilibriumReserve0, "eq0 should not change");
            assertEq(dAfter.equilibriumReserve1, dBefore.equilibriumReserve1, "eq1 should not change");
        }
    }

    // ===================================================================
    // Test 8: Surcharge no overflow with real decimal magnitudes
    // ===================================================================
    function test_fork_surcharge_no_overflow() public {
        vm.roll(block.number + 10);

        (uint112 r0,,) = pool.getReserves();
        uint256 swapSize = uint256(r0) / 50;

        uint256 out1 = pool.computeQuote(asset0, asset1, swapSize, true);
        if (out1 == 0) return;

        SwapCallbackV8 cb1 = new SwapCallbackV8(asset0, swapSize);
        deal(asset0, address(cb1), swapSize);
        vm.prank(address(cb1));
        pool.swap(0, out1, address(cb1), abi.encode(swapSize));

        (,uint112 r1Post,) = pool.getReserves();
        uint256 reverseSize = uint256(r1Post) / 200;
        uint256 out2 = pool.computeQuote(asset1, asset0, reverseSize, true);
        if (out2 == 0) return;

        SwapCallbackV8 cb2 = new SwapCallbackV8(asset1, reverseSize);
        deal(asset1, address(cb2), reverseSize);
        vm.prank(address(cb2));
        pool.swap(out2, 0, address(cb2), abi.encode(reverseSize));

        (, uint256 surcharge) = hook.getSurchargeState();
        console.log("Surcharge (no overflow):", surcharge);
    }

    // ===================================================================
    // Test 9: Pool health
    // ===================================================================
    function test_fork_pool_health() public view {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        uint256 supply0 = IEVault(sp.supplyVault0).maxWithdraw(sp.eulerAccount);
        uint256 supply1 = IEVault(sp.supplyVault1).maxWithdraw(sp.eulerAccount);

        console.log("Supply0:", supply0);
        console.log("Supply1:", supply1);

        (uint256 inLimit, uint256 outLimit) = pool.getLimits(asset0, asset1);
        assertTrue(inLimit > 0 || outLimit > 0, "pool should have swap capacity");
    }

    // ===================================================================
    // Test 10: Trigger coordinates with real vault state
    // ===================================================================
    function test_fork_trigger_coordinates() public view {
        (uint112 trig0, uint112 trig1, uint64 snapBlock) = hook.getTriggerState();
        console.log("triggerReserve0:", uint256(trig0));
        console.log("triggerReserve1:", uint256(trig1));
        console.log("snapshotBlock:", uint256(snapBlock));

        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        uint256 eq0 = uint256(d.equilibriumReserve0);
        uint256 eq1 = uint256(d.equilibriumReserve1);

        // At least one trigger coordinate should be meaningful
        assertTrue(trig0 > 0 || trig1 > 0, "at least one trigger should be > 0");

        // Trigger reserves should be below equilibrium
        if (trig0 > 0) assertTrue(trig0 < eq0, "triggerReserve0 < eq0");
        if (trig1 > 0) assertTrue(trig1 < eq1, "triggerReserve1 < eq1");
    }

    // ===================================================================
    // Test 11: refreshVaultState updates trigger coordinates
    // ===================================================================
    function test_fork_refreshVaultState() public {
        (uint112 trig0Before,,) = hook.getTriggerState();
        (uint128 navBefore,) = hook.getDisplacementState();

        vm.prank(EULER_ACCOUNT);
        hook.refreshVaultState();

        (uint112 trig0After,, uint64 newSnap) = hook.getTriggerState();
        (uint128 navAfter,) = hook.getDisplacementState();

        console.log("NAV before:", uint256(navBefore));
        console.log("NAV after:", uint256(navAfter));
        console.log("triggerReserve0 before:", uint256(trig0Before));
        console.log("triggerReserve0 after:", uint256(trig0After));

        assertTrue(navAfter > 0, "nav should remain positive");
        assertTrue(newSnap > 0, "snapshot block should be updated");
    }

    // ===================================================================
    // Test 12: Oracle guard concept — verify marginal ≈ oracle on fresh pool
    // ===================================================================
    function test_fork_oracle_guard_concept() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();

        // Compute marginal price
        uint256 eq0 = uint256(d.equilibriumReserve0);
        uint256 eq1 = uint256(d.equilibriumReserve1);
        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 marginalPrice;

        if (uint256(r0) <= eq0) {
            uint256 cx = uint256(d.concentrationX);
            uint256 quadTerm = (WAD - cx) * eq0 * eq0 / (uint256(r0) * uint256(r0));
            marginalPrice = px * (cx + quadTerm) / py;
        } else {
            uint256 cy = uint256(d.concentrationY);
            uint256 quadTerm = (WAD - cy) * eq1 * eq1 / (uint256(r1) * uint256(r1));
            marginalPrice = px * WAD / (py * (cy + quadTerm) / WAD);
        }

        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);

        uint256 mismatch;
        if (uniPriceWad > marginalPrice) {
            mismatch = (uniPriceWad - marginalPrice) * WAD / uniPriceWad;
        } else {
            mismatch = (marginalPrice - uniPriceWad) * WAD / uniPriceWad;
        }

        console.log("Marginal price:", marginalPrice);
        console.log("Oracle price:", uniPriceWad);
        console.log("Mismatch:", mismatch);

        // Fresh recentered pool should have marginal ≈ oracle (< 10%)
        assertTrue(mismatch < 0.10e18, "mismatch should be < 10%");
    }

    // ===================================================================
    // Test 13: Multi-swap stability
    // ===================================================================
    function test_fork_multi_swap_stability() public {
        vm.roll(block.number + 10);

        for (uint256 i = 0; i < 10; i++) {
            (uint112 r0, uint112 r1,) = pool.getReserves();

            if (i % 2 == 0) {
                uint256 swapIn = uint256(r0) / 500;
                uint256 out = pool.computeQuote(asset0, asset1, swapIn, true);
                if (out == 0) continue;

                SwapCallbackV8 cb = new SwapCallbackV8(asset0, swapIn);
                deal(asset0, address(cb), swapIn);
                vm.prank(address(cb));
                try pool.swap(0, out, address(cb), abi.encode(swapIn)) {} catch { break; }
            } else {
                uint256 swapIn = uint256(r1) / 500;
                uint256 out = pool.computeQuote(asset1, asset0, swapIn, true);
                if (out == 0) continue;

                SwapCallbackV8 cb = new SwapCallbackV8(asset1, swapIn);
                deal(asset1, address(cb), swapIn);
                vm.prank(address(cb));
                try pool.swap(out, 0, address(cb), abi.encode(swapIn)) {} catch { break; }
            }

            // If auction fired, end it and continue
            if (hook.auctionActive()) {
                vm.prank(EULER_ACCOUNT);
                hook.endAuction();
                vm.roll(block.number + MIN_AUCTION_INTERVAL + 1);
            } else {
                vm.roll(block.number + 1);
            }
        }

        (uint128 nav,) = hook.getDisplacementState();
        console.log("After 10 swaps - nav:", uint256(nav));
        assertTrue(nav > 0, "NAV should remain positive");
    }

    // ===================================================================
    // Test 14: endAuction restores concentration on fork
    // ===================================================================
    function test_fork_endAuction_restores() public {
        IEulerSwap.DynamicParams memory dOrig = pool.getDynamicParams();
        uint64 origCX = dOrig.concentrationX;
        uint64 origCY = dOrig.concentrationY;

        // endAuction when no auction is active — should still work
        vm.prank(EULER_ACCOUNT);
        hook.endAuction();

        IEulerSwap.DynamicParams memory dAfter = pool.getDynamicParams();
        // Concentrations should remain the same (no auction was active)
        assertEq(dAfter.concentrationX, origCX);
        assertEq(dAfter.concentrationY, origCY);
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

/// @dev Flash-swap callback
contract SwapCallbackV8 {
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
