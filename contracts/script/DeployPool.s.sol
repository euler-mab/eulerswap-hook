// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {IEulerSwapFactory} from "../eulerswap/src/interfaces/IEulerSwapFactory.sol";
import {IEVC} from "evc/interfaces/IEthereumVaultConnector.sol";

/// @title DeployPool — Generic env-driven EulerSwap pool deployment via factory
/// @notice Deploys a bare EulerSwap pool (no hook bound) using the supplied
///         vaults, curve params, and initial reserves. Hook installation is a
///         separate step — run DeployHook.s.sol after this if you want a hook.
///
/// @dev Usage:
///   PRIVATE_KEY=0x...                                    \
///   FACTORY=0x...                                        \
///   EULER_ACCOUNT=0x...                                  \
///   SUPPLY_VAULT_0=0x... SUPPLY_VAULT_1=0x...            \
///   BORROW_VAULT_0=0x... BORROW_VAULT_1=0x...            \
///   FEE_RECIPIENT=0x...                                  \  # default: address(0)
///   EQ0=... EQ1=...                                      \
///   MIN0=... MIN1=...                                    \
///   PRICE_X=... PRICE_Y=...                              \
///   CONCENTRATION_X=...  CONCENTRATION_Y=...             \  # both default 0
///   FEE_0=...            FEE_1=...                       \  # both default 0
///     forge script script/DeployPool.s.sol:DeployPool \
///     --rpc-url $RPC_URL --broadcast --slow -vvvv
///
///   Reserves (EQ0, EQ1, MIN0, MIN1) are uint112 raw token amounts.
///   PRICE_X / PRICE_Y are uint80 and account for asset-decimal differences.
///   CONCENTRATION_* and FEE_* are WAD-scaled (1e18 = 100%).
///   The pool is deployed with swapHook=address(0) and swapHookedOperations=0;
///   bind a hook afterwards with DeployHook.s.sol.
contract DeployPool is Script {
    IEVC constant evc = IEVC(0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        IEulerSwapFactory factory = IEulerSwapFactory(vm.envAddress("FACTORY"));

        IEulerSwap.StaticParams memory s = IEulerSwap.StaticParams({
            supplyVault0: vm.envAddress("SUPPLY_VAULT_0"),
            supplyVault1: vm.envAddress("SUPPLY_VAULT_1"),
            borrowVault0: vm.envAddress("BORROW_VAULT_0"),
            borrowVault1: vm.envAddress("BORROW_VAULT_1"),
            eulerAccount: vm.envAddress("EULER_ACCOUNT"),
            feeRecipient: vm.envOr("FEE_RECIPIENT", address(0))
        });

        uint112 eq0 = uint112(vm.envUint("EQ0"));
        uint112 eq1 = uint112(vm.envUint("EQ1"));
        uint112 min0 = uint112(vm.envUint("MIN0"));
        uint112 min1 = uint112(vm.envUint("MIN1"));

        IEulerSwap.DynamicParams memory d = IEulerSwap.DynamicParams({
            equilibriumReserve0: eq0,
            equilibriumReserve1: eq1,
            minReserve0: min0,
            minReserve1: min1,
            priceX: uint80(vm.envUint("PRICE_X")),
            priceY: uint80(vm.envUint("PRICE_Y")),
            concentrationX: uint64(vm.envOr("CONCENTRATION_X", uint256(0))),
            concentrationY: uint64(vm.envOr("CONCENTRATION_Y", uint256(0))),
            fee0: uint64(vm.envOr("FEE_0", uint256(0))),
            fee1: uint64(vm.envOr("FEE_1", uint256(0))),
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });

        IEulerSwap.InitialState memory initial = IEulerSwap.InitialState({
            reserve0: eq0,
            reserve1: eq1
        });

        console.log("=== DeployPool ===");
        console.log("Deployer:    ", deployer);
        console.log("Factory:     ", address(factory));
        console.log("EulerAccount:", s.eulerAccount);
        console.log("FeeRecipient:", s.feeRecipient);
        console.log("supplyVault0:", s.supplyVault0);
        console.log("supplyVault1:", s.supplyVault1);
        console.log("borrowVault0:", s.borrowVault0);
        console.log("borrowVault1:", s.borrowVault1);
        console.log("eq0/eq1:     ", uint256(eq0), uint256(eq1));
        console.log("min0/min1:   ", uint256(min0), uint256(min1));
        console.log("priceX/Y:    ", uint256(d.priceX), uint256(d.priceY));
        console.log("cx/cy:       ", uint256(d.concentrationX), uint256(d.concentrationY));
        console.log("fee0/fee1:   ", uint256(d.fee0), uint256(d.fee1));

        vm.startBroadcast(pk);

        // factory.deployPool requires _msgSender() == eulerAccount, and the factory
        // uses EVCUtil._msgSender — so for sub-account deploys the call must be
        // routed through the EVC. For EOA-equals-eulerAccount setups either path
        // works; the EVC route is uniform.
        bytes memory result = evc.call(
            address(factory),
            s.eulerAccount,
            0,
            abi.encodeCall(IEulerSwapFactory.deployPool, (s, d, initial, bytes32(0)))
        );
        address pool = abi.decode(result, (address));

        vm.stopBroadcast();

        console.log("");
        console.log("Pool deployed:", pool);
        console.log("");
        console.log("=== Copy to .env ===");
        console.log(string.concat("POOL=", vm.toString(pool)));
    }
}
