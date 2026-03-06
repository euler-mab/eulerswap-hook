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

/// @title AddCapital — Deposit USDC and reconfigure USDC/WETH pool
/// @dev Usage:
///   PRIVATE_KEY=0x... forge script script/AddCapital.s.sol:AddCapital \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
contract AddCapital is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant EULER_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // Read current state
        EulerSwap pool = EulerSwap(POOL);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        IEulerSwap.DynamicParams memory d = pool.getDynamicParams();
        uint256 usdcBal = IERC20Min(USDC).balanceOf(deployer);

        console.log("Deployer:", deployer);
        console.log("USDC to add:", usdcBal);
        console.log("Current reserves:", uint256(r0), uint256(r1));
        console.log("Current eq:", uint256(d.equilibriumReserve0), uint256(d.equilibriumReserve1));

        require(usdcBal > 0, "No USDC to add");

        // Compute proportional scale factor (fixed-point 1e18 = 1x)
        uint256 ratio = (uint256(d.equilibriumReserve0) + usdcBal) * 1e18 / d.equilibriumReserve0;
        console.log("Scale ratio (1e18=1x):", ratio);

        // Scale all params proportionally to maintain same price/range
        uint112 newEq0 = uint112(d.equilibriumReserve0 + usdcBal);
        uint112 newEq1 = uint112(uint256(d.equilibriumReserve1) * ratio / 1e18);
        uint112 newMin0 = uint112(uint256(d.minReserve0) * ratio / 1e18);
        uint112 newMin1 = uint112(uint256(d.minReserve1) * ratio / 1e18);
        uint112 newR0 = uint112(uint256(r0) * ratio / 1e18);
        uint112 newR1 = uint112(uint256(r1) * ratio / 1e18);

        console.log("New eq:", uint256(newEq0), uint256(newEq1));
        console.log("New min:", uint256(newMin0), uint256(newMin1));
        console.log("New reserves:", uint256(newR0), uint256(newR1));

        vm.startBroadcast(pk);

        // 1. Deposit USDC into vault
        IERC20Min(USDC).approve(USDC_VAULT, usdcBal);
        IEVault(USDC_VAULT).deposit(usdcBal, deployer);
        console.log("USDC deposited to vault");

        // 2. Reconfigure pool with scaled params
        d.equilibriumReserve0 = newEq0;
        d.equilibriumReserve1 = newEq1;
        d.minReserve0 = newMin0;
        d.minReserve1 = newMin1;

        evc.call(
            POOL,
            EULER_ACCOUNT,
            0,
            abi.encodeCall(
                IEulerSwap.reconfigure,
                (d, IEulerSwap.InitialState({reserve0: newR0, reserve1: newR1}))
            )
        );
        console.log("Pool reconfigured");

        vm.stopBroadcast();

        // Verify
        (uint112 finalR0, uint112 finalR1,) = pool.getReserves();
        console.log("Final reserves:", uint256(finalR0), uint256(finalR1));
        console.log("Done!");
    }
}
