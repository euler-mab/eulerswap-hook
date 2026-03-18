// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {console} from "forge-std/Test.sol";

/// @title WalkthroughBase
/// @notice Shared helpers for the auction-walkthrough testing library.
///
/// Design principles:
/// - Tests validate claims from docs/auction-walkthrough.md against real pool behavior
/// - No hook involved — these test the mathematical foundations the hook will build on
/// - Helpers are parameterised (eq, fee, concentration, feeRecipient) — no baked-in assumptions
/// - VaultState captures the full balance sheet for assertion
contract WalkthroughBase is EulerSwapTestBase {
    address swapper;
    address feeCollector;

    struct VaultState {
        uint256 deposits0;
        uint256 deposits1;
        uint256 debts0;
        uint256 debts1;
    }

    function setUp() public virtual override {
        super.setUp();
        swapper = makeAddr("swapper");
        feeCollector = makeAddr("feeCollector");
    }

    // ──── Pool creation helpers ────────────────────────────────────────

    /// @dev Create pool with configurable feeRecipient.
    function _createPool(
        uint112 eq0,
        uint112 eq1,
        uint64 fee,
        uint80 px,
        uint80 py,
        uint64 cx,
        uint64 cy,
        address _feeRecipient
    ) internal returns (EulerSwap pool, IEulerSwap.StaticParams memory sp) {
        (sp,) = getEulerSwapParams(eq0, eq1, px, py, cx, cy, fee, _feeRecipient);
        IEulerSwap.DynamicParams memory dp = IEulerSwap.DynamicParams({
            equilibriumReserve0: eq0,
            equilibriumReserve1: eq1,
            minReserve0: 0,
            minReserve1: 0,
            priceX: px,
            priceY: py,
            concentrationX: cx,
            concentrationY: cy,
            fee0: fee,
            fee1: fee,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: eq0, reserve1: eq1});
        pool = createEulerSwapFull(sp, dp, init);
    }

    /// @dev Create pool with custom min reserves.
    function _createPoolWithMinReserves(
        uint112 eq0,
        uint112 eq1,
        uint112 min0,
        uint112 min1,
        uint64 fee,
        uint80 px,
        uint80 py,
        uint64 cx,
        uint64 cy,
        address _feeRecipient
    ) internal returns (EulerSwap pool, IEulerSwap.StaticParams memory sp) {
        (sp,) = getEulerSwapParams(eq0, eq1, px, py, cx, cy, fee, _feeRecipient);
        IEulerSwap.DynamicParams memory dp = IEulerSwap.DynamicParams({
            equilibriumReserve0: eq0,
            equilibriumReserve1: eq1,
            minReserve0: min0,
            minReserve1: min1,
            priceX: px,
            priceY: py,
            concentrationX: cx,
            concentrationY: cy,
            fee0: fee,
            fee1: fee,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: eq0, reserve1: eq1});
        pool = createEulerSwapFull(sp, dp, init);
    }

    // ──── Vault state helpers ──────────────────────────────────────────

    function _readVault(IEulerSwap.StaticParams memory sp) internal view returns (VaultState memory v) {
        address account = sp.eulerAccount;
        uint256 s0 = IEVault(sp.supplyVault0).balanceOf(account);
        v.deposits0 = s0 == 0 ? 0 : IEVault(sp.supplyVault0).convertToAssets(s0);
        uint256 s1 = IEVault(sp.supplyVault1).balanceOf(account);
        v.deposits1 = s1 == 0 ? 0 : IEVault(sp.supplyVault1).convertToAssets(s1);
        v.debts0 = IEVault(sp.borrowVault0).debtOf(account);
        v.debts1 = IEVault(sp.borrowVault1).debtOf(account);
    }

    function _nav(VaultState memory v) internal pure returns (int256) {
        return int256(v.deposits0 + v.deposits1) - int256(v.debts0 + v.debts1);
    }

    function _logVault(string memory label, VaultState memory v) internal pure {
        console.log(label);
        console.log("  deposits0:", v.deposits0);
        console.log("  deposits1:", v.deposits1);
        console.log("  debts0:   ", v.debts0);
        console.log("  debts1:   ", v.debts1);
        console.log("  NAV:      ", uint256(_nav(v)));
    }

    // ──── Swap helpers ─────────────────────────────────────────────────

    /// @dev Execute a swap. asset0In=true means send asset0 in, receive asset1 out.
    function _doSwap(EulerSwap pool, bool asset0In, uint256 amount) internal returns (uint256 amountOut) {
        if (asset0In) {
            assetTST.mint(swapper, amount);
            vm.prank(swapper);
            assetTST.transfer(address(pool), amount);
            amountOut = pool.computeQuote(address(assetTST), address(assetTST2), amount, true);
            require(amountOut > 0, "quote zero");
            vm.prank(swapper);
            pool.swap(0, amountOut, swapper, "");
        } else {
            assetTST2.mint(swapper, amount);
            vm.prank(swapper);
            assetTST2.transfer(address(pool), amount);
            amountOut = pool.computeQuote(address(assetTST2), address(assetTST), amount, true);
            require(amountOut > 0, "quote zero");
            vm.prank(swapper);
            pool.swap(amountOut, 0, swapper, "");
        }
    }

    /// @dev Execute a swap given exact output amount desired.
    function _doSwapExactOut(EulerSwap pool, bool asset0In, uint256 exactOut) internal returns (uint256 amountIn) {
        if (asset0In) {
            amountIn = pool.computeQuote(address(assetTST), address(assetTST2), exactOut, false);
            assetTST.mint(swapper, amountIn);
            vm.prank(swapper);
            assetTST.transfer(address(pool), amountIn);
            vm.prank(swapper);
            pool.swap(0, exactOut, swapper, "");
        } else {
            amountIn = pool.computeQuote(address(assetTST2), address(assetTST), exactOut, false);
            assetTST2.mint(swapper, amountIn);
            vm.prank(swapper);
            assetTST2.transfer(address(pool), amountIn);
            vm.prank(swapper);
            pool.swap(exactOut, 0, swapper, "");
        }
    }

    // ──── Reconfigure helpers ──────────────────────────────────────────

    /// @dev Reconfigure pool with new dynamic params (called as eulerAccount).
    function _reconfigure(
        EulerSwap pool,
        IEulerSwap.DynamicParams memory dp,
        IEulerSwap.InitialState memory init
    ) internal {
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        vm.prank(sp.eulerAccount);
        IEVC(evc).call(
            address(pool),
            sp.eulerAccount,
            0,
            abi.encodeCall(IEulerSwap.reconfigure, (dp, init))
        );
    }

    /// @dev Reconfigure to constant-sum with current reserves as eq.
    ///      Sets min reserves to define clearing capacity.
    function _reconfigureToConstantSum(
        EulerSwap pool,
        uint112 minReserve0,
        uint112 minReserve1,
        uint80 px,
        uint80 py,
        uint64 fee
    ) internal {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory dp = IEulerSwap.DynamicParams({
            equilibriumReserve0: r0,
            equilibriumReserve1: r1,
            minReserve0: minReserve0,
            minReserve1: minReserve1,
            priceX: px,
            priceY: py,
            concentrationX: 1e18,
            concentrationY: 1e18,
            fee0: fee,
            fee1: fee,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
        IEulerSwap.InitialState memory init = IEulerSwap.InitialState({reserve0: r0, reserve1: r1});
        _reconfigure(pool, dp, init);
    }
}
