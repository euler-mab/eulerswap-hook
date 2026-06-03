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
///   POOL=0x...           # optional, defaults to USDC/WETH pool \
///   EULER_ACCOUNT=0x...  # optional                            \
///   ASSET_VAULT=0x...    # optional                            \
///   ASSET=0x...          # optional                            \
///     forge script script/AddCapital.s.sol:AddCapital \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
/// AMOUNT is required and is denominated in the asset's smallest unit (e.g. 6 decimals for
/// USDC). The script assumes ASSET is token0 of POOL; reserves scale around token0.
contract AddCapital is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    // --- Author defaults (USDC/WETH pool) ---
    address constant DEFAULT_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant DEFAULT_EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant DEFAULT_ASSET_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant DEFAULT_ASSET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // USDC

    struct Cfg {
        address pool;
        address eulerAccount;
        address assetVault;
        address asset;
        uint256 amount;
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
        cfg.assetVault = vm.envOr("ASSET_VAULT", DEFAULT_ASSET_VAULT);
        cfg.asset = vm.envOr("ASSET", DEFAULT_ASSET);
        cfg.amount = vm.envUint("AMOUNT"); // required, no default
        require(cfg.amount > 0, "AMOUNT must be > 0");
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

        // Scale factor: (eq0 + amount) / eq0, in 1e18 fixed-point
        uint256 ratio = (uint256(d.equilibriumReserve0) + cfg.amount) * 1e18 / d.equilibriumReserve0;
        console.log("Scale ratio (1e18=1x):", ratio);

        s.eq0 = uint112(d.equilibriumReserve0 + cfg.amount);
        s.eq1 = uint112(uint256(d.equilibriumReserve1) * ratio / 1e18);
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
