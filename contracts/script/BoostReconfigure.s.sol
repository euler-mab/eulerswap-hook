// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {LPAgentHook} from "../src/LPAgentHook.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title BoostReconfigure — Recompute leverage boost and reconfigure USDC/WETH pool
/// @notice Deposits existing WETH to vault (needed for yr > 0), then reconfigures pool
///         with properly boosted equilibrium reserves computed from math.ts.
///
/// @dev The boost was computed using src/lib/math.ts with:
///   xr=3610.73, yr=0.000394, xd=0, yd=0.320077, vyx=0.84, vxy=0.85, rx=ry=0.05, cx=cy=0
///   Result: x0=714,299 USDC (4.3x), y0=280.41 WETH (3.4x)
///
///   Usage:
///   PRIVATE_KEY=0x... forge script script/BoostReconfigure.s.sol:BoostReconfigure \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract BoostReconfigure is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant WETH_VAULT = 0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant HOOK = 0x6f8aB798441b14b281540215774C2b3e1B3577F5;

    // Boosted values from math.ts computation (H=1.0, borrow LTV)
    uint112 constant NEW_EQ0 = 714_299_232_650;          // 714,299 USDC
    uint112 constant NEW_EQ1 = 280_408_293_756_942_680_064; // 280.41 WETH
    uint112 constant NEW_MIN0 = 697_084_673_250;          // 697,085 USDC
    uint112 constant NEW_MIN1 = 273_650_474_332_774_039_552; // 273.65 WETH
    uint80 constant NEW_PRICE_Y = 1975;                   // Updated from Uniswap V3

    // Updated gasCoeff for larger pool
    uint64 constant NEW_GAS_COEFF = 65_400_000_000; // 6.54e10

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EulerSwap pool = EulerSwap(POOL);
        LPAgentHook hook = LPAgentHook(HOOK);

        // Log current state
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        console.log("Deployer:", deployer);
        console.log("Current eq:", uint256(d.equilibriumReserve0), uint256(d.equilibriumReserve1));
        console.log("Current reserves:", uint256(r0), uint256(r1));
        console.log("Current priceY:", uint256(d.priceY));

        // Check WETH balance to deposit
        uint256 wethBal = IWETH9(WETH).balanceOf(deployer);
        console.log("WETH to deposit:", wethBal);
        require(wethBal > 0, "No WETH to deposit - need at least some for yr > 0");

        // Log new target values
        console.log("");
        console.log("=== New boosted values ===");
        console.log("New eq0:", uint256(NEW_EQ0));
        console.log("New eq1:", uint256(NEW_EQ1));
        console.log("New min0:", uint256(NEW_MIN0));
        console.log("New min1:", uint256(NEW_MIN1));
        console.log("New priceY:", uint256(NEW_PRICE_Y));
        console.log("Improvement: 4.3x USDC, 3.4x WETH");

        vm.startBroadcast(pk);

        // 1. Deposit existing WETH to vault (needed for yr > 0 in boost formula)
        IWETH9(WETH).approve(WETH_VAULT, wethBal);
        IEVault(WETH_VAULT).deposit(wethBal, deployer);
        console.log("WETH deposited to vault");

        // 2. Reconfigure pool with boosted params
        d.equilibriumReserve0 = NEW_EQ0;
        d.equilibriumReserve1 = NEW_EQ1;
        d.minReserve0 = NEW_MIN0;
        d.minReserve1 = NEW_MIN1;
        d.priceY = NEW_PRICE_Y;

        // Set initial state to new equilibrium (reset pool position)
        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: NEW_EQ0, reserve1: NEW_EQ1}))
            )
        );
        console.log("Pool reconfigured with boost");

        // 3. Update gasCoeff on hook (bigger pool → lower threshold)
        hook.setFeeParams(
            5e14,       // baseFee: 5 bps (unchanged)
            3500e14,    // maxFee: 3500 bps (unchanged)
            NEW_GAS_COEFF, // gasCoeff: 6.54e10 (was 1.22e11)
            5e14,       // externalFee: 5 bps (Uni V3 0.05% pool)
            0.8e18,     // captureRate: 80% (unchanged)
            0.3e18      // attractRate: 30% (unchanged)
        );
        console.log("Hook gasCoeff updated");

        vm.stopBroadcast();

        // Verify
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory finalD = pool.getDynamicParams();
        console.log("");
        console.log("=== Final state ===");
        console.log("Reserves:", uint256(finalR0), uint256(finalR1));
        console.log("Eq:", uint256(finalD.equilibriumReserve0), uint256(finalD.equilibriumReserve1));
        console.log("PriceY:", uint256(finalD.priceY));
        console.log("Done!");
    }
}
