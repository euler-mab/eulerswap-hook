// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {EulerSwapFactory} from "../eulerswap/src/EulerSwapFactory.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHook} from "../src/LPAgentHook.sol";
import "../eulerswap/src/interfaces/IEulerSwapHookTarget.sol";
import {HookMiner} from "../eulerswap/test/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title DeployForkTest — Deploy EulerSwap pool + LPAgentHook on an Anvil mainnet fork
/// @notice Run after funding the deployer with USDC (see agent/fork-test.sh)
contract DeployForkTest is Script {
    // --- Mainnet addresses ---
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwapFactory constant factory = EulerSwapFactory(0xD05213331221fAB8a3C387F2affBb605Bb04DF5F);

    address constant WETH_VAULT = 0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2;
    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    uint256 constant WETH_AMOUNT = 10 ether;
    uint256 constant USDC_AMOUNT = 25_000 * 1e6;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        _depositIntoVaults(deployer);
        address poolAddr = _deployPool(deployer);
        address hookAddr = _deployAndInstallHook(poolAddr, deployer);

        vm.stopBroadcast();

        _logEnv(poolAddr, hookAddr, deployer);
    }

    function _depositIntoVaults(address deployer) internal {
        IWETH9(WETH).deposit{value: WETH_AMOUNT}();
        IWETH9(WETH).approve(WETH_VAULT, type(uint256).max);
        IERC20Min(USDC).approve(USDC_VAULT, type(uint256).max);
        IEVault(WETH_VAULT).deposit(WETH_AMOUNT, deployer);
        IEVault(USDC_VAULT).deposit(USDC_AMOUNT, deployer);
        console.log("Vault deposits done");
    }

    function _deployPool(address deployer) internal returns (address) {
        // USDC (0xA0b8...) < WETH (0xC02a...) — asset0=USDC, asset1=WETH
        IEulerSwap.StaticParams memory sParams = IEulerSwap.StaticParams({
            supplyVault0: USDC_VAULT,
            borrowVault0: USDC_VAULT,
            supplyVault1: WETH_VAULT,
            borrowVault1: WETH_VAULT,
            eulerAccount: deployer,
            feeRecipient: address(0)
        });

        IEulerSwap.DynamicParams memory dParams = IEulerSwap.DynamicParams({
            equilibriumReserve0: uint112(USDC_AMOUNT),
            equilibriumReserve1: uint112(WETH_AMOUNT),
            minReserve0: 0,
            minReserve1: 0,
            priceX: uint80(1e18),
            priceY: uint80(1e18),
            concentrationX: uint64(0.5e18),
            concentrationY: uint64(0.5e18),
            fee0: 0,
            fee1: 0,
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });

        IEulerSwap.InitialState memory initialState = IEulerSwap.InitialState({
            reserve0: uint112(USDC_AMOUNT),
            reserve1: uint112(WETH_AMOUNT)
        });

        // Mine a salt that produces a valid Uniswap V4 hook address
        // (mainnet factory enforces hook flag bits in the pool address)
        bytes memory creationCode = factory.creationCode(sParams);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        );
        (address poolAddr, bytes32 salt) = HookMiner.find(address(factory), flags, creationCode);

        IEVC.BatchItem[] memory items = new IEVC.BatchItem[](2);
        items[0] = IEVC.BatchItem({
            onBehalfOfAccount: address(0),
            targetContract: address(evc),
            value: 0,
            data: abi.encodeCall(evc.setAccountOperator, (deployer, poolAddr, true))
        });
        items[1] = IEVC.BatchItem({
            onBehalfOfAccount: deployer,
            targetContract: address(factory),
            value: 0,
            data: abi.encodeCall(EulerSwapFactory.deployPool, (sParams, dParams, initialState, salt))
        });

        evc.batch(items);
        console.log("Pool deployed at:", poolAddr);
        return poolAddr;
    }

    function _deployAndInstallHook(address poolAddr, address deployer) internal returns (address) {
        EulerSwap pool = EulerSwap(poolAddr);

        LPAgentHook hook = new LPAgentHook(
            poolAddr,
            deployer,   // owner = deployer (agent EOA for fork testing)
            25e14,      // baseFee: 25 bps
            100e14,     // maxFee: 100 bps
            1e14,       // minFee: 1 bp
            10e18       // mismatchScale: 10x
        );
        console.log("Hook deployed at:", address(hook));

        // Reconfigure pool to install hook
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        (uint112 r0, uint112 r1,) = pool.getReserves();

        evc.call(
            poolAddr,
            deployer,
            0,
            abi.encodeCall(IEulerSwap.reconfigure, (dParams, IEulerSwap.InitialState({reserve0: r0, reserve1: r1})))
        );

        console.log("Hook installed!");
        return address(hook);
    }

    function _logEnv(address poolAddr, address hookAddr, address deployer) internal view {
        console.log("");
        console.log("=== Copy to agent/.env ===");
        console.log(string.concat("POOL_ADDRESS=", vm.toString(poolAddr)));
        console.log(string.concat("HOOK_ADDRESS=", vm.toString(hookAddr)));
        console.log(string.concat("EVC_ADDRESS=", vm.toString(address(evc))));
        console.log(string.concat("EULER_ACCOUNT=", vm.toString(deployer)));
    }
}
