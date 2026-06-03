// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {MinimalHook} from "../src/MinimalHook.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

contract MinimalHookTest is EulerSwapTestBase {
    MinimalHook hook;
    EulerSwap pool;

    uint64 constant FEE_BPS_5 = 5e14; // 0.05% = 5 bps

    function setUp() public override {
        super.setUp();

        pool = createEulerSwap(10e18, 10e18, 0, 1e18, 1e18, 0.5e18, 0.5e18);

        hook = new MinimalHook(FEE_BPS_5);

        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE;

        IEulerSwap.InitialState memory initialState = IEulerSwap.InitialState({
            reserve0: dParams.equilibriumReserve0,
            reserve1: dParams.equilibriumReserve1
        });

        vm.prank(holder);
        IEVC(evc).call(address(pool), holder, 0, abi.encodeCall(IEulerSwap.reconfigure, (dParams, initialState)));
    }

    function test_getFee_returns_constant() public view {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        assertEq(hook.getFee(true, r0, r1, false), FEE_BPS_5);
        assertEq(hook.getFee(false, r0, r1, false), FEE_BPS_5);
    }

    function test_swap_uses_hook_fee() public {
        address swapper = makeAddr("swapper");
        assetTST.mint(swapper, 1e18);
        vm.prank(swapper);
        assetTST.transfer(address(pool), 1e18);

        uint256 quote = pool.computeQuote(address(assetTST), address(assetTST2), 1e18, true);
        vm.prank(swapper);
        pool.swap(0, quote, swapper, "");

        assertGt(assetTST2.balanceOf(swapper), 0, "swapper received quote asset");
    }

    function test_beforeSwap_reverts() public {
        vm.expectRevert("beforeSwap not enabled");
        hook.beforeSwap(0, 0, address(0), address(0));
    }

    function test_afterSwap_reverts() public {
        vm.expectRevert("afterSwap not enabled");
        hook.afterSwap(0, 0, 0, 0, 0, 0, address(0), address(0), 0, 0);
    }
}
