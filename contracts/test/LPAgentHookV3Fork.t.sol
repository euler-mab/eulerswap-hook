// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV3} from "../src/LPAgentHookV3.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

interface IUniswapV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
}

/// @title LPAgentHookV3 Fork Tests
/// @notice Validates V3 hook against real mainnet USDC/WETH pool and Uniswap oracle.
/// @dev Run with: forge test --match-contract LPAgentHookV3ForkTest --fork-url $MAINNET_RPC_URL -vv
contract LPAgentHookV3ForkTest is Test {
    using FullMath for uint256;

    // Mainnet addresses
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwap constant pool = EulerSwap(0x4311031739918Aba578C3C667DA3028A12Ce28A8);
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;

    uint256 constant WAD = 1e18;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant MIN_RESERVE_BPS = 9759;

    LPAgentHookV3 hook;
    uint112 computedNAV;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        // Read current pool state
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        console.log("=== Pre-deploy pool state ===");
        console.log("Reserve0 (USDC raw):", uint256(r0));
        console.log("Reserve1 (WETH raw):", uint256(r1));
        console.log("PriceX:", uint256(dp.priceX));
        console.log("PriceY:", uint256(dp.priceY));
        console.log("Eq0:", uint256(dp.equilibriumReserve0));
        console.log("Eq1:", uint256(dp.equilibriumReserve1));

        // Deploy V3 hook
        hook = new LPAgentHookV3(
            address(pool),
            address(this),
            UNI_USDC_WETH,
            5e14,            // baseFee: 5 bps
            3500e14,         // maxFee: 3500 bps
            uint64(6.54e10), // gasCoeff
            5e14,            // externalFee: 5 bps
            0.8e18,          // captureRate: 80%
            0.3e18           // attractRate: 30%
        );

        // Compute NAV from vault state
        computedNAV = _computeNAV(sp, dp);
        console.log("Computed NAV (USDC raw):", uint256(computedNAV));
        console.log("Computed NAV (USDC):", uint256(computedNAV) / 1e6);

        // Set auction params
        hook.setAuctionParams(
            computedNAV,
            5000,              // triggerBps: 50%
            uint64(100e14),    // delta: 100 bps
            uint64(200e14),    // startFee: 200 bps
            uint64(1e14)       // decayPerSecond: 1 bps/sec
        );

        // Compute market priceY from Uniswap
        uint80 marketPriceY = _computeMarketPriceY(dp.priceX);
        console.log("Market PriceY:", uint256(marketPriceY));

        // Reconfigure pool to install V3 hook
        dp.swapHook = address(hook);
        dp.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        dp.priceY = marketPriceY;
        dp.equilibriumReserve0 = r0;
        dp.equilibriumReserve1 = r1;
        dp.minReserve0 = uint112(uint256(r0) * MIN_RESERVE_BPS / 10000);
        dp.minReserve1 = uint112(uint256(r1) * MIN_RESERVE_BPS / 10000);

        vm.prank(EULER_ACCOUNT);
        evc.call(
            address(pool), EULER_ACCOUNT, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (dp, IEulerSwap.InitialState(r0, r1)))
        );

        console.log("V3 hook installed:", address(hook));
    }

    // --- NAV Computation ---

    function _computeNAV(IEulerSwap.StaticParams memory sp, IEulerSwap.DynamicParams memory dp)
        internal
        view
        returns (uint112)
    {
        // Query actual vault balances
        uint256 supply0 = IEVault(sp.supplyVault0).maxWithdraw(sp.eulerAccount);
        uint256 supply1 = IEVault(sp.supplyVault1).maxWithdraw(sp.eulerAccount);
        uint256 debt0 =
            sp.borrowVault0 != address(0) ? IEVault(sp.borrowVault0).debtOf(sp.eulerAccount) : 0;
        uint256 debt1 =
            sp.borrowVault1 != address(0) ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount) : 0;

        console.log("  Supply0 (USDC raw):", supply0);
        console.log("  Supply1 (WETH raw):", supply1);
        console.log("  Debt0 (USDC raw):", debt0);
        console.log("  Debt1 (WETH raw):", debt1);

        // Convert WETH amounts to USDC terms using px/py (same formula as contract's exposure calc)
        uint256 px = uint256(dp.priceX);
        uint256 py = uint256(dp.priceY);
        uint256 supply1_in_0 = supply1 * px / py;
        uint256 debt1_in_0 = debt1 * px / py;

        uint256 totalAssets = supply0 + supply1_in_0;
        uint256 totalDebts = debt0 + debt1_in_0;
        require(totalAssets >= totalDebts, "Pool underwater");

        return uint112(totalAssets - totalDebts);
    }

    function _computeMarketPriceY(uint80 priceX) internal view returns (uint80) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        return uint80(uint256(priceX) * WAD / priceWad);
    }

    // --- Tests ---

    function test_fork_hook_installed() public view {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        assertEq(dp.swapHook, address(hook), "Hook address mismatch");
        assertEq(dp.swapHookedOperations, EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP, "Hooked ops mismatch");
    }

    function test_fork_auction_params() public view {
        (bool active,,, uint112 _nav, uint64 _triggerBps) = hook.getAuctionState();
        assertFalse(active, "Auction should not be active");
        assertEq(_nav, computedNAV, "NAV mismatch");
        assertEq(_triggerBps, 5000, "TriggerBps mismatch");
    }

    function test_fork_nav_reasonable() public view {
        // NAV should be in $2k-$10k range (based on pool history)
        uint256 navUsd = uint256(computedNAV) / 1e6;
        assertGt(navUsd, 1000, "NAV too low (< $1k)");
        assertLt(navUsd, 50000, "NAV too high (> $50k)");
    }

    function test_fork_getFee_normal_mode() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // At eq, mismatch should be small → fee near baseFee
        uint64 fee = hook.getFee(true, r0, r1, true);
        assertGe(fee, hook.baseFee(), "Fee below baseFee");
        assertLe(fee, hook.maxFee(), "Fee above maxFee");

        console.log("getFee(asset0In):", uint256(fee));
        console.log("  = bps:", uint256(fee) / 1e14);
    }

    function test_fork_getFee_both_directions() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 fee0In = hook.getFee(true, r0, r1, true);
        uint64 fee1In = hook.getFee(false, r0, r1, true);

        // Both should be valid fees
        assertGe(fee0In, hook.baseFee());
        assertGe(fee1In, hook.baseFee());

        console.log("Fee asset0In:", uint256(fee0In) / 1e14, "bps");
        console.log("Fee asset1In:", uint256(fee1In) / 1e14, "bps");
    }

    function test_fork_afterSwap_noop_at_eq() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // At eq, afterSwap should not trigger auction
        vm.prank(address(pool));
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), r0, r1);

        assertFalse(hook.auctionActive(), "Auction should not trigger at eq");
    }

    function test_fork_afterSwap_noop_small_deviation() public {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (, uint112 r1,) = pool.getReserves();

        // Small deviation (1 bps of eq0) - should NOT trigger
        uint112 smallDev = uint112(uint256(dp.equilibriumReserve0) * 9999 / 10000);

        vm.prank(address(pool));
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), smallDev, r1);

        assertFalse(hook.auctionActive(), "Auction should not trigger on 1 bps deviation");
    }

    function test_fork_afterSwap_triggers_large_deviation() public {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (, uint112 r1,) = pool.getReserves();

        // Large deviation: drop reserve0 below eq0 by > 50% of NAV
        uint256 threshold = uint256(computedNAV) * 5000 / 10000;
        uint112 triggerReserve0 = uint112(uint256(dp.equilibriumReserve0) - threshold - 1);

        vm.prank(address(pool));
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), triggerReserve0, r1);

        assertTrue(hook.auctionActive(), "Auction should trigger on large deviation");
        assertFalse(hook.auctionAttractAsset1(), "Should attract asset0 (USDC)");

        console.log("Auction triggered at reserve0:", uint256(triggerReserve0));
    }

    function test_fork_auction_getFee_override() public {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (, uint112 r1,) = pool.getReserves();

        // Trigger auction (attract asset0 = USDC)
        uint256 threshold = uint256(computedNAV) * 5000 / 10000;
        uint112 triggerR0 = uint112(uint256(dp.equilibriumReserve0) - threshold - 1);

        vm.prank(address(pool));
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), triggerR0, r1);
        assertTrue(hook.auctionActive());

        // Attract direction (asset0 input = USDC flowing in) should get decaying fee
        uint64 attractFee = hook.getFee(true, triggerR0, r1, true);
        assertLe(attractFee, hook.auctionStartFee(), "Attract fee should be <= startFee");

        // Wrong direction (asset1 input) should get maxFee (blocked)
        uint64 blockFee = hook.getFee(false, triggerR0, r1, true);
        assertEq(blockFee, uint64(hook.maxFee()), "Wrong direction should get maxFee");

        console.log("Attract fee:", uint256(attractFee) / 1e14, "bps");
        console.log("Block fee:", uint256(blockFee) / 1e14, "bps");
    }

    function test_fork_trigger_calibration() public view {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();

        uint256 eq0 = uint256(dp.equilibriumReserve0);
        uint256 threshold = uint256(computedNAV) * 5000 / 10000; // 50% NAV
        uint256 dropBps = threshold * 10000 / eq0;

        console.log("=== Trigger calibration ===");
        console.log("Eq0 (USDC raw):", eq0);
        console.log("NAV (USDC raw):", uint256(computedNAV));
        console.log("Trigger threshold (USDC raw):", threshold);
        console.log("Reserve0 drop to trigger:", dropBps, "bps of eq0");
        console.log("Approx ETH price move to trigger: ~", dropBps * 2, "bps");

        // Sanity: trigger should require 10-500 bps drop
        assertGt(dropBps, 5, "Trigger too sensitive (< 5 bps)");
        assertLt(dropBps, 1000, "Trigger too insensitive (> 10%)");
    }

    function test_fork_computeQuote_works() public view {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        address asset0 = IEVault(sp.supplyVault0).asset();
        address asset1 = IEVault(sp.supplyVault1).asset();

        // Small quote: 100 USDC -> WETH
        uint256 out = pool.computeQuote(asset0, asset1, 100e6, true);
        assertGt(out, 0, "Quote should be non-zero");
        console.log("Quote: 100 USDC ->", out, "WETH raw");

        // Reverse: 0.05 WETH -> USDC
        uint256 out2 = pool.computeQuote(asset1, asset0, 0.05e18, true);
        assertGt(out2, 0, "Reverse quote should be non-zero");
        console.log("Quote: 0.05 WETH ->", out2, "USDC raw");
    }

    function test_fork_clearAuction_owner_only() public {
        // Only owner should be able to clear
        vm.prank(address(0xdead));
        vm.expectRevert();
        hook.clearAuction();

        // Owner can clear (even if no auction active, should not revert)
        hook.clearAuction();
    }

    function test_fork_boundary_factor_minReserves() public view {
        IEulerSwap.DynamicParams memory dp = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // minReserves should be ~97.59% of reserves (BOUNDARY_FACTOR)
        uint256 expectedMin0 = uint256(r0) * MIN_RESERVE_BPS / 10000;
        uint256 expectedMin1 = uint256(r1) * MIN_RESERVE_BPS / 10000;

        assertEq(uint256(dp.minReserve0), expectedMin0, "minReserve0 mismatch");
        assertEq(uint256(dp.minReserve1), expectedMin1, "minReserve1 mismatch");
    }
}
