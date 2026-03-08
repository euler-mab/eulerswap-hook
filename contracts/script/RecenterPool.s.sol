// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
}

interface ILPAgentHookV3 {
    function nav() external view returns (uint112);
    function triggerBps() external view returns (uint64);
    function auctionDelta() external view returns (uint64);
    function auctionStartFee() external view returns (uint64);
    function auctionDecayPerSecond() external view returns (uint64);
    function setAuctionParams(uint112, uint64, uint64, uint64, uint64) external;
}

/// @title RecenterPool — Reusable pool recentering script
/// @notice Sets eq=reserves, priceY=market, minReserves=BOUNDARY_FACTOR for any EulerSwap pool.
///         Optionally updates V3 hook NAV from vault state.
///
/// @dev Env vars:
///   POOL          — EulerSwap pool address (required)
///   UNI_POOL      — Uniswap V3 pool for market price (required)
///   PRIVATE_KEY   — Deployer key, must be pool's eulerAccount (required)
///   UPDATE_NAV    — Set to "true" to also update V3 hook NAV (optional)
///
/// Usage:
///   POOL=0x... UNI_POOL=0x... PRIVATE_KEY=0x... forge script script/RecenterPool.s.sol:RecenterPool \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract RecenterPool is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    /// @dev 1 - 1/sqrt(1.05) ≈ 2.41% — gives ±5% price range
    uint256 constant MIN_RESERVE_BPS = 9759;

    function run() external {
        address poolAddr = vm.envAddress("POOL");
        address uniPool = vm.envAddress("UNI_POOL");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool updateNav = _envBool("UPDATE_NAV");

        EulerSwap pool = EulerSwap(poolAddr);
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Compute market priceY
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(uniPool).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Log current → new
        console.log("=== Recenter Pool ===");
        console.log("Pool:", poolAddr);
        console.log("");
        console.log("priceY:", uint256(d.priceY), "->", uint256(marketPriceY));
        console.log("eq0:   ", uint256(d.equilibriumReserve0), "->", uint256(r0));
        console.log("eq1:   ", uint256(d.equilibriumReserve1), "->", uint256(r1));
        console.log("min0:  ", uint256(d.minReserve0), "->", uint256(r0) * MIN_RESERVE_BPS / 10000);
        console.log("min1:  ", uint256(d.minReserve1), "->", uint256(r1) * MIN_RESERVE_BPS / 10000);

        vm.startBroadcast(pk);

        // Re-read reserves (may change between read and broadcast)
        (r0, r1,) = pool.getReserves();

        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;
        d.minReserve0 = uint112(uint256(r0) * MIN_RESERVE_BPS / 10000);
        d.minReserve1 = uint112(uint256(r1) * MIN_RESERVE_BPS / 10000);

        evc.call(
            poolAddr,
            sp.eulerAccount,
            0,
            abi.encodeCall(IEulerSwap.reconfigure, (d, IEulerSwap.InitialState(r0, r1)))
        );
        console.log("Pool recentered");

        // Optionally update V3 hook NAV
        if (updateNav && d.swapHook != address(0)) {
            uint112 newNav = _computeNAV(sp, d);
            ILPAgentHookV3 hook = ILPAgentHookV3(d.swapHook);

            console.log("NAV:", uint256(hook.nav()), "->", uint256(newNav));

            hook.setAuctionParams(
                newNav,
                hook.triggerBps(),
                hook.auctionDelta(),
                hook.auctionStartFee(),
                hook.auctionDecayPerSecond()
            );
            console.log("Hook NAV updated");
        }

        vm.stopBroadcast();

        // Verify
        IEulerSwap.DynamicParams memory f = pool.getDynamicParams();
        (uint112 fR0, uint112 fR1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("priceY:", uint256(f.priceY));
        console.log("eq0:", uint256(f.equilibriumReserve0));
        console.log("eq1:", uint256(f.equilibriumReserve1));
        console.log("min0:", uint256(f.minReserve0));
        console.log("min1:", uint256(f.minReserve1));
        console.log("Reserves:", uint256(fR0), uint256(fR1));
    }

    function _computeNAV(IEulerSwap.StaticParams memory sp, IEulerSwap.DynamicParams memory d)
        internal
        view
        returns (uint112)
    {
        uint256 supply0 = IEVault(sp.supplyVault0).maxWithdraw(sp.eulerAccount);
        uint256 supply1 = IEVault(sp.supplyVault1).maxWithdraw(sp.eulerAccount);
        uint256 debt0 =
            sp.borrowVault0 != address(0) ? IEVault(sp.borrowVault0).debtOf(sp.eulerAccount) : 0;
        uint256 debt1 =
            sp.borrowVault1 != address(0) ? IEVault(sp.borrowVault1).debtOf(sp.eulerAccount) : 0;

        uint256 px = uint256(d.priceX);
        uint256 py = uint256(d.priceY);
        uint256 supply1_in_0 = supply1 * px / py;
        uint256 debt1_in_0 = debt1 * px / py;

        uint256 totalAssets = supply0 + supply1_in_0;
        uint256 totalDebts = debt0 + debt1_in_0;
        require(totalAssets >= totalDebts, "Pool underwater");

        return uint112(totalAssets - totalDebts);
    }

    function _envBool(string memory key) internal view returns (bool) {
        string memory val = vm.envOr(key, string("false"));
        return keccak256(bytes(val)) == keccak256(bytes("true"));
    }
}
