// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import {OneInchFusionResolver, LimitOrder} from "../src/OneInchFusionResolver.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

interface ILimitOrderProtocol {
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
    function fillOrderArgs(
        LimitOrder calldata order,
        bytes32 r,
        bytes32 vs,
        uint256 amount,
        uint256 takerTraits,
        bytes calldata args
    ) external payable returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash);
}

interface IEulerSwapPool {
    function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        external
        view
        returns (uint256);
}

/// @dev Fork test: deploys OneInchFusionResolver against mainnet EulerSwap pool and 1inch LOP V4
contract OneInchFusionResolverTest is Test {
    // Mainnet addresses
    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65; // 1inch Limit Order Protocol V4
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // EIP-712 typehash for LOP V4 Order (address types in the schema, uint256 in ABI)
    bytes32 constant ORDER_TYPEHASH = keccak256(
        "Order("
            "uint256 salt,"
            "address maker,"
            "address receiver,"
            "address makerAsset,"
            "address takerAsset,"
            "uint256 makingAmount,"
            "uint256 takingAmount,"
            "uint256 makerTraits"
        ")"
    );

    // MakerTraits flags
    uint256 constant NO_PARTIAL_FILLS_FLAG = 1 << 255;

    // TakerTraits flags
    uint256 constant MAKER_AMOUNT_FLAG = 1 << 255;
    uint256 constant INTERACTION_LENGTH_OFFSET = 200;

    OneInchFusionResolver resolver;

    function setUp() public {
        resolver = new OneInchFusionResolver(LOP);
        resolver.approveToken(USDC, LOP);
        resolver.approveToken(WETH, LOP);
    }

    // ---- Constructor & Access Control ----

    function test_constructor_sets_immutables() public view {
        assertEq(resolver.owner(), address(this));
        assertEq(resolver.limitOrderProtocol(), LOP);
    }

    function test_approveToken_setsAllowance() public view {
        assertEq(IERC20(USDC).allowance(address(resolver), LOP), type(uint256).max);
        assertEq(IERC20(WETH).allowance(address(resolver), LOP), type(uint256).max);
    }

    function test_approveToken_onlyOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.approveToken(USDC, LOP);
    }

    // ---- takerInteraction ----

    function test_takerInteraction_onlyLOP() public {
        vm.expectRevert(OneInchFusionResolver.OnlyLOP.selector);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), 0, 0, 0, _extraData(USDC, WETH, 0)
        );
    }

    function test_takerInteraction_notTaker() public {
        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.NotTaker.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            makeAddr("wrongTaker"), // not the resolver
            0,
            0,
            0,
            _extraData(USDC, WETH, 0)
        );
    }

    function test_takerInteraction_usdc_to_weth() public {
        // Simulate LOP transferring maker's USDC to resolver
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // takingAmount = WETH the LOP will pull from us (set to 0 for this unit test)
        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(USDC, WETH, 0)
        );

        uint256 wethBal = IERC20(WETH).balanceOf(address(resolver));
        assertTrue(wethBal > 0, "should have received WETH from EulerSwap");
        console.log("USDC->WETH: input=%d USDC, output=%d WETH (wei)", makerAmount / 1e6, wethBal);
    }

    function test_takerInteraction_weth_to_usdc() public {
        uint256 makerAmount = 0.5e18;
        deal(WETH, address(resolver), makerAmount);

        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(WETH, USDC, 0)
        );

        uint256 usdcBal = IERC20(USDC).balanceOf(address(resolver));
        assertTrue(usdcBal > 0, "should have received USDC from EulerSwap");
        console.log("WETH->USDC: input=0.5 WETH, output=%d USDC", usdcBal / 1e6);
    }

    function test_takerInteraction_minProfit_passes() public {
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // minProfit = 0, takingAmount = 0 → any output satisfies
        vm.prank(LOP);
        resolver.takerInteraction(
            _emptyOrder(), "", bytes32(0), address(resolver), makerAmount, 0, 0, _extraData(USDC, WETH, 0)
        );

        assertTrue(IERC20(WETH).balanceOf(address(resolver)) > 0);
    }

    function test_takerInteraction_minProfit_reverts() public {
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.InsufficientProfit.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            address(resolver),
            makerAmount,
            0, // takingAmount
            0,
            _extraData(USDC, WETH, type(uint256).max) // impossible minProfit
        );
    }

    function test_takerInteraction_takingAmount_check() public {
        // Verify that takingAmount is factored into the profit check
        uint256 makerAmount = 1000e6;
        deal(USDC, address(resolver), makerAmount);

        // Set takingAmount impossibly high → revert even with minProfit = 0
        vm.prank(LOP);
        vm.expectRevert(OneInchFusionResolver.InsufficientProfit.selector);
        resolver.takerInteraction(
            _emptyOrder(),
            "",
            bytes32(0),
            address(resolver),
            makerAmount,
            type(uint256).max, // impossibly high takingAmount
            0,
            _extraData(USDC, WETH, 0)
        );
    }

    // ---- settleOrders ----

    function test_settleOrders_onlyOwner() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.settleOrders("");
    }

    function test_settleOrders_bubbles_revert() public {
        // Calling LOP with garbage data should revert (bubbled from LOP)
        vm.expectRevert();
        resolver.settleOrders(hex"deadbeef");
    }

    // ---- Withdraw ----

    function test_withdraw_onlyOwner() public {
        deal(USDC, address(resolver), 1000e6);

        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(OneInchFusionResolver.Unauthorized.selector);
        resolver.withdraw(USDC, 1000e6, makeAddr("notOwner"));
    }

    function test_withdraw() public {
        deal(USDC, address(resolver), 1000e6);
        address recipient = makeAddr("recipient");

        resolver.withdraw(USDC, 500e6, recipient);
        assertEq(IERC20(USDC).balanceOf(recipient), 500e6);
        assertEq(IERC20(USDC).balanceOf(address(resolver)), 500e6);
    }

    function test_withdrawAll() public {
        deal(WETH, address(resolver), 1e18);
        address recipient = makeAddr("recipient");

        resolver.withdrawAll(WETH, recipient);
        assertEq(IERC20(WETH).balanceOf(recipient), 1e18);
        assertEq(IERC20(WETH).balanceOf(address(resolver)), 0);
    }

    // ---- End-to-End: create order, sign, fill via resolver ----

    /// @dev E2E: maker sells 1000 USDC for WETH, resolver fills via EulerSwap
    function test_e2e_fill_usdc_to_weth() public {
        (address maker, uint256 makerPk) = makeAddrAndKey("maker_usdc");

        // Fund maker and approve LOP
        deal(USDC, maker, 1000e6);
        vm.prank(maker);
        IERC20(USDC).approve(LOP, type(uint256).max);

        // Get EulerSwap quote to set a realistic takingAmount
        uint256 makingAmount = 1000e6;
        uint256 quoteOut = IEulerSwapPool(POOL).computeQuote(USDC, WETH, makingAmount, true);
        // Maker asks for 2% below market → resolver keeps the spread as profit
        uint256 takingAmount = quoteOut * 98 / 100;

        // Build order
        uint256 makerTraits = NO_PARTIAL_FILLS_FLAG | (uint256(block.timestamp + 1 hours) << 80) | (uint256(1) << 120);
        LimitOrder memory order = LimitOrder({
            salt: uint256(keccak256("e2e_usdc_weth")),
            maker: uint256(uint160(maker)),
            receiver: 0, // 0 = maker receives taker tokens
            makerAsset: uint256(uint160(USDC)),
            takerAsset: uint256(uint160(WETH)),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: makerTraits
        });

        // Sign (EIP-712)
        (bytes32 r, bytes32 vs) = _signOrder(order, makerPk);

        // Build fill calldata and execute
        bytes memory fillCalldata = _buildFillCalldata(order, r, vs, makingAmount, USDC, WETH);

        uint256 makerWethBefore = IERC20(WETH).balanceOf(maker);
        resolver.settleOrders(fillCalldata);

        // Verify maker received WETH
        uint256 makerWethReceived = IERC20(WETH).balanceOf(maker) - makerWethBefore;
        assertEq(makerWethReceived, takingAmount, "maker should receive exact takingAmount");
        assertEq(IERC20(USDC).balanceOf(maker), 0, "maker USDC should be fully spent");

        // Verify resolver kept profit
        uint256 resolverProfit = IERC20(WETH).balanceOf(address(resolver));
        assertTrue(resolverProfit > 0, "resolver should have WETH profit");
        assertEq(resolverProfit, quoteOut - takingAmount, "profit = quote - takingAmount");

        console.log("E2E USDC->WETH fill:");
        console.log("  Quote output: %d WETH (wei)", quoteOut);
        console.log("  Maker received: %d WETH (wei)", makerWethReceived);
        console.log("  Resolver profit: %d WETH (wei)", resolverProfit);
    }

    /// @dev E2E: maker sells 0.5 WETH for USDC, resolver fills via EulerSwap
    function test_e2e_fill_weth_to_usdc() public {
        (address maker, uint256 makerPk) = makeAddrAndKey("maker_weth");

        deal(WETH, maker, 0.5e18);
        vm.prank(maker);
        IERC20(WETH).approve(LOP, type(uint256).max);

        uint256 makingAmount = 0.5e18;
        uint256 quoteOut = IEulerSwapPool(POOL).computeQuote(WETH, USDC, makingAmount, true);
        uint256 takingAmount = quoteOut * 98 / 100;

        uint256 makerTraits = NO_PARTIAL_FILLS_FLAG | (uint256(block.timestamp + 1 hours) << 80) | (uint256(2) << 120);
        LimitOrder memory order = LimitOrder({
            salt: uint256(keccak256("e2e_weth_usdc")),
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(WETH)),
            takerAsset: uint256(uint160(USDC)),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: makerTraits
        });

        (bytes32 r, bytes32 vs) = _signOrder(order, makerPk);
        bytes memory fillCalldata = _buildFillCalldata(order, r, vs, makingAmount, WETH, USDC);

        uint256 makerUsdcBefore = IERC20(USDC).balanceOf(maker);
        resolver.settleOrders(fillCalldata);

        uint256 makerUsdcReceived = IERC20(USDC).balanceOf(maker) - makerUsdcBefore;
        assertEq(makerUsdcReceived, takingAmount, "maker should receive exact takingAmount");

        uint256 resolverProfit = IERC20(USDC).balanceOf(address(resolver));
        assertTrue(resolverProfit > 0, "resolver should have USDC profit");

        console.log("E2E WETH->USDC fill:");
        console.log("  Quote output: %d USDC", quoteOut / 1e6);
        console.log("  Maker received: %d USDC", makerUsdcReceived / 1e6);
        console.log("  Resolver profit: %d USDC", resolverProfit / 1e6);
    }

    /// @dev E2E: verify minProfit enforcement on a real fill
    function test_e2e_fill_with_minProfit_enforcement() public {
        (address maker, uint256 makerPk) = makeAddrAndKey("maker_profit");

        deal(USDC, maker, 1000e6);
        vm.prank(maker);
        IERC20(USDC).approve(LOP, type(uint256).max);

        uint256 makingAmount = 1000e6;
        uint256 quoteOut = IEulerSwapPool(POOL).computeQuote(USDC, WETH, makingAmount, true);
        // Maker asks for 2% below market
        uint256 takingAmount = quoteOut * 98 / 100;
        // But resolver demands impossibly high minProfit → should revert
        uint256 impossibleMinProfit = quoteOut; // more than total output

        uint256 makerTraits = NO_PARTIAL_FILLS_FLAG | (uint256(block.timestamp + 1 hours) << 80) | (uint256(3) << 120);
        LimitOrder memory order = LimitOrder({
            salt: uint256(keccak256("e2e_profit_check")),
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(USDC)),
            takerAsset: uint256(uint160(WETH)),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: makerTraits
        });

        (bytes32 r, bytes32 vs) = _signOrder(order, makerPk);

        // Build with high minProfit
        bytes memory extraData = abi.encode(POOL, USDC, WETH, impossibleMinProfit);
        bytes memory interaction = abi.encodePacked(address(resolver), extraData);
        bytes memory args = interaction;
        uint256 takerTraits = MAKER_AMOUNT_FLAG | (interaction.length << INTERACTION_LENGTH_OFFSET);

        bytes memory fillCalldata = abi.encodeCall(
            ILimitOrderProtocol.fillOrderArgs,
            (order, r, vs, makingAmount, takerTraits, args)
        );

        // Should revert because InsufficientProfit bubbles up through settleOrders
        vm.expectRevert();
        resolver.settleOrders(fillCalldata);
    }

    /// @dev E2E: expired order should be rejected by LOP
    function test_e2e_expired_order_reverts() public {
        (address maker, uint256 makerPk) = makeAddrAndKey("maker_expired");

        deal(USDC, maker, 1000e6);
        vm.prank(maker);
        IERC20(USDC).approve(LOP, type(uint256).max);

        uint256 makingAmount = 1000e6;
        uint256 takingAmount = 0.3e18;

        // Expiry in the past
        uint256 makerTraits = NO_PARTIAL_FILLS_FLAG | (uint256(block.timestamp - 1) << 80) | (uint256(4) << 120);
        LimitOrder memory order = LimitOrder({
            salt: uint256(keccak256("e2e_expired")),
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(USDC)),
            takerAsset: uint256(uint160(WETH)),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: makerTraits
        });

        (bytes32 r, bytes32 vs) = _signOrder(order, makerPk);
        bytes memory fillCalldata = _buildFillCalldata(order, r, vs, makingAmount, USDC, WETH);

        vm.expectRevert(); // LOP: OrderExpired
        resolver.settleOrders(fillCalldata);
    }

    // ---- Helpers ----

    function _signOrder(LimitOrder memory order, uint256 pk) internal view returns (bytes32 r, bytes32 vs) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.salt,
            order.maker,
            order.receiver,
            order.makerAsset,
            order.takerAsset,
            order.makingAmount,
            order.takingAmount,
            order.makerTraits
        ));

        // Build domain separator from eip712Domain() — LOP V4 uses "1inch Aggregation Router" v6
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            ILimitOrderProtocol(LOP).eip712Domain();
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)),
            keccak256(bytes(version)),
            chainId,
            verifyingContract
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, digest);
        r = rr;
        vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
    }

    function _buildFillCalldata(
        LimitOrder memory order,
        bytes32 r,
        bytes32 vs,
        uint256 fillAmount,
        address makerAsset,
        address takerAsset
    ) internal view returns (bytes memory) {
        bytes memory extraData = abi.encode(POOL, makerAsset, takerAsset, uint256(0));
        bytes memory interaction = abi.encodePacked(address(resolver), extraData);
        bytes memory args = interaction; // no extension, so args = interaction only
        uint256 takerTraits = MAKER_AMOUNT_FLAG | (interaction.length << INTERACTION_LENGTH_OFFSET);

        return abi.encodeCall(
            ILimitOrderProtocol.fillOrderArgs,
            (order, r, vs, fillAmount, takerTraits, args)
        );
    }

    function _extraData(address makerAsset, address takerAsset, uint256 minProfit)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(POOL, makerAsset, takerAsset, minProfit);
    }

    function _emptyOrder() internal pure returns (LimitOrder memory) {
        return LimitOrder({
            salt: 0,
            maker: 0,
            receiver: 0,
            makerAsset: 0,
            takerAsset: 0,
            makingAmount: 0,
            takingAmount: 0,
            makerTraits: 0
        });
    }
}
