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

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title DeployMainnet - Deploy EulerSwap USDC/WETH pool + LPAgentHook on mainnet
/// @notice Deployer wallet needs: ETH (for WETH wrap + gas) + USDC.
///         The script auto-wraps ETH to WETH, deposits both into Euler vaults,
///         deploys the pool via the factory, then deploys and installs LPAgentHook.
///
/// @dev Usage:
///   # Dry run (simulation only):
///   PRIVATE_KEY=0x... forge script script/DeployMainnet.s.sol:DeployMainnet \
///     --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY -vvvv
///
///   # Live deployment:
///   PRIVATE_KEY=0x... forge script script/DeployMainnet.s.sol:DeployMainnet \
///     --rpc-url https://eth-mainnet.g.alchemy.com/v2/KEY --broadcast --slow -vvvv
///
///   Environment variables (all optional except PRIVATE_KEY):
///     PRIVATE_KEY       - Deployer EOA private key (required)
///     WETH_AMOUNT       - Pool deposit in wei (default: 0.2 ether)
///     USDC_AMOUNT       - Pool deposit in raw units (default: 500e6 = 500 USDC)
///     CONCENTRATION     - AMM curve concentration (default: 0.3e18 = 30%)
///     EXPIRATION_DAYS   - Pool auto-expires after N days (default: 30, 0 = no expiry)
///
///   Output: prints POOL_ADDRESS, HOOK_ADDRESS, EVC_ADDRESS, EULER_ACCOUNT
///   for the agent .env.mainnet file.
contract DeployMainnet is Script {
    // --- Mainnet addresses ---
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwapFactory constant factory = EulerSwapFactory(0xD05213331221fAB8a3C387F2affBb605Bb04DF5F);

    address constant WETH_VAULT = 0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2;
    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // State set in run(), read by internal functions
    uint256 wethAmount;
    uint256 usdcAmount;
    uint64 concentration;
    uint40 expiration;
    uint80 priceX;
    uint80 priceY;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Configurable amounts (defaults: 0.2 ETH + 500 USDC)
        wethAmount = vm.envOr("WETH_AMOUNT", uint256(0.2 ether));
        usdcAmount = vm.envOr("USDC_AMOUNT", uint256(500e6));
        concentration = uint64(vm.envOr("CONCENTRATION", uint256(0.3e18)));
        uint256 expirationDays = vm.envOr("EXPIRATION_DAYS", uint256(30));
        expiration = expirationDays > 0 ? uint40(block.timestamp + expirationDays * 1 days) : 0;

        console.log("=== DeployMainnet ===");
        console.log("Deployer:", deployer);
        console.log("WETH amount:", wethAmount);
        console.log("USDC amount:", usdcAmount);
        console.log("Concentration:", uint256(concentration));
        console.log("Expiration: %s days", expirationDays);

        // Pre-flight: verify balances
        uint256 wethBal = IWETH9(WETH).balanceOf(deployer);
        uint256 usdcBal = IERC20Min(USDC).balanceOf(deployer);
        uint256 ethBal = deployer.balance;
        console.log("ETH balance:", ethBal);
        console.log("WETH balance:", wethBal);
        console.log("USDC balance:", usdcBal);

        // Auto-wrap ETH to WETH if needed
        bool needsWrap = wethBal < wethAmount;
        if (needsWrap) {
            uint256 wrapAmount = wethAmount - wethBal;
            require(ethBal >= wrapAmount + 0.05 ether, "Insufficient ETH for WETH wrap + gas");
            console.log("Will wrap ETH->WETH:", wrapAmount);
        }
        require(usdcBal >= usdcAmount, "Insufficient USDC");

        // Read oracle prices for priceX/priceY
        _readOraclePrices();
        console.log("Oracle priceX (USDC):", uint256(priceX));
        console.log("Oracle priceY (WETH):", uint256(priceY));
        require(priceX > 0 && priceY > 0, "Oracle returned 0 - check vault oracle config");

        vm.startBroadcast(deployerKey);

        // Step 1: Wrap ETH if needed, then deposit into Euler vaults
        if (needsWrap) {
            IWETH9(WETH).deposit{value: wethAmount - wethBal}();
        }
        IWETH9(WETH).approve(WETH_VAULT, type(uint256).max);
        IERC20Min(USDC).approve(USDC_VAULT, type(uint256).max);
        IEVault(WETH_VAULT).deposit(wethAmount, deployer);
        IEVault(USDC_VAULT).deposit(usdcAmount, deployer);
        console.log("Vault deposits done");

        // Step 2: Deploy pool
        address poolAddr = _deployPool(deployer);

        // Step 3: Deploy and install hook
        address hookAddr = _deployAndInstallHook(poolAddr, deployer);

        vm.stopBroadcast();

        // Log addresses for agent .env
        console.log("");
        console.log("=== Copy to agent/.env.mainnet ===");
        console.log(string.concat("POOL_ADDRESS=", vm.toString(poolAddr)));
        console.log(string.concat("HOOK_ADDRESS=", vm.toString(hookAddr)));
        console.log(string.concat("EVC_ADDRESS=", vm.toString(address(evc))));
        console.log(string.concat("EULER_ACCOUNT=", vm.toString(deployer)));
    }

    function _readOraclePrices() internal {
        address oracleAddr = IEVault(USDC_VAULT).oracle();
        address unitOfAccount = IEVault(USDC_VAULT).unitOfAccount();

        // getQuote(1e18, asset, uoa) returns value of 1e18 raw units in unit of account
        uint256 price0 = IPriceOracle(oracleAddr).getQuote(1e18, USDC, unitOfAccount);
        uint256 price1 = IPriceOracle(oracleAddr).getQuote(1e18, WETH, unitOfAccount);

        // priceX/priceY = value per 1 raw unit (WAD-scaled basis divided by 1e18)
        // USDC (6 dec): 1e18 raw = 1e12 USDC = $1e12, price0 = 1e30, priceX = 1e12
        // WETH (18 dec): 1e18 raw = 1 WETH = $2500, price1 = 2500e18, priceY = 2500
        priceX = uint80(price0 / 1e18);
        priceY = uint80(price1 / 1e18);
    }

    function _deployPool(address deployer) internal returns (address) {
        // USDC (0xA0b8...) < WETH (0xC02a...) -- asset0=USDC, asset1=WETH
        IEulerSwap.StaticParams memory sParams = IEulerSwap.StaticParams({
            supplyVault0: USDC_VAULT,
            borrowVault0: USDC_VAULT,
            supplyVault1: WETH_VAULT,
            borrowVault1: WETH_VAULT,
            eulerAccount: deployer,
            feeRecipient: address(0)
        });

        IEulerSwap.DynamicParams memory dParams = IEulerSwap.DynamicParams({
            equilibriumReserve0: uint112(usdcAmount),
            equilibriumReserve1: uint112(wethAmount),
            minReserve0: 0,
            minReserve1: 0,
            priceX: priceX,
            priceY: priceY,
            concentrationX: concentration,
            concentrationY: concentration,
            fee0: 0,
            fee1: 0,
            expiration: expiration,
            swapHookedOperations: 0,
            swapHook: address(0)
        });

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: uint112(usdcAmount), reserve1: uint112(wethAmount)});

        // Mine salt for valid hook address bits
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
            deployer, // owner = deployer EOA
            25e14, // baseFee: 25 bps
            100e14, // maxFee: 100 bps
            1e14, // minFee: 1 bp
            10e18 // mismatchScale: 10x
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
}
