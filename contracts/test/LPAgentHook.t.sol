// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHook} from "../src/LPAgentHook.sol";
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

contract LPAgentHookTest is EulerSwapTestBase {
    using Sqrt for uint256;

    LPAgentHook hook;
    EulerSwap pool;
    MockUniswapV3Pool mockUniPool;

    uint64 constant BASE_FEE = 25e14; // 25 bps
    uint64 constant MAX_FEE = 100e14; // 100 bps
    uint256 constant MISMATCH_SCALE = 10e18; // 10x

    function setUp() public override {
        super.setUp();

        // 1. Create pool without hook (equal reserves, 1:1 price, c=0)
        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        // 2. Get asset addresses from pool
        IEulerSwap.StaticParams memory sParams = pool.getStaticParams();
        address asset0Addr = IEVault(sParams.supplyVault0).asset();
        address asset1Addr = IEVault(sParams.supplyVault1).asset();

        // 3. Deploy mock Uniswap pool with matching token ordering
        // Set 1:1 price: sqrtPriceX96 = 2^96
        mockUniPool = new MockUniswapV3Pool(
            asset0Addr, asset1Addr, uint160(1 << 96)
        );

        // 4. Deploy hook pointing at pool + mock Uniswap
        hook = new LPAgentHook(
            address(pool), address(this), address(mockUniPool),
            BASE_FEE, MAX_FEE, MISMATCH_SCALE
        );

        // 5. Reconfigure pool to install hook
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE;

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: dParams.equilibriumReserve0, reserve1: dParams.equilibriumReserve1});

        vm.prank(holder);
        IEVC(evc).call(
            address(pool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, initialState))
        );
    }

    // --- Helpers ---

    /// @dev Convert a WAD-scaled price to Uniswap V3 sqrtPriceX96
    /// Both tokens assumed 18 decimals (as in test setup)
    function _wadToSqrtPriceX96(uint256 priceWad) internal pure returns (uint160) {
        uint256 sqrtPriceWad = priceWad.sqrt(); // sqrt of WAD-scaled price
        return uint160(sqrtPriceWad * (1 << 96) / 1e9); // scale: 2^96 / sqrt(WAD)
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

    // --- getFee tests ---

    function test_getFee_baseFee_when_no_mismatch() public view {
        // Uniswap price = marginal price (both 1:1) → no mismatch → baseFee both directions
        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 fee0In = hook.getFee(true, r0, r1, false);
        uint64 fee1In = hook.getFee(false, r0, r1, false);

        assertApproxEqAbs(fee0In, BASE_FEE, 1e12, "fee0In should be ~baseFee");
        assertApproxEqAbs(fee1In, BASE_FEE, 1e12, "fee1In should be ~baseFee");
    }

    function test_getFee_elevated_on_arb_direction() public {
        // Set Uniswap price to 1.1 → pool underprices asset0
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.1e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false); // selling asset0 (counter-direction)
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false); // buying asset0 (arb direction)

        // Arb buys asset0 (asset1 in) → elevated
        assertTrue(feeAsset1In > BASE_FEE, "arb direction should exceed baseFee");
        // Counter-direction stays at baseFee
        assertEq(feeAsset0In, BASE_FEE, "counter-direction should be baseFee");
    }

    function test_getFee_counter_direction_always_baseFee() public {
        // Even with large mismatch, counter-direction never goes below baseFee
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.5e18)); // 50% mismatch

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Pool underprices asset0 → arb buys asset0 (asset1 in)
        // Counter = asset0 in
        uint64 counterFee = hook.getFee(true, r0, r1, false);
        assertEq(counterFee, BASE_FEE, "counter-direction must stay at baseFee");
    }

    function test_getFee_clamped_to_maxFee() public {
        // Large mismatch with large scale → clamped to maxFee
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(2e18)); // 100% mismatch

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false); // arb direction

        assertEq(fee, MAX_FEE, "fee should be clamped to maxFee");
    }

    function test_getFee_baseFee_when_uniswap_fails() public {
        // If Uniswap read reverts, fall back to baseFee
        mockUniPool.setShouldRevert(true);

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(true, r0, r1, false);

        assertEq(fee, BASE_FEE, "Uniswap failure should fallback to baseFee");
    }

    function test_getFee_baseFee_when_mismatchScale_zero() public {
        // With mismatchScale=0, all swaps pay baseFee regardless of price
        hook.setFeeParams(BASE_FEE, MAX_FEE, 0);
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.5e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint64 fee = hook.getFee(false, r0, r1, false);

        assertEq(fee, BASE_FEE, "mismatchScale=0 should always return baseFee");
    }

    function test_getFee_reversed_direction_when_uniswap_below_marginal() public {
        // Set Uniswap BELOW marginal: pool overprices asset0
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(0.9e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();

        uint64 feeAsset0In = hook.getFee(true, r0, r1, false);
        uint64 feeAsset1In = hook.getFee(false, r0, r1, false);

        // Uniswap < marginal → pool overprices asset0
        // Arb sells asset0 to us (asset0 in) → elevated
        // Counter = asset1 in → baseFee
        assertTrue(feeAsset0In > BASE_FEE, "arb direction (asset0In) should be elevated");
        assertEq(feeAsset1In, BASE_FEE, "counter-direction should be baseFee");
    }

    function test_getFee_exact_math() public {
        // baseFee=100bps, maxFee=1000bps, scale=0.5x (50% capture)
        hook.setFeeParams(100e14, 1000e14, 0.5e18);

        // 1% mismatch: Uniswap=1.01, marginal=1.0
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.01e18));

        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Expected: mismatch ≈ 0.99% ≈ 9900990099009900
        // scaledMismatch ≈ 0.5 * 0.99% ≈ 49.5 bps
        // Arb direction (asset1 in): 100bps + 49.5bps ≈ 149.5 bps
        // Counter direction (asset0 in): 100bps (unchanged)

        uint64 arbFee = hook.getFee(false, r0, r1, false);
        uint64 counterFee = hook.getFee(true, r0, r1, false);

        assertApproxEqAbs(arbFee, 149.5e14, 1e14, "arb side ~149.5 bps");
        assertEq(counterFee, 100e14, "counter side = baseFee");
    }

    // --- Access control tests ---

    function test_setFeeParams_onlyOwner() public {
        hook.setFeeParams(30e14, 200e14, 20e18);
        assertEq(hook.baseFee(), 30e14);

        vm.prank(makeAddr("random"));
        vm.expectRevert(LPAgentHook.Unauthorized.selector);
        hook.setFeeParams(30e14, 200e14, 20e18);
    }

    function test_setFeeParams_validates_ordering() public {
        // baseFee > maxFee should revert
        vm.expectRevert("invalid fee ordering");
        hook.setFeeParams(300e14, 200e14, 10e18);
    }

    function test_setFeeParams_rejects_maxFee_100_percent() public {
        vm.expectRevert("max fee >= 100%");
        hook.setFeeParams(25e14, uint64(1e18), 10e18);
    }

    // --- View helpers ---

    function test_getFeeParams() public view {
        (uint64 base, uint64 max, uint256 scale) = hook.getFeeParams();
        assertEq(base, BASE_FEE);
        assertEq(max, MAX_FEE);
        assertEq(scale, MISMATCH_SCALE);
    }

    // --- Swap integration ---

    function test_swap_uses_dynamic_fee() public {
        // Set Uniswap price to 1.05 → mismatch triggers elevated fee
        mockUniPool.setSqrtPriceX96(_wadToSqrtPriceX96(1.05e18));

        address swapper = makeAddr("swapper");
        _fundAndSwap(swapper, true, 1e18);
        _fundAndSwap(swapper, false, 1e18);
        // Swaps succeed without reverting — fee hook is active
    }

    // --- Event emission ---

    function test_setFeeParams_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit LPAgentHook.FeeParamsUpdated(30e14, 200e14, 20e18);
        hook.setFeeParams(30e14, 200e14, 20e18);
    }

    // --- Access control ---

    function test_afterSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.afterSwap(1e18, 0, 0, 1e18, 25e14, 0, address(0), address(0), 0, 0);
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("not implemented");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

}
