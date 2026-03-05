// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPriceOracle {
    function getQuote(uint256 amount, address base, address quote) external view returns (uint256);
}

/// @title BoostPool — Add liquidity, set range, enable leverage
/// @notice Deposits additional WETH + USDC, then reconfigures the pool with:
///   - c=0 (constant product within range)
///   - ±10% price range via minReserves
///   - ~5x leverage (health=1 at boundaries)
contract BoostPool is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);
    EulerSwap constant pool = EulerSwap(0x4311031739918Aba578C3C667DA3028A12Ce28A8);

    address constant WETH_VAULT = 0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2;
    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // Boost factor: 5.0138x gives health=1.0 at boundary for ±10% range
    // with LTV(USDC→WETH)=84%, LTV(WETH→USDC)=85%, self-LTV=0
    uint256 constant BOOST_NUM = 50138;
    uint256 constant BOOST_DEN = 10000;
    // sqrt(1.10) ≈ 1.04881 → eq/min ratio
    uint256 constant SQRT110_NUM = 10488;
    uint256 constant SQRT110_DEN = 10000;

    // Real equity after all deposits
    uint256 constant REAL_USDC = 447200000;          // 447.20 USDC
    uint256 constant REAL_WETH = 215000000000000000;  // 0.215 WETH

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("=== BoostPool ===");
        console.log("Deployer:", deployer);

        // Read oracle prices
        (uint80 newPriceX, uint80 newPriceY) = _readPrices();
        console.log("priceX:", uint256(newPriceX));
        console.log("priceY:", uint256(newPriceY));

        // Compute pool parameters
        uint112 eq0 = uint112(REAL_USDC * BOOST_NUM / BOOST_DEN);
        uint112 eq1 = uint112(REAL_WETH * BOOST_NUM / BOOST_DEN);
        uint112 min0 = uint112(uint256(eq0) * SQRT110_DEN / SQRT110_NUM);
        uint112 min1 = uint112(uint256(eq1) * SQRT110_DEN / SQRT110_NUM);

        console.log("eq0:", uint256(eq0));
        console.log("eq1:", uint256(eq1));
        console.log("min0:", uint256(min0));
        console.log("min1:", uint256(min1));

        vm.startBroadcast(deployerKey);

        // Step 1: Wrap 0.035 ETH → WETH
        IWETH9(WETH).deposit{value: 0.035 ether}();

        // Step 2: Deposit WETH into vault
        uint256 wethBal = IWETH9(WETH).balanceOf(deployer);
        IWETH9(WETH).approve(WETH_VAULT, type(uint256).max);
        IEVault(WETH_VAULT).deposit(wethBal, deployer);
        console.log("WETH deposited:", wethBal);

        // Step 3: Deposit USDC into vault
        IERC20Min(USDC).approve(USDC_VAULT, type(uint256).max);
        IEVault(USDC_VAULT).deposit(404690000, deployer); // 404.69 USDC
        console.log("USDC deposited: 404690000");

        // Step 4: Reconfigure pool
        _reconfigure(deployer, eq0, eq1, min0, min1, newPriceX, newPriceY);

        vm.stopBroadcast();

        // Verify
        (uint112 r0, uint112 r1,) = pool.getReserves();
        console.log("Final reserve0:", uint256(r0));
        console.log("Final reserve1:", uint256(r1));
    }

    function _readPrices() internal view returns (uint80, uint80) {
        address oracleAddr = IEVault(USDC_VAULT).oracle();
        address uoa = IEVault(USDC_VAULT).unitOfAccount();
        uint256 p0 = IPriceOracle(oracleAddr).getQuote(1e18, USDC, uoa);
        uint256 p1 = IPriceOracle(oracleAddr).getQuote(1e18, WETH, uoa);
        return (uint80(p0 / 1e18), uint80(p1 / 1e18));
    }

    function _reconfigure(
        address deployer,
        uint112 eq0, uint112 eq1,
        uint112 min0, uint112 min1,
        uint80 priceX, uint80 priceY
    ) internal {
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        d.equilibriumReserve0 = eq0;
        d.equilibriumReserve1 = eq1;
        d.minReserve0 = min0;
        d.minReserve1 = min1;
        d.priceX = priceX;
        d.priceY = priceY;
        d.concentrationX = 0;
        d.concentrationY = 0;

        IEulerSwap.InitialState memory s = IEulerSwap.InitialState({
            reserve0: eq0,
            reserve1: eq1
        });

        evc.call(
            address(pool), deployer, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (d, s))
        );
        console.log("Pool reconfigured!");
    }
}
