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

interface IPriceOracle {
    function getQuote(uint256 amount, address base, address quote) external view returns (uint256);
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title DeployUsdcUsdt — Deploy USDC/USDT pool on sub-account 255
/// @notice One-sided equity: deposits only USDC. Pool borrows USDT via cross-collateral (94% LTV).
///
///   Health model (self-LTV=0, cross-LTV=94%, +/-1% range, c=0):
///     H_usdt at Xb = min0 * 0.94 / eq1 >= 1
///     H_usdc at Yb = min1 * 0.94 / (eq0-500) >= 1
///     where min = eq / sqrt(1.01)
///
///   Solving for H=1.005 at both boundaries:
///     k = 0.94 / (1.005 × sqrt(1.01)) = 0.93069
///     eq0 = 500 / (1 - k²) = 3736
///     eq1 = eq0 × k = 3477
///     Virtual liquidity: ~$7,213
contract DeployUsdcUsdt is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwapFactory constant factory = EulerSwapFactory(0xD05213331221fAB8a3C387F2affBb605Bb04DF5F);

    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant USDT_VAULT = 0x313603FA690301b0CaeEf8069c065862f9162162;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    // Sub-account 255: deployer (0x...BFE) last byte + 1
    address constant SUB_ACCOUNT = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf;

    // Pool parameters: one-sided 500 USDC equity, ±1% range, health≥1.005
    uint256 constant REAL_USDC = 500000000;      // 500 USDC
    uint112 constant EQ0 = 3736000000;            // 3736 USDC
    uint112 constant EQ1 = 3477000000;            // 3477 USDT
    // sqrt(1.01) × 1e6 = 1004988
    uint256 constant SQRT101_NUM = 1004988;
    uint256 constant SQRT101_DEN = 1000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("=== DeployUsdcUsdt ===");
        console.log("Deployer:", deployer);
        console.log("Sub-account:", SUB_ACCOUNT);

        // Pre-flight
        uint256 usdcBal = IERC20Min(USDC).balanceOf(deployer);
        console.log("USDC balance:", usdcBal);
        require(usdcBal >= REAL_USDC, "Insufficient USDC");

        // Read oracle prices
        (uint80 priceX, uint80 priceY) = _readPrices();
        console.log("priceX (USDC):", uint256(priceX));
        console.log("priceY (USDT):", uint256(priceY));

        // Compute min reserves
        uint112 min0 = uint112(uint256(EQ0) * SQRT101_DEN / SQRT101_NUM);
        uint112 min1 = uint112(uint256(EQ1) * SQRT101_DEN / SQRT101_NUM);
        console.log("eq0:", uint256(EQ0));
        console.log("eq1:", uint256(EQ1));
        console.log("min0:", uint256(min0));
        console.log("min1:", uint256(min1));

        vm.startBroadcast(pk);

        // Step 1: Deposit 500 USDC into vault for sub-account 255
        IERC20Min(USDC).approve(USDC_VAULT, type(uint256).max);
        IEVault(USDC_VAULT).deposit(REAL_USDC, SUB_ACCOUNT);
        console.log("USDC deposited:", REAL_USDC);

        // Step 2: Deploy pool
        address poolAddr = _deployPool(deployer, priceX, priceY, min0, min1);

        // Step 3-4: Deploy hook and install
        _deployAndInstallHook(poolAddr, deployer);

        vm.stopBroadcast();

        // Log addresses
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("POOL_ADDRESS:", poolAddr);
    }

    function _readPrices() internal view returns (uint80, uint80) {
        address oracleAddr = IEVault(USDC_VAULT).oracle();
        address uoa = IEVault(USDC_VAULT).unitOfAccount();
        uint256 p0 = IPriceOracle(oracleAddr).getQuote(1e18, USDC, uoa);
        uint256 p1 = IPriceOracle(oracleAddr).getQuote(1e18, USDT, uoa);
        return (uint80(p0 / 1e18), uint80(p1 / 1e18));
    }

    function _deployPool(
        address deployer,
        uint80 priceX,
        uint80 priceY,
        uint112 min0,
        uint112 min1
    ) internal returns (address) {
        // asset0=USDC (0xA0b8...) < asset1=USDT (0xdAC1...)
        IEulerSwap.StaticParams memory sParams = IEulerSwap.StaticParams({
            supplyVault0: USDC_VAULT,
            borrowVault0: USDC_VAULT,
            supplyVault1: USDT_VAULT,
            borrowVault1: USDT_VAULT,
            eulerAccount: SUB_ACCOUNT,
            feeRecipient: address(0)
        });

        IEulerSwap.DynamicParams memory dParams = IEulerSwap.DynamicParams({
            equilibriumReserve0: EQ0,
            equilibriumReserve1: EQ1,
            minReserve0: min0,
            minReserve1: min1,
            priceX: priceX,
            priceY: priceY,
            concentrationX: 0,
            concentrationY: 0,
            fee0: 0,
            fee1: 0,
            expiration: uint40(block.timestamp + 30 days),
            swapHookedOperations: 0,
            swapHook: address(0)
        });

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: EQ0, reserve1: EQ1});

        // Mine salt for hook-compatible address
        bytes memory creationCode = factory.creationCode(sParams);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        );
        (address poolAddr, bytes32 salt) = HookMiner.find(address(factory), flags, creationCode);

        // Deploy via EVC batch: setOperator + deployPool
        IEVC.BatchItem[] memory items = new IEVC.BatchItem[](2);
        items[0] = IEVC.BatchItem({
            onBehalfOfAccount: address(0),
            targetContract: address(evc),
            value: 0,
            data: abi.encodeCall(evc.setAccountOperator, (SUB_ACCOUNT, poolAddr, true))
        });
        items[1] = IEVC.BatchItem({
            onBehalfOfAccount: SUB_ACCOUNT,
            targetContract: address(factory),
            value: 0,
            data: abi.encodeCall(EulerSwapFactory.deployPool, (sParams, dParams, initialState, salt))
        });

        evc.batch(items);
        console.log("Pool deployed at:", poolAddr);
        return poolAddr;
    }

    function _deployAndInstallHook(address poolAddr, address deployer) internal {
        EulerSwap pool = EulerSwap(poolAddr);

        LPAgentHook hook = new LPAgentHook(
            poolAddr,
            deployer,
            0x3416cF6C708Da44DB2624D63ea0AAef7113527C6, // Uniswap V3 USDC/USDT 0.01%
            3e14,   // baseFee: 3 bps
            50e14,  // maxFee: 50 bps
            0.8e18  // mismatchScale: 80% capture
        );
        console.log("Hook deployed at:", address(hook));

        // Reconfigure to install hook
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();
        dParams.swapHook = address(hook);
        dParams.swapHookedOperations = EULER_SWAP_HOOK_GET_FEE | EULER_SWAP_HOOK_AFTER_SWAP;

        (uint112 r0, uint112 r1,) = pool.getReserves();

        evc.call(
            poolAddr, SUB_ACCOUNT, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (dParams, IEulerSwap.InitialState({reserve0: r0, reserve1: r1})))
        );
        console.log("Hook installed!");
    }
}
