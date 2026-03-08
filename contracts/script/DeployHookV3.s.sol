// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHookV3} from "../src/LPAgentHookV3.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {FullMath} from "../eulerswap/src/math/FullMath.sol";

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @title DeployHookV3 — Deploy LPAgentHookV3 and install on USDC/WETH pool
/// @notice Deploys V3 hook (exposure-based rebalancing), computes NAV from vault state,
///         sets auction params, and reconfigures pool with market priceY + range floors.
///
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/DeployHookV3.s.sol:DeployHookV3 \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract DeployHookV3 is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant UNI_USDC_WETH = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    uint256 constant Q192 = 1 << 192;
    uint256 constant WAD = 1e18;

    /// @dev Min reserve ratio: ~2.4% below eq (5% price range: 1 - 1/sqrt(1.05))
    uint256 constant MIN_RESERVE_BPS = 9759;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);

        // Read current state
        IEulerSwap.StaticParams memory sp = pool.getStaticParams();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        // Compute market priceY from Uniswap
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(UNI_USDC_WETH).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        uint80 marketPriceY = uint80(uint256(d.priceX) * WAD / priceWad);

        // Compute NAV from vault state
        uint112 computedNAV = _computeNAV(sp, d);

        console.log("Deployer:", deployer);
        console.log("Reserves:", uint256(r0), uint256(r1));
        console.log("Market priceY:", uint256(marketPriceY));
        console.log("NAV (USDC raw):", uint256(computedNAV));
        console.log("NAV (USDC):", uint256(computedNAV) / 1e6);

        vm.startBroadcast(pk);

        // 1. Deploy LPAgentHookV3
        LPAgentHookV3 hook = new LPAgentHookV3(
            POOL,
            deployer,
            UNI_USDC_WETH,
            5e14,            // baseFee: 5 bps
            3500e14,         // maxFee: 3500 bps
            uint64(6.54e10), // gasCoeff
            5e14,            // externalFee: 5 bps (Uni V3 0.05%)
            0.8e18,          // captureRate: 80%
            0.3e18           // attractRate: 30%
        );
        console.log("V3 hook deployed:", address(hook));

        // 2. Set auction params (exposure-based)
        hook.setAuctionParams(
            computedNAV,        // nav: LP equity in USDC terms
            5000,               // triggerBps: 50% of NAV
            uint64(100e14),     // delta: 100 bps
            uint64(200e14),     // startFee: 200 bps
            uint64(1e14)        // decayPerSecond: 1 bps/sec
        );
        console.log("Auction params set: NAV=", uint256(computedNAV), "triggerBps=5000");

        // 3. Reconfigure pool with V3 hook
        (r0, r1,) = pool.getReserves();

        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = r0;
        d.equilibriumReserve1 = r1;
        d.minReserve0 = uint112(uint256(r0) * MIN_RESERVE_BPS / 10000);
        d.minReserve1 = uint112(uint256(r1) * MIN_RESERVE_BPS / 10000);

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with V3 hook");

        vm.stopBroadcast();

        // Verify
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook:", finalD.swapHook);
        console.log("HookedOps:", uint256(finalD.swapHookedOperations));
        console.log("priceY:", uint256(finalD.priceY));
        console.log("eq0:", uint256(finalD.equilibriumReserve0));
        console.log("eq1:", uint256(finalD.equilibriumReserve1));
        console.log("min0:", uint256(finalD.minReserve0));
        console.log("min1:", uint256(finalD.minReserve1));
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));
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
}
