// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {DynamicFeeAuctionHook} from "../src/DynamicFeeAuctionHook.sol";
import {EULER_SWAP_HOOK_GET_FEE, EULER_SWAP_HOOK_AFTER_SWAP} from
    "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";

/// @title DeployHook — Generic env-driven deploy for DynamicFeeAuctionHook
/// @notice Deploys a DynamicFeeAuctionHook with the supplied oracle / fee / auction
///         parameters and installs it on an existing EulerSwap pool via the EVC.
///
/// @dev Usage:
///   PRIVATE_KEY=0x...                                    \
///   POOL=0x...                                           \
///   EULER_ACCOUNT=0x...                                  \
///   ORACLE_TARGET=0x...                                  \
///   ORACLE_V4_POOL_ID=0x0000...                          \   # bytes32(0) -> V3 mode
///   ORACLE_TOKEN0=0x...                                  \   # token0 of the oracle pool
///   BASE_FEE=...           MAX_FEE=...                   \
///   GAS_COEFF=...          EXTERNAL_FEE=...              \
///   CAPTURE_RATE=...       ATTRACT_RATE=...              \
///   DECAY_PER_BLOCK=...    AUCTION_TRIGGER_THRESHOLD=... \
///   CLEAR_THRESHOLD=...    MAX_SHIFT_MAGNITUDE=...       \
///   MIN_AUCTION_BLOCKS=... RECENTER_RANGE=...            \
///   MAX_RECENTER_DRIFT=... MIN_RECENTER_DELTA=...        \
///   SURCHARGE_DECAY_PER_BLOCK=... SURCHARGE_MULTIPLIER=... \
///   DEPLOY_SURCHARGE=...                                 \
///     forge script script/DeployHook.s.sol:DeployHook \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   All fee/auction values are WAD-scaled (1e18 = 100%). Examples:
///     5e14   = 5 bps     5e15   = 50 bps     1e16   = 1%
///   ORACLE_V4_POOL_ID = bytes32(0) selects Uniswap V3 mode (slot0 read);
///   any non-zero value selects V4 mode (PoolManager extsload).
///   The deployer must be the pool's eulerAccount (or an authorized operator).
contract DeployHook is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address pool = vm.envAddress("POOL");
        address eulerAccount = vm.envAddress("EULER_ACCOUNT");

        DynamicFeeAuctionHook.OracleConfig memory oracleCfg = DynamicFeeAuctionHook.OracleConfig({
            target: vm.envAddress("ORACLE_TARGET"),
            v4PoolId: vm.envOr("ORACLE_V4_POOL_ID", bytes32(0)),
            token0: vm.envAddress("ORACLE_TOKEN0")
        });

        DynamicFeeAuctionHook.FeeConfig memory feeCfg = DynamicFeeAuctionHook.FeeConfig({
            baseFee: uint64(vm.envUint("BASE_FEE")),
            maxFee: uint64(vm.envUint("MAX_FEE")),
            gasCoeff: uint64(vm.envUint("GAS_COEFF")),
            externalFee: uint64(vm.envUint("EXTERNAL_FEE")),
            captureRate: vm.envUint("CAPTURE_RATE"),
            attractRate: vm.envUint("ATTRACT_RATE")
        });

        DynamicFeeAuctionHook.AuctionConfig memory auctionCfg = DynamicFeeAuctionHook.AuctionConfig({
            decayPerBlock: uint64(vm.envUint("DECAY_PER_BLOCK")),
            auctionTriggerThreshold: uint64(vm.envUint("AUCTION_TRIGGER_THRESHOLD")),
            clearThreshold: uint64(vm.envUint("CLEAR_THRESHOLD")),
            maxShiftMagnitude: uint64(vm.envUint("MAX_SHIFT_MAGNITUDE")),
            minAuctionBlocks: uint64(vm.envUint("MIN_AUCTION_BLOCKS")),
            recenterRange: uint64(vm.envUint("RECENTER_RANGE")),
            maxRecenterDrift: uint64(vm.envUint("MAX_RECENTER_DRIFT")),
            minRecenterDelta: uint64(vm.envUint("MIN_RECENTER_DELTA")),
            surchargeDecayPerBlock: uint64(vm.envUint("SURCHARGE_DECAY_PER_BLOCK")),
            surchargeMultiplier: uint64(vm.envUint("SURCHARGE_MULTIPLIER")),
            deploySurcharge: uint64(vm.envUint("DEPLOY_SURCHARGE"))
        });

        console.log("=== DeployHook ===");
        console.log("Deployer:    ", deployer);
        console.log("Pool:        ", pool);
        console.log("EulerAccount:", eulerAccount);
        console.log("OracleTarget:", oracleCfg.target);
        console.log("OracleToken0:", oracleCfg.token0);
        console.log("OracleMode:  ", oracleCfg.v4PoolId == bytes32(0) ? "V3 (slot0)" : "V4 (extsload)");

        vm.startBroadcast(pk);

        // 1. Deploy the hook.
        DynamicFeeAuctionHook hook = new DynamicFeeAuctionHook(
            pool, deployer, oracleCfg, feeCfg, auctionCfg
        );
        console.log("Hook deployed:", address(hook));

        // 2. Install the hook on the pool via the EVC.
        IEulerSwap.DynamicParams memory d = EulerSwap(pool).getDynamicParams();
        d.swapHook = address(hook);
        d.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        (uint112 r0, uint112 r1,) = EulerSwap(pool).getReserves();
        evc.call(
            pool,
            eulerAccount,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: r0, reserve1: r1}))
            )
        );
        console.log("Pool reconfigured with hook bound to GET_FEE | AFTER_SWAP.");

        vm.stopBroadcast();
    }
}
