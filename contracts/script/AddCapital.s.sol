// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title AddCapital — Deposit an asset into its EVault and proportionally scale a pool
/// @notice Deposits AMOUNT of ASSET into ASSET_VAULT via the EVC, then reconfigures POOL
///         (equilibrium reserves, min reserves, and current reserves) proportionally so the
///         price and range are preserved as equity grows.
///
/// @dev Usage (env-driven):
///   PRIVATE_KEY=0x...                                          \
///   AMOUNT=1000000                                             \
///   ASSET=0x...                                                \
///   POOL=0x...           # optional, defaults to USDC/WETH pool \
///   EULER_ACCOUNT=0x...  # optional                            \
///     forge script script/AddCapital.s.sol:AddCapital \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
/// AMOUNT is required and is denominated in the asset's smallest unit (e.g. 6 decimals for
/// USDC). ASSET is one of the two pool assets (whichever you want to add capital in); the
/// script picks the matching supply vault from the pool's static params. Reserves scale
/// around whichever side ASSET is (token0 or token1).
contract AddCapital is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Author defaults (USDC/WETH pool) ---
    address constant DEFAULT_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant DEFAULT_EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;

    struct Cfg {
        address pool;
        address eulerAccount;
        address assetVault;
        address asset;
        uint256 amount;
        bool assetIsToken0;
    }

    struct Scaled {
        uint112 eq0;
        uint112 eq1;
        uint112 min0;
        uint112 min1;
        uint112 r0;
        uint112 r1;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Cfg memory cfg = _readCfg();

        _logCfg(cfg, vm.addr(pk));
        Scaled memory s = _computeScaled(cfg);
        _logScaled(s);

        vm.startBroadcast(pk);
        _depositAndReconfigure(cfg, s, vm.addr(pk));
        vm.stopBroadcast();

        (uint112 finalR0, uint112 finalR1,) = EulerSwap(cfg.pool).getReserves();
        console.log("Final reserves:", uint256(finalR0), uint256(finalR1));
        console.log("Done!");
    }

    function _readCfg() internal view returns (Cfg memory cfg) {
        cfg.pool = vm.envOr("POOL", DEFAULT_POOL);
        cfg.eulerAccount = vm.envOr("EULER_ACCOUNT", DEFAULT_EULER_ACCOUNT);
        cfg.amount = vm.envUint("AMOUNT"); // required, no default
        require(cfg.amount > 0, "AMOUNT must be > 0");

        // Auto-detect ASSET_VAULT from POOL: look up the pool's two supply vaults,
        // read each underlying asset, and pick whichever matches ASSET. Removes the
        // wrong-default footgun where ASSET_VAULT silently mismatches POOL.
        IEulerSwap.StaticParams memory sp = EulerSwap(cfg.pool).getStaticParams();
        address asset0 = IEVault(sp.supplyVault0).asset();
        address asset1 = IEVault(sp.supplyVault1).asset();

        address asset = vm.envOr("ASSET", address(0));
        if (asset == address(0)) {
            console.log("ASSET env var not set. Pool assets are:");
            console.log("  token0:", asset0, "(supplyVault0:", sp.supplyVault0);
            console.log("  token1:", asset1, "(supplyVault1:", sp.supplyVault1);
            revert("ASSET must be set to one of the pool's two assets");
        }

        if (asset == asset0) {
            cfg.asset = asset0;
            cfg.assetVault = sp.supplyVault0;
            cfg.assetIsToken0 = true;
        } else if (asset == asset1) {
            cfg.asset = asset1;
            cfg.assetVault = sp.supplyVault1;
            cfg.assetIsToken0 = false;
        } else {
            console.log("ASSET", asset, "does not match either pool asset:");
            console.log("  token0:", asset0);
            console.log("  token1:", asset1);
            revert("ASSET does not match pool's token0 or token1");
        }
    }

    function _logCfg(Cfg memory cfg, address deployer) internal view {
        console.log("=== AddCapital ===");
        console.log("Pool:           ", cfg.pool);
        console.log("Euler account:  ", cfg.eulerAccount);
        console.log("Asset vault:    ", cfg.assetVault);
        console.log("Asset:          ", cfg.asset);
        console.log("Deployer:       ", deployer);
        console.log("Deployer bal:   ", IERC20Min(cfg.asset).balanceOf(deployer));
        console.log("Amount to add:  ", cfg.amount);
        require(IERC20Min(cfg.asset).balanceOf(deployer) >= cfg.amount, "Insufficient asset balance");
    }

    function _computeScaled(Cfg memory cfg) internal view returns (Scaled memory s) {
        EulerSwap pool = EulerSwap(cfg.pool);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();

        console.log("Current reserves:", uint256(r0), uint256(r1));
        console.log("Current eq:", uint256(d.equilibriumReserve0), uint256(d.equilibriumReserve1));

        // Scale factor: (eqSide + amount) / eqSide where eqSide is the equilibrium
        // reserve of whichever side ASSET corresponds to. Scaling the opposite side
        // by the same ratio preserves the curve's price and range.
        uint256 eqSide = cfg.assetIsToken0 ? uint256(d.equilibriumReserve0) : uint256(d.equilibriumReserve1);
        uint256 ratio = (eqSide + cfg.amount) * 1e18 / eqSide;
        console.log("Scale ratio (1e18=1x):", ratio);

        if (cfg.assetIsToken0) {
            s.eq0 = uint112(uint256(d.equilibriumReserve0) + cfg.amount);
            s.eq1 = uint112(uint256(d.equilibriumReserve1) * ratio / 1e18);
        } else {
            s.eq0 = uint112(uint256(d.equilibriumReserve0) * ratio / 1e18);
            s.eq1 = uint112(uint256(d.equilibriumReserve1) + cfg.amount);
        }
        s.min0 = uint112(uint256(d.minReserve0) * ratio / 1e18);
        s.min1 = uint112(uint256(d.minReserve1) * ratio / 1e18);
        s.r0 = uint112(uint256(r0) * ratio / 1e18);
        s.r1 = uint112(uint256(r1) * ratio / 1e18);
    }

    function _logScaled(Scaled memory s) internal pure {
        console.log("New eq:", uint256(s.eq0), uint256(s.eq1));
        console.log("New min:", uint256(s.min0), uint256(s.min1));
        console.log("New reserves:", uint256(s.r0), uint256(s.r1));
    }

    function _depositAndReconfigure(Cfg memory cfg, Scaled memory s, address deployer) internal {
        IERC20Min(cfg.asset).approve(cfg.assetVault, cfg.amount);
        IEVault(cfg.assetVault).deposit(cfg.amount, deployer);
        console.log("Asset deposited to vault");

        IEulerSwap.DynamicParams memory d = EulerSwap(cfg.pool).getDynamicParams();
        d.equilibriumReserve0 = s.eq0;
        d.equilibriumReserve1 = s.eq1;
        d.minReserve0 = s.min0;
        d.minReserve1 = s.min1;

        evc.call(
            cfg.pool,
            cfg.eulerAccount,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: s.r0, reserve1: s.r1}))
            )
        );
        console.log("Pool reconfigured");
    }
}
