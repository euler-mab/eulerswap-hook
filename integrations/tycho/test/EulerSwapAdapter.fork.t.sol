// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {EulerSwapAdapter} from "src/EulerSwapAdapter.sol";
import {ISwapAdapterTypes} from "src/interfaces/ISwapAdapterTypes.sol";
import {ISwapAdapter} from "src/interfaces/ISwapAdapter.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {AdapterTest} from "./AdapterTest.sol";

// ─── Constants shared across test contracts ─────────────────────────────────

address constant REGISTRY = 0x5FcCB84363F020c0cADE052C9c654aABF932814A;
address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
bytes32 constant POOL_ID = bytes32(bytes20(POOL));
address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

/// @title Fork tests for EulerSwap Tycho Adapter
/// @dev Run: cd integrations/tycho && forge test --fork-url $ETH_RPC_URL -vvv
contract EulerSwapAdapterForkTest is Test, ISwapAdapterTypes {
    EulerSwapAdapter adapter;

    function setUp() public {
        adapter = new EulerSwapAdapter(REGISTRY);
    }

    // ─── getTokens ───────────────────────────────────────────────────────

    function test_getTokens() public {
        address[] memory tokens = adapter.getTokens(POOL_ID);
        assertEq(tokens.length, 2, "should return 2 tokens");
        assertEq(tokens[0], USDC, "asset0 should be USDC");
        assertEq(tokens[1], WETH, "asset1 should be WETH");
    }

    // ─── getPoolIds ──────────────────────────────────────────────────────

    function test_getPoolIds() public {
        bytes32[] memory ids = adapter.getPoolIds(0, 10);
        assertTrue(ids.length > 0, "should return at least 1 pool");

        bool found = false;
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == POOL_ID) {
                found = true;
                break;
            }
        }
        assertTrue(found, "USDC/WETH pool should be in registry");
    }

    function test_getPoolIds_outOfRange() public {
        bytes32[] memory ids = adapter.getPoolIds(999999, 10);
        assertEq(ids.length, 0, "should return empty for out-of-range offset");
    }

    // ─── getCapabilities ─────────────────────────────────────────────────

    function test_getCapabilities() public {
        Capability[] memory caps = adapter.getCapabilities(POOL_ID, USDC, WETH);
        assertEq(caps.length, 5);
        assertEq(uint256(caps[0]), uint256(Capability.SellOrder));
        assertEq(uint256(caps[1]), uint256(Capability.BuyOrder));
        assertEq(uint256(caps[2]), uint256(Capability.PriceFunction));
        assertEq(uint256(caps[3]), uint256(Capability.MarginalPrice));
        assertEq(uint256(caps[4]), uint256(Capability.HardLimits));
    }

    // ─── getLimits ───────────────────────────────────────────────────────

    function test_getLimits_USDC_to_WETH() public {
        uint256[] memory limits = adapter.getLimits(POOL_ID, USDC, WETH);
        assertEq(limits.length, 2);
        assertTrue(limits[0] > 0, "sell limit should be > 0");
        assertTrue(limits[1] > 0, "buy limit should be > 0");
        console.log("USDC->WETH limits: sellMax=%d, buyMax=%d", limits[0], limits[1]);
    }

    function test_getLimits_WETH_to_USDC() public {
        uint256[] memory limits = adapter.getLimits(POOL_ID, WETH, USDC);
        assertEq(limits.length, 2);
        assertTrue(limits[0] > 0, "sell limit should be > 0");
        assertTrue(limits[1] > 0, "buy limit should be > 0");
        console.log("WETH->USDC limits: sellMax=%d, buyMax=%d", limits[0], limits[1]);
    }

    // ─── price ───────────────────────────────────────────────────────────

    function test_price_at_zero() public {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0;

        Fraction[] memory prices = adapter.price(POOL_ID, USDC, WETH, amounts);
        assertEq(prices.length, 1);
        assertTrue(prices[0].numerator > 0, "price numerator > 0");
        assertTrue(prices[0].denominator > 0, "price denominator > 0");

        console.log("Price USDC->WETH at 0: %d / %d", prices[0].numerator, prices[0].denominator);
    }

    function test_price_at_multiple_amounts() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 0;
        amounts[1] = 1000e6; // 1,000 USDC
        amounts[2] = 5000e6; // 5,000 USDC

        Fraction[] memory prices = adapter.price(POOL_ID, USDC, WETH, amounts);
        assertEq(prices.length, 3);

        // Price should decrease with size (more slippage)
        uint256 p0 = prices[0].numerator * prices[1].denominator;
        uint256 p1 = prices[1].numerator * prices[0].denominator;
        assertTrue(p0 >= p1, "price should decrease with amount (0 vs 1k)");

        uint256 p1b = prices[1].numerator * prices[2].denominator;
        uint256 p2 = prices[2].numerator * prices[1].denominator;
        assertTrue(p1b >= p2, "price should decrease with amount (1k vs 5k)");
    }

    function test_price_at_limit_graceful() public {
        uint256[] memory limits = adapter.getLimits(POOL_ID, USDC, WETH);
        uint256 sellLimit = limits[0];

        // Price at the exact sell limit should still work (not above)
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = sellLimit;

        Fraction[] memory prices = adapter.price(POOL_ID, USDC, WETH, amounts);
        assertEq(prices.length, 1, "should return 1 price");
        assertTrue(prices[0].denominator > 0, "denominator should never be 0");
    }

    function test_price_above_limit_reverts() public {
        uint256[] memory limits = adapter.getLimits(POOL_ID, USDC, WETH);
        uint256 sellLimit = limits[0];
        uint256 aboveLimit = sellLimit * 105 / 100;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = aboveLimit;

        // Adapter reports 99% of pool's raw limit; LimitExceeded carries our reported limit
        vm.expectRevert(abi.encodeWithSelector(LimitExceeded.selector, sellLimit));
        adapter.price(POOL_ID, USDC, WETH, amounts);
    }

    // ─── swap (sell) ─────────────────────────────────────────────────────

    function test_swap_sell_USDC_for_WETH() public {
        uint256 sellAmount = 1000e6; // 1,000 USDC

        deal(USDC, address(this), sellAmount);
        IERC20(USDC).approve(address(adapter), sellAmount);

        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        Trade memory trade = adapter.swap(POOL_ID, USDC, WETH, OrderSide.Sell, sellAmount);

        uint256 wethAfter = IERC20(WETH).balanceOf(address(this));

        assertTrue(trade.calculatedAmount > 0, "should receive WETH");
        assertEq(wethAfter - wethBefore, trade.calculatedAmount, "balance change should match");
        assertTrue(trade.gasUsed > 0, "gas should be tracked");

        // Post-swap price: real marginal if afterSwap didn't reconfigure, else Fraction(0,1)
        assertTrue(trade.price.denominator > 0, "post-swap price denominator > 0");

        console.log("Sold 1000 USDC, got %d WETH (wei)", trade.calculatedAmount);
        console.log("Gas used: %d", trade.gasUsed);
        console.log("Post-swap price: %d / %d", trade.price.numerator, trade.price.denominator);
    }

    function test_swap_sell_WETH_for_USDC() public {
        uint256 sellAmount = 0.5 ether; // 0.5 WETH

        deal(WETH, address(this), sellAmount);
        IERC20(WETH).approve(address(adapter), sellAmount);

        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));

        Trade memory trade = adapter.swap(POOL_ID, WETH, USDC, OrderSide.Sell, sellAmount);

        uint256 usdcAfter = IERC20(USDC).balanceOf(address(this));

        assertTrue(trade.calculatedAmount > 0, "should receive USDC");
        assertEq(usdcAfter - usdcBefore, trade.calculatedAmount, "balance change should match");

        console.log("Sold 0.5 WETH, got %d USDC", trade.calculatedAmount);
    }

    // ─── swap (buy) ──────────────────────────────────────────────────────

    function test_swap_buy_WETH_with_USDC() public {
        uint256 buyAmount = 0.1 ether; // buy exactly 0.1 WETH
        uint256 maxInput = 500e6; // max 500 USDC

        deal(USDC, address(this), maxInput);
        IERC20(USDC).approve(address(adapter), maxInput);

        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        Trade memory trade = adapter.swap(POOL_ID, USDC, WETH, OrderSide.Buy, buyAmount);

        uint256 usdcAfter = IERC20(USDC).balanceOf(address(this));
        uint256 wethAfter = IERC20(WETH).balanceOf(address(this));

        assertTrue(trade.calculatedAmount > 0, "should report USDC spent");
        assertEq(usdcBefore - usdcAfter, trade.calculatedAmount, "USDC spent should match");
        assertEq(wethAfter - wethBefore, buyAmount, "should receive exact buy amount");

        console.log("Bought 0.1 WETH, spent %d USDC", trade.calculatedAmount);
    }

    // ─── swap edge cases ─────────────────────────────────────────────────

    function test_swap_zero_amount() public {
        Trade memory trade = adapter.swap(POOL_ID, USDC, WETH, OrderSide.Sell, 0);
        assertEq(trade.calculatedAmount, 0, "zero input should yield zero output");
        assertEq(trade.price.denominator, 1, "zero-trade price denominator should be 1");
        assertEq(trade.price.numerator, 0, "zero-trade price numerator should be 0");
    }

    function test_swap_beyond_limit_reverts() public {
        uint256[] memory limits = adapter.getLimits(POOL_ID, USDC, WETH);
        uint256 sellLimit = limits[0];
        uint256 hugeAmount = sellLimit * 2;

        deal(USDC, address(this), hugeAmount);
        IERC20(USDC).approve(address(adapter), hugeAmount);

        vm.expectRevert(abi.encodeWithSelector(LimitExceeded.selector, sellLimit));
        adapter.swap(POOL_ID, USDC, WETH, OrderSide.Sell, hugeAmount);
    }
}

/// @title Standard Tycho AdapterTest harness for EulerSwap
/// @dev Runs runPoolBehaviourTest() — the standard test suite that all Tycho adapters must pass.
contract EulerSwapAdapterStandardTest is AdapterTest {
    function setUp() public {
        // Approvals are handled inside runPoolBehaviourTest via forceApprove
    }

    function test_runPoolBehaviourTest() public {
        EulerSwapAdapter adapter = new EulerSwapAdapter(REGISTRY);

        bytes32[] memory poolIds = new bytes32[](1);
        poolIds[0] = POOL_ID;

        runPoolBehaviourTest(ISwapAdapter(address(adapter)), poolIds);
    }
}
