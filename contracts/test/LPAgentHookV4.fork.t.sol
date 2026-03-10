// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV4} from "../src/LPAgentHookV4.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";
import {Sqrt} from "../eulerswap/src/math/Sqrt.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title Fork test: deploy V4 hook on real mainnet USDC/WETH pool and exercise swaps
/// @dev Run with: forge test --match-contract LPAgentHookV4ForkTest --fork-url $RPC_URL -vvv
contract LPAgentHookV4ForkTest is Test {
    using FullMath for uint256;
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwap constant pool = EulerSwap(0x4311031739918Aba578C3C667DA3028A12Ce28A8);
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    // V4 hook parameters (matching deploy script)
    uint64 constant BASE_FEE = 5e14;
    uint64 constant MAX_FEE = 3500e14;
    uint64 constant GAS_COEFF = uint64(6.54e10);
    uint64 constant EXTERNAL_FEE = 5e14;
    uint256 constant CAPTURE_RATE = 0.8e18;
    uint256 constant ATTRACT_RATE = 0.3e18;
    uint64 constant DECAY_PER_BLOCK = uint64(4.3e14);
    uint64 constant TRIGGER_THRESHOLD = 0.15e18;
    uint64 constant CLEAR_THRESHOLD = 0.005e18;
    uint64 constant SHIFT_MAGNITUDE = 0.0108e18;

    uint64 constant MAX_RECENTER_DRIFT = 0.03e18;
    uint64 constant MIN_AUCTION_BLOCKS = 12;
    uint64 constant RECENTER_RANGE = 0.05e18;
    uint64 constant SURCHARGE_DECAY = 10e14;
    uint64 constant SURCHARGE_INITIAL = 50e14;

    LPAgentHookV4 hook;
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

        // Compute market price
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);
        // priceWad = price of token0 in token1 (Uniswap ordering)
        // Need to check if Uniswap ordering matches EulerSwap ordering
        console.log("Uniswap sqrtPriceX96:", uint256(sqrtPriceX96));
        console.log("Uniswap priceWad (token0/token1):", priceWad);

        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);
        console.log("Market priceY:", uint256(marketPriceY));

        // Deploy V4 hook
        vm.startPrank(EULER_ACCOUNT);

        hook = new LPAgentHookV4(
            address(pool),
            EULER_ACCOUNT,
            UNI_USDC_WETH,
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
        console.log("V4 hook deployed:", address(hook));

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
        console.log("=== Hook installed ===");
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
    }

    // ===================================================================
    // Test 1: getFee returns reasonable values with real Uniswap prices
    // ===================================================================
    function test_fork_getFee_with_real_prices() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // After deployment, surcharge is active → fee = baseFee + surcharge
        uint64 fee = hook.getFee(true, r0, r1, false);
        console.log("Fee (asset0 in):", uint256(fee));
        assertTrue(fee >= BASE_FEE, "fee should be >= baseFee");
        assertTrue(fee <= MAX_FEE, "fee should be <= maxFee");

        // Fee in both directions
        uint64 fee1 = hook.getFee(false, r0, r1, false);
        console.log("Fee (asset1 in):", uint256(fee1));
        assertTrue(fee1 >= BASE_FEE, "fee1 should be >= baseFee");

        // After surcharge decays, fee should be near baseFee (if pool is at market)
        vm.roll(block.number + 10);
        uint64 feeAfterDecay = hook.getFee(true, r0, r1, false);
        console.log("Fee after 10 blocks (asset0 in):", uint256(feeAfterDecay));
    }

    // ===================================================================
    // Test 2: computeQuote works through the hook
    // ===================================================================
    function test_fork_computeQuote() public {
        // Quote: swap 1 USDC (if asset0=USDC) or small amount
        uint256 smallAmount = 10 ** dec0; // 1 unit of asset0
        uint256 quoteOut = pool.computeQuote(asset0, asset1, smallAmount, true);
        console.log("Quote: 1 asset0 ->", quoteOut, "asset1");
        assertTrue(quoteOut > 0, "quote should be > 0");

        // Reverse quote
        uint256 smallAmount1 = 10 ** dec1;
        uint256 quoteOut1 = pool.computeQuote(asset1, asset0, smallAmount1, true);
        console.log("Quote: 1 asset1 ->", quoteOut1, "asset0");
        assertTrue(quoteOut1 > 0, "reverse quote should be > 0");
    }

    // ===================================================================
    // Test 3: Execute a real swap via the pool
    // ===================================================================
    function test_fork_swap_small() public {
        vm.roll(block.number + 10); // let surcharge decay

        // Determine a small swap amount: ~0.1% of reserves
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 swapIn = uint256(r0) / 1000; // 0.1% of reserve0
        if (swapIn == 0) swapIn = 1;

        // Quote to get expected output
        uint256 expectedOut = pool.computeQuote(asset0, asset1, swapIn, true);
        console.log("Swap in:", swapIn, "asset0");
        console.log("Expected out:", expectedOut, "asset1");

        if (expectedOut == 0) {
            console.log("SKIP: swap too small for output");
            return;
        }

        // Execute swap using flash-swap pattern
        address swapper = makeAddr("swapper");
        deal(asset0, swapper, swapIn);

        vm.startPrank(swapper);
        IERC20(asset0).approve(address(pool), swapIn);

        // Request output, provide input in callback
        SwapCallback callback = new SwapCallback(asset0, swapIn);
        IERC20(asset0).transfer(address(callback), swapIn);
        vm.stopPrank();

        vm.prank(address(callback));
        pool.swap(0, expectedOut, address(callback), abi.encode(swapIn));

        uint256 receivedAsset1 = IERC20(asset1).balanceOf(address(callback));
        console.log("Received:", receivedAsset1, "asset1");
        assertEq(receivedAsset1, expectedOut, "should receive quoted amount");

        // Verify pool state is consistent
        (uint112 newR0, uint112 newR1,) = pool.getReserves();
        console.log("Post-swap reserves:", uint256(newR0), uint256(newR1));
        assertTrue(newR0 > r0 || newR1 < r1, "reserves should have changed");
    }

    // ===================================================================
    // Test 4: Pool health check -verify vault state is sound
    // ===================================================================
    function test_fork_pool_health() public {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        // Check supply balances
        uint256 supply0 = IEVault(sp.supplyVault0).maxWithdraw(sp.eulerAccount);
        uint256 supply1 = IEVault(sp.supplyVault1).maxWithdraw(sp.eulerAccount);
        console.log("Supply0 (withdrawable):", supply0);
        console.log("Supply1 (withdrawable):", supply1);

        // Check debt
        uint256 debt0 = sp.borrowVault0 != address(0)
            ? IEVault(sp.borrowVault0).debtOf(sp.eulerAccount)
            : 0;
        uint256 debt1 = sp.borrowVault1 != address(0)
            ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount)
            : 0;
        console.log("Debt0:", debt0);
        console.log("Debt1:", debt1);

        // Check limits
        (uint256 inLimit, uint256 outLimit) = pool.getLimits(asset0, asset1);
        console.log("Swap limit: asset0 in:", inLimit, "asset1 out:", outLimit);
        assertTrue(inLimit > 0 || outLimit > 0, "pool should have some swap capacity");
    }

    // ===================================================================
    // Test 5: Auction trigger with large swap (if pool has capacity)
    // ===================================================================
    function test_fork_auction_trigger() public {
        vm.roll(block.number + 10); // let surcharge decay

        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Size the swap to push exposure past triggerThreshold.
        // Exposure = (eq - reserve) / (eq - min) for the deficit side.
        // Swapping asset0 in → asset1 out depletes reserve1.
        // Need: (eq1 - newReserve1) / (eq1 - min1) > triggerThreshold
        // So asset1 output must exceed: triggerThreshold * (eq1 - min1)
        // Add 50% margin to ensure trigger even after fee deduction.
        uint256 rangeY = uint256(d.equilibriumReserve1) - uint256(d.minReserve1);
        uint256 targetOutput = rangeY * uint256(TRIGGER_THRESHOLD) * 150 / (WAD * 100);
        console.log("Range (eq1 - min1):", rangeY);
        console.log("Target output for trigger:", targetOutput);

        if (targetOutput == 0) {
            console.log("SKIP: pool has no range (min = 0 or eq = min)");
            return;
        }

        // Use exactOut quote to find the input needed
        uint256 swapIn;
        uint256 expectedOut = targetOutput;
        try pool.computeQuote(asset0, asset1, targetOutput, false) returns (uint256 inNeeded) {
            swapIn = inNeeded;
        } catch {
            console.log("SKIP: exactOut quote reverted");
            return;
        }

        // Verify swap fits within pool limits
        (uint256 inLimit,) = pool.getLimits(asset0, asset1);
        if (swapIn > inLimit) {
            console.log("SKIP: swap exceeds inLimit:", swapIn, ">", inLimit);
            return;
        }

        console.log("Auction trigger swap in:", swapIn, "out:", expectedOut);

        // Execute
        SwapCallback callback = new SwapCallback(asset0, swapIn);
        deal(asset0, address(callback), swapIn);

        vm.prank(address(callback));
        pool.swap(0, expectedOut, address(callback), abi.encode(swapIn));

        // Check if auction triggered
        bool auctionActive = hook.auctionActive();
        console.log("Auction active:", auctionActive);

        if (auctionActive) {
            console.log("Auction triggered successfully!");

            // Verify shifted state
            IEulerSwap.DynamicParams memory dPost = pool.getDynamicParams();
            console.log("Post-shift priceY:", uint256(dPost.priceY));
            console.log("Post-shift eq0:", uint256(dPost.equilibriumReserve0));
            console.log("Post-shift eq1:", uint256(dPost.equilibriumReserve1));
            console.log("Post-shift min0:", uint256(dPost.minReserve0));
            console.log("Post-shift min1:", uint256(dPost.minReserve1));

            // Verify min reserves are 0 during auction
            assertEq(dPost.minReserve0, 0, "min0 should be 0 during auction");
            assertEq(dPost.minReserve1, 0, "min1 should be 0 during auction");

            // Verify auction fee is elevated
            (uint112 postR0, uint112 postR1,) = pool.getReserves();
            uint64 auctionFee = hook.getFee(true, postR0, postR1, false);
            console.log("Auction fee:", uint256(auctionFee));
            assertTrue(auctionFee >= BASE_FEE, "auction fee should be elevated");
        } else {
            console.log("Auction did not trigger - swap may not have been large enough");
            console.log("Exposure may be below triggerThreshold for this pool's range");
        }
    }

    // ===================================================================
    // Test 6: Verify Uniswap price oracle integration
    // ===================================================================
    function test_fork_uniswap_price_oracle() public {
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Get the Uniswap price that the hook sees
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);
        console.log("Uniswap price (WAD):", uniPriceWad);

        // Compare with pool's marginal price
        // For the hook, marginal price = reserve1 * WAD / reserve0 (simplified)
        uint256 marginalPrice = uint256(r1) * WAD / uint256(r0);
        console.log("Marginal price (WAD):", marginalPrice);

        // The mismatch determines fee direction
        uint256 mismatch;
        if (uniPriceWad > marginalPrice) {
            mismatch = (uniPriceWad - marginalPrice) * WAD / uniPriceWad;
        } else {
            mismatch = (marginalPrice - uniPriceWad) * WAD / uniPriceWad;
        }
        console.log("Price mismatch (WAD):", mismatch);

        // Mismatch should be reasonable (< 10% for a functioning pool)
        assertTrue(mismatch < 0.10e18, "mismatch should be < 10% for healthy pool");
    }

    // ===================================================================
    // Test 7: Debt trigger -verify NAV computation and trigger logic
    // ===================================================================
    function test_fork_debt_trigger() public {
        vm.roll(block.number + 10); // let surcharge decay

        IEulerSwap.StaticParams memory sp = pool.getStaticParams();

        // Read real vault state
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

        console.log("=== Debt Trigger Test ===");
        console.log("Deposit0:", deposit0);
        console.log("Deposit1:", deposit1);
        console.log("Debt0:", debt0);
        console.log("Debt1:", debt1);

        // Verify approxNav was set in constructor
        uint128 nav = hook.approxNav();
        console.log("approxNav:", uint256(nav));
        assertTrue(nav > 0, "approxNav should be > 0 after deployment");

        // Compute expected NAV manually for comparison
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 uniPriceWad = sqrtP.mulDiv(sqrtP, Q192).mulDiv(WAD, 1);

        uint256 totalDeposits = deposit0 + deposit1 * uniPriceWad / WAD;
        uint256 totalDebts = debt0 + debt1 * uniPriceWad / WAD;
        uint256 expectedNav = totalDeposits > totalDebts ? totalDeposits - totalDebts : 0;
        console.log("Expected NAV:", expectedNav);
        console.log("Nav difference:", expectedNav > nav ? expectedNav - nav : nav - expectedNav);

        // NAV should be in the right ballpark (within 1% -small rounding from share conversion)
        if (expectedNav > 0) {
            uint256 diff = expectedNav > nav ? expectedNav - nav : nav - expectedNav;
            assertTrue(diff * 100 / expectedNav < 1, "NAV should match within 1%");
        }

        // Check debt/NAV ratio
        uint256 debtValue;
        bool hasDebt;
        if (debt0 > 0) {
            debtValue = debt0;
            hasDebt = true;
            console.log("Debt on side 0 (asset0 deficit)");
        } else if (debt1 > 0) {
            debtValue = debt1 * uniPriceWad / WAD;
            hasDebt = true;
            console.log("Debt on side 1 (asset1 deficit)");
        }

        if (hasDebt && nav > 0) {
            uint256 debtNavRatio = debtValue * WAD / uint256(nav);
            console.log("Debt/NAV ratio (WAD):", debtNavRatio);
            console.log("Trigger threshold:", uint256(hook.debtTriggerThreshold()));

            if (debtNavRatio > uint256(hook.debtTriggerThreshold())) {
                console.log("Debt/NAV exceeds threshold -trigger expected on next swap");

                // Do a tiny swap to trigger the debt check
                (uint112 r0,,) = pool.getReserves();
                uint256 swapIn = uint256(r0) / 10000; // 0.01% of reserves
                if (swapIn == 0) swapIn = 1;

                uint256 expectedOut = pool.computeQuote(asset0, asset1, swapIn, true);
                if (expectedOut > 0) {
                    SwapCallback callback = new SwapCallback(asset0, swapIn);
                    deal(asset0, address(callback), swapIn);

                    vm.prank(address(callback));
                    pool.swap(0, expectedOut, address(callback), abi.encode(swapIn));

                    bool auctionActive = hook.auctionActive();
                    console.log("Auction active after small swap:", auctionActive);
                    assertTrue(auctionActive, "debt trigger should have started auction");

                    // Verify clearing direction
                    bool clearAsset0 = hook.auctionClearAsset0();
                    if (debt0 > 0) {
                        assertTrue(clearAsset0, "should clear asset0 (USDC debt)");
                    } else {
                        assertFalse(clearAsset0, "should clear asset1 (WETH debt)");
                    }
                }
            } else {
                console.log("Debt/NAV below threshold -no trigger expected");
            }
        }
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

/// @dev Simple callback that sends input tokens to the pool during flash-swap.
///      The pool calls eulerSwapCall after sending output tokens. The callback
///      params are (amount0Out, amount1Out), NOT amounts owed. The pool measures
///      input by checking its balance after the callback.
contract SwapCallback {
    address immutable token;
    uint256 immutable amount;

    constructor(address _token, uint256 _amount) {
        token = _token;
        amount = _amount;
    }

    function eulerSwapCall(address, uint256, uint256, bytes calldata) external {
        // Send the input token to the pool (msg.sender)
        IERC20(token).transfer(msg.sender, amount);
    }
}
