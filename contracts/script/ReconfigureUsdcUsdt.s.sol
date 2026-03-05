// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

/// @title ReconfigureUsdcUsdt — Fix boost on USDC/USDT pool
/// @notice Corrected booster math with oracle price change at boundary:
///   X = E * LTV / (H * (1+r) * beta - LTV * alpha)
///   E=500, LTV=0.94, H=1.01, r=1%, c=0
///   alpha = sqrt(1.01) - 1 = 0.004988
///   beta  = 1 - 1/sqrt(1.01) = 0.004963
///   X = 470 / (1.01*1.01*0.004963 - 0.94*0.004988) = 470 / 0.000374 = 1,257,000
///
///   The (1+r) factor accounts for the oracle moving to the boundary price.
///   At the Y boundary, USDT appreciates by (1+r), increasing USDT debt value.
///   Depth per side: ~$6,200
contract ReconfigureUsdcUsdt is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;
    address constant SUB_ACCOUNT = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf;

    // Corrected equilibrium: ~2514x boost from 500 USDC equity
    uint112 constant EQ = 1257000000000; // 1,257,000 (6 decimals)

    // sqrt(1.01) * 1e6 = 1004988
    uint256 constant SQRT101_NUM = 1004988;
    uint256 constant SQRT101_DEN = 1000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        EulerSwap pool = EulerSwap(POOL);

        // Read current params (preserves hook, prices, etc.)
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();

        uint112 min = uint112(uint256(EQ) * SQRT101_DEN / SQRT101_NUM);

        console.log("=== ReconfigureUsdcUsdt ===");
        console.log("Old eq0:", dParams.equilibriumReserve0);
        console.log("Old eq1:", dParams.equilibriumReserve1);
        console.log("New eq:", uint256(EQ));
        console.log("New min:", uint256(min));
        console.log("Depth per side:", uint256(EQ - min));

        // Update equilibrium and min reserves
        dParams.equilibriumReserve0 = EQ;
        dParams.equilibriumReserve1 = EQ;
        dParams.minReserve0 = min;
        dParams.minReserve1 = min;

        // Refresh expiration
        dParams.expiration = uint40(block.timestamp + 30 days);

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: EQ, reserve1: EQ});

        vm.startBroadcast(pk);

        evc.call(
            POOL, SUB_ACCOUNT, 0,
            abi.encodeCall(IEulerSwap.reconfigure, (dParams, initialState))
        );

        vm.stopBroadcast();

        // Verify
        (uint112 r0, uint112 r1,) = pool.getReserves();
        console.log("New reserve0:", uint256(r0));
        console.log("New reserve1:", uint256(r1));
    }
}
