// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
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
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
}

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployHookV8Base — Abstract base for deploying LPAgentHookV8 on any pool
/// @notice Shared lifecycle: read pool state → deploy hook → reconfigure pool → verify.
///         Subclasses override virtual methods for pool-specific addresses/params.
abstract contract DeployHookV8Base is Script {
    using Sqrt for uint256;

    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    uint256 constant WAD = 1e18;
    uint256 constant Q192 = 1 << 192;

    // ─── Virtual: subclass provides pool-specific config ────────────────

    function _poolAddress() internal pure virtual returns (address);
    function _eulerAccount() internal pure virtual returns (address);
    function _oracleConfig() internal view virtual returns (LPAgentHookV8.OracleConfig memory);
    function _feeConfig() internal pure virtual returns (LPAgentHookV8.FeeConfig memory);
    function _auctionConfig() internal pure virtual returns (LPAgentHookV8.AuctionConfig memory);
    function _recenterRange() internal pure virtual returns (uint64);

    /// @notice Compute calibrated equilibrium reserves from equity.
    ///         Delta-neutral pools use eq = reserves. Stablecoin pools use additive boost.
    function _computeEquilibrium(
        IEulerSwap.DynamicParams memory d,
        uint256 xr,
        uint256 yr
    ) internal view virtual returns (uint112 eq0, uint112 eq1);

    /// @notice Read market priceY from the oracle source (V3 or V4).
    function _readMarketPrice(uint80 priceX) internal view virtual returns (uint80);

    /// @notice Compute min reserve from eq reserve and concentration.
    ///         Accounts for pool-specific concentration.
    function _computeMinReserve(uint112 eqReserve, uint64 concentration) internal view virtual returns (uint112) {
        uint256 r = uint256(_recenterRange());
        if (r == 0) return 0;

        uint256 c = uint256(concentration);
        if (c >= WAD) return 0;

        uint256 inner = WAD + r * WAD / (WAD - c);
        uint256 sqrtInner = (inner * WAD).sqrt();

        return uint112(uint256(eqReserve) * WAD / sqrtInner);
    }

    // ─── Shared lifecycle ──────────────────────────────────────────────

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(_poolAddress());
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        IEulerSwap.StaticParams memory s = pool.getStaticParams();

        // Read oracle price
        uint80 marketPriceY = _readMarketPrice(d.priceX);

        // Read equity
        (uint256 xr, uint256 yr) = _readEquity(s);

        // Compute calibrated reserves
        (uint112 eq0, uint112 eq1) = _computeEquilibrium(d, xr, yr);

        _logPreFlight(deployer, d, marketPriceY, xr, yr, eq0, eq1);

        vm.startBroadcast(pk);

        // 1. Deploy V8 hook
        LPAgentHookV8 hook = new LPAgentHookV8(
            _poolAddress(),
            deployer,
            _oracleConfig(),
            _feeConfig(),
            _auctionConfig()
        );
        console.log("V8 hook deployed:", address(hook));

        // 2. Reconfigure pool with hook + calibrated reserves
        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;
        d.priceY = marketPriceY;
        d.equilibriumReserve0 = eq0;
        d.equilibriumReserve1 = eq1;
        d.minReserve0 = _computeMinReserve(eq0, d.concentrationX);
        d.minReserve1 = _computeMinReserve(eq1, d.concentrationY);

        evc.call(
            _poolAddress(),
            _eulerAccount(),
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: eq0, reserve1: eq1}))
            )
        );
        console.log("Pool reconfigured with V8 hook");

        vm.stopBroadcast();

        // 3. Verify final state
        _logFinalState(pool, hook);
    }

    // ─── Shared helpers ────────────────────────────────────────────────

    function _readEquity(IEulerSwap.StaticParams memory s) internal view returns (uint256 xr, uint256 yr) {
        uint256 xShares = IEVault(s.supplyVault0).balanceOf(_eulerAccount());
        xr = IEVault(s.supplyVault0).convertToAssets(xShares);
        uint256 xd = IEVault(s.borrowVault0).debtOf(_eulerAccount());
        xr = xr > xd ? xr - xd : 0;

        uint256 yShares = IEVault(s.supplyVault1).balanceOf(_eulerAccount());
        yr = IEVault(s.supplyVault1).convertToAssets(yShares);
        uint256 yd = IEVault(s.borrowVault1).debtOf(_eulerAccount());
        yr = yr > yd ? yr - yd : 0;
    }

    /// @notice Read V3 sqrtPriceX96 and convert to priceY.
    function _readV3Price(address v3Pool, uint80 priceX) internal view returns (uint80) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(v3Pool).slot0();
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        return uint80(uint256(priceX) * WAD / priceWad);
    }

    /// @notice Read V4 sqrtPriceX96 from extsload and convert to priceY.
    function _readV4Price(address poolManager, bytes32 poolId, uint80 priceX) internal view returns (uint80) {
        bytes32 stateSlot = keccak256(abi.encode(poolId, bytes32(uint256(6))));
        bytes32 packed = IExtsload(poolManager).extsload(stateSlot);
        uint160 sqrtPriceX96 = uint160(uint256(packed));
        require(sqrtPriceX96 > 0, "V4 oracle returned zero price");

        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 priceWad = FullMath.mulDiv(sqrtP * sqrtP, WAD, Q192);
        return uint80(uint256(priceX) * WAD / priceWad);
    }

    // ─── Logging ───────────────────────────────────────────────────────

    function _logPreFlight(
        address deployer,
        IEulerSwap.DynamicParams memory d,
        uint80 marketPriceY,
        uint256 xr,
        uint256 yr,
        uint112 eq0,
        uint112 eq1
    ) internal view {
        console.log("=== DeployHookV8 ===");
        console.log("Pool:", _poolAddress());
        console.log("Deployer:", deployer);
        console.log("");
        console.log("--- Equity ---");
        console.log("asset0 equity:", xr);
        console.log("asset1 equity:", yr);
        console.log("");
        console.log("--- Calibrated reserves ---");
        console.log("eq0:", uint256(eq0));
        console.log("eq1:", uint256(eq1));
        console.log("min0:", uint256(_computeMinReserve(eq0, d.concentrationX)));
        console.log("min1:", uint256(_computeMinReserve(eq1, d.concentrationY)));
        console.log("");
        console.log("--- Current state ---");
        console.log("priceX:", uint256(d.priceX));
        console.log("priceY:", uint256(d.priceY), "-> market:", uint256(marketPriceY));
        console.log("Hook:", d.swapHook);
    }

    function _logFinalState(EulerSwap pool, LPAgentHookV8 hook) internal view {
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        (uint112 r0, uint112 r1,) = pool.getReserves();

        console.log("");
        console.log("=== Final state ===");
        console.log("Hook:", d.swapHook);
        console.log("HookedOps:", uint256(d.swapHookedOperations));
        console.log("priceY:", uint256(d.priceY));
        console.log("eq0:", uint256(d.equilibriumReserve0));
        console.log("eq1:", uint256(d.equilibriumReserve1));
        console.log("min0:", uint256(d.minReserve0));
        console.log("min1:", uint256(d.minReserve1));
        console.log("cx:", uint256(d.concentrationX));
        console.log("cy:", uint256(d.concentrationY));
        console.log("Reserves:", uint256(r0), uint256(r1));

        // V8-specific state
        (uint128 cachedNav, int256 w0) = hook.getDisplacementState();
        (uint112 trig0, uint112 trig1, uint64 snapBlock) = hook.getTriggerState();

        console.log("");
        console.log("=== V8 displacement state ===");
        console.log("cachedNav:", uint256(cachedNav));
        console.log("weightW0:", uint256(w0));
        console.log("triggerReserve0:", uint256(trig0));
        console.log("triggerReserve1:", uint256(trig1));
        console.log("lastSnapshotBlock:", uint256(snapBlock));
        console.log("savedConcentrationX:", uint256(hook.savedConcentrationX()));
        console.log("savedConcentrationY:", uint256(hook.savedConcentrationY()));

        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("HOOK_V8_ADDRESS=", vm.toString(address(hook))));
    }
}
