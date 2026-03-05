// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

/// @title ReconfigureUsdcWeth — Fix boost on USDC/WETH pool
/// @notice Corrected booster math with oracle price change at boundary.
///
///   Real equity: ~452 USDC + ~0.2126 WETH (~$892)
///   Cross-LTV: USDC->WETH=84%, WETH->USDC=85%
///   Range: +/-5%, c=0
///
///   X-boundary (binding, 85% LTV on WETH->USDC side):
///     b = (H*(1+r)*E0$ + E1$*L1) / (H*(1+r)*E0$*beta - E1$*L1*alpha)
///     alpha = sqrt(1.05) - 1 = 0.02470
///     beta  = 1 - 1/sqrt(1.05) = 0.02410
///     H*(1+r) = 1.01 * 1.05 = 1.0605
///     b = (1.0605*452 + 374) / (1.0605*452*0.02410 - 374*0.02470)
///       = 853.3 / 2.32 = 368
///
///   The (1+r) factor accounts for the oracle moving to the boundary price.
///   At the X boundary, WETH depreciates by 1/(1+r), reducing collateral value.
///
///   New eq0 = 368 * 452 = 166,300 USDC
///   New eq1 = 368 * 0.2126 = 78.2 WETH
///   Depth per side: ~$4,000
contract ReconfigureUsdcWeth is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    address constant POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant SUB_ACCOUNT = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;

    // 368x boost from ~$892 two-sided equity, +/-5% range
    uint112 constant EQ0 = 166300000000;                      // 166,300 USDC (6 decimals)
    uint112 constant EQ1 = 78200000000000000000;               // 78.2 WETH (18 decimals)

    // sqrt(1.05) * 1e6 = 1024695
    uint256 constant SQRT105_NUM = 1024695;
    uint256 constant SQRT105_DEN = 1000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        EulerSwap pool = EulerSwap(POOL);

        // Read current params (preserves hook, prices, etc.)
        IEulerSwap.DynamicParams memory dParams = pool.getDynamicParams();

        uint112 min0 = uint112(uint256(EQ0) * SQRT105_DEN / SQRT105_NUM);
        uint112 min1 = uint112(uint256(EQ1) * SQRT105_DEN / SQRT105_NUM);

        console.log("=== ReconfigureUsdcWeth ===");
        console.log("Old eq0:", dParams.equilibriumReserve0);
        console.log("Old eq1:", dParams.equilibriumReserve1);
        console.log("New eq0:", uint256(EQ0));
        console.log("New eq1:", uint256(EQ1));
        console.log("New min0:", uint256(min0));
        console.log("New min1:", uint256(min1));
        console.log("USDC depth:", uint256(EQ0 - min0));
        console.log("WETH depth:", uint256(EQ1 - min1));

        // Update equilibrium and min reserves
        dParams.equilibriumReserve0 = EQ0;
        dParams.equilibriumReserve1 = EQ1;
        dParams.minReserve0 = min0;
        dParams.minReserve1 = min1;

        // Refresh expiration
        dParams.expiration = uint40(block.timestamp + 30 days);

        IEulerSwap.InitialState memory initialState =
            IEulerSwap.InitialState({reserve0: EQ0, reserve1: EQ1});

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
