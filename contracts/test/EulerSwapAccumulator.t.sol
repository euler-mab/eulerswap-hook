// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {EulerSwapTestBase} from "../eulerswap/test/EulerSwapTestBase.t.sol";
import {IEulerSwap, EulerSwap} from "../eulerswap/src/EulerSwap.sol";
import {IEVault} from "evk/EVault/IEVault.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/Test.sol";

/// @notice Verifies the accumulator invariants described in docs/auction-walkthrough.md Step 0:
///   1. Reserves are a fee-absent accumulator: final_reserves = init_reserves + Σ(postFeeIn - out)
///   2. Vault NAV grows by accumulated fees: final_NAV - init_NAV = Σ(fees)
///   3. Per-asset vault net position = init + Σ(grossIn - out)  [grossIn = postFeeIn + fee]
contract AccumulatorInvariantTest is EulerSwapTestBase {
    // Swap event signature from SwapLib
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        uint256 fee0,
        uint256 fee1,
        uint112 reserve0,
        uint112 reserve1,
        address indexed to
    );

    EulerSwap testPool;
    IEulerSwap.StaticParams sParams;
    address swapper;

    function setUp() public override {
        super.setUp();

        // Pool with 1% fee, 1:1 price, c=0.5, no hook, feeRecipient = address(0)
        testPool = createEulerSwap(10e18, 10e18, 0.01e18, 1e18, 1e18, 0.5e18, 0.5e18);
        sParams = testPool.getStaticParams();
        swapper = makeAddr("swapper");
    }

    // --- Helpers ---

    struct VaultSnapshot {
        uint256 deposit0;
        uint256 deposit1;
        uint256 debt0;
        uint256 debt1;
    }

    function _vaultSnapshot() internal view returns (VaultSnapshot memory v) {
        address account = sParams.eulerAccount;
        uint256 shares0 = IEVault(sParams.supplyVault0).balanceOf(account);
        v.deposit0 = shares0 == 0 ? 0 : IEVault(sParams.supplyVault0).convertToAssets(shares0);
        uint256 shares1 = IEVault(sParams.supplyVault1).balanceOf(account);
        v.deposit1 = shares1 == 0 ? 0 : IEVault(sParams.supplyVault1).convertToAssets(shares1);
        v.debt0 = IEVault(sParams.borrowVault0).debtOf(account);
        v.debt1 = IEVault(sParams.borrowVault1).debtOf(account);
    }

    function _nav(VaultSnapshot memory v) internal pure returns (int256) {
        return int256(v.deposit0 + v.deposit1) - int256(v.debt0 + v.debt1);
    }

    function _doSwap(bool asset0In, uint256 amount) internal {
        if (asset0In) {
            assetTST.mint(swapper, amount);
            vm.prank(swapper);
            assetTST.transfer(address(testPool), amount);
            uint256 quote = testPool.computeQuote(address(assetTST), address(assetTST2), amount, true);
            require(quote > 0, "quote is zero");
            vm.prank(swapper);
            testPool.swap(0, quote, swapper, "");
        } else {
            assetTST2.mint(swapper, amount);
            vm.prank(swapper);
            assetTST2.transfer(address(testPool), amount);
            uint256 quote = testPool.computeQuote(address(assetTST2), address(assetTST), amount, true);
            require(quote > 0, "quote is zero");
            vm.prank(swapper);
            testPool.swap(quote, 0, swapper, "");
        }
    }

    struct SwapAccumulator {
        int256 netPostFee0; // Σ(amount0In - amount0Out) -- what reserves track
        int256 netPostFee1; // Σ(amount1In - amount1Out)
        int256 netGross0;   // Σ((amount0In + fee0) - amount0Out) -- what vaults track
        int256 netGross1;   // Σ((amount1In + fee1) - amount1Out)
        uint256 totalFee0;  // Σ(fee0)
        uint256 totalFee1;  // Σ(fee1)
    }

    function _logSigned(string memory label, int256 value) internal pure {
        if (value >= 0) {
            console.log(label, uint256(value));
        } else {
            console.log(string.concat(label, " -"), uint256(-value));
        }
    }

    function _parseSwapEvent(Vm.Log[] memory logs) internal pure returns (
        uint256 amount0In, uint256 amount1In,
        uint256 amount0Out, uint256 amount1Out,
        uint256 fee0, uint256 fee1
    ) {
        bytes32 swapTopic = keccak256("Swap(address,uint256,uint256,uint256,uint256,uint256,uint256,uint112,uint112,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == swapTopic) {
                // Non-indexed params: amount0In, amount1In, amount0Out, amount1Out, fee0, fee1, reserve0, reserve1
                (amount0In, amount1In, amount0Out, amount1Out, fee0, fee1,,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint112, uint112));
                return (amount0In, amount1In, amount0Out, amount1Out, fee0, fee1);
            }
        }
        revert("Swap event not found");
    }

    // --- Tests ---

    function test_accumulator_100_swaps_reserves() public {
        // Snapshot initial reserves
        (uint112 initR0, uint112 initR1,) = testPool.getReserves();

        SwapAccumulator memory acc;

        // 100 swaps alternating direction with varying sizes
        for (uint256 i = 0; i < 100; i++) {
            // Alternate: 2 swaps asset0→asset1, then 1 swap asset1→asset0
            // This creates a net drift so we exercise debt on one side
            bool asset0In = (i % 3 != 0);
            // Small amounts relative to 10e18 reserves
            uint256 size = 0.01e18 + (i % 7) * 0.005e18;

            vm.recordLogs();
            _doSwap(asset0In, size);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            (uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, uint256 f0, uint256 f1) =
                _parseSwapEvent(logs);

            acc.netPostFee0 += int256(a0In) - int256(a0Out);
            acc.netPostFee1 += int256(a1In) - int256(a1Out);
            acc.totalFee0 += f0;
            acc.totalFee1 += f1;
        }

        // Verify: reserves = initial + Σ(postFeeIn - out)
        (uint112 finalR0, uint112 finalR1,) = testPool.getReserves();

        assertEq(
            int256(uint256(finalR0)),
            int256(uint256(initR0)) + acc.netPostFee0,
            "Reserve0 accumulator mismatch"
        );
        assertEq(
            int256(uint256(finalR1)),
            int256(uint256(initR1)) + acc.netPostFee1,
            "Reserve1 accumulator mismatch"
        );

        // Sanity: fees should be nonzero (we used a 1% fee)
        assertTrue(acc.totalFee0 + acc.totalFee1 > 0, "Expected nonzero fees");
        console.log("Total fee0:", acc.totalFee0);
        console.log("Total fee1:", acc.totalFee1);
        console.log("Reserve0 delta:", finalR0 > initR0 ? uint256(finalR0 - initR0) : uint256(initR0 - finalR0));
        console.log("Reserve1 delta:", finalR1 > initR1 ? uint256(finalR1 - initR1) : uint256(initR1 - finalR1));
    }

    function test_accumulator_100_swaps_vault_nav() public {
        // Snapshot initial vault state
        VaultSnapshot memory initVault = _vaultSnapshot();
        int256 initNav = _nav(initVault);

        SwapAccumulator memory acc;

        for (uint256 i = 0; i < 100; i++) {
            bool asset0In = (i % 3 != 0);
            uint256 size = 0.01e18 + (i % 7) * 0.005e18;

            vm.recordLogs();
            _doSwap(asset0In, size);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            (uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, uint256 f0, uint256 f1) =
                _parseSwapEvent(logs);
            acc.totalFee0 += f0;
            acc.totalFee1 += f1;
            acc.netGross0 += int256(a0In + f0) - int256(a0Out);
            acc.netGross1 += int256(a1In + f1) - int256(a1Out);
        }

        VaultSnapshot memory finalVault = _vaultSnapshot();
        int256 finalNav = _nav(finalVault);
        int256 navGrowth = finalNav - initNav;
        int256 totalFees = int256(acc.totalFee0 + acc.totalFee1);

        // NAV grows by MORE than just fees. The pool also captures value from the
        // AMM curve spread: each swap pays slightly more than it receives due to
        // price impact (curvature), even ignoring fees. This "slippage" accrues
        // to the LP as additional equity.
        //
        // NAV_growth = Σ(grossIn - curveOut) = Σ(fees) + Σ(curve_spread)
        //
        // So we verify: NAV_growth >= totalFees, and NAV_growth == netGross0 + netGross1
        assertTrue(navGrowth >= totalFees, "NAV growth should be at least total fees");

        assertApproxEqAbs(
            navGrowth,
            acc.netGross0 + acc.netGross1,
            0,
            "NAV growth should equal sum of per-asset gross flows"
        );

        int256 curveSpread = navGrowth - totalFees;
        console.log("NAV growth:", uint256(navGrowth));
        console.log("Total fees:", uint256(totalFees));
        console.log("Curve spread (slippage captured):", uint256(curveSpread));
    }

    function test_accumulator_100_swaps_per_asset_vault() public {
        // Snapshot initial vault state
        VaultSnapshot memory initVault = _vaultSnapshot();

        SwapAccumulator memory acc;

        for (uint256 i = 0; i < 100; i++) {
            bool asset0In = (i % 3 != 0);
            uint256 size = 0.01e18 + (i % 7) * 0.005e18;

            vm.recordLogs();
            _doSwap(asset0In, size);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            (uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, uint256 f0, uint256 f1) =
                _parseSwapEvent(logs);

            // Gross = postFee + fee (this is what vaults receive/pay)
            acc.netGross0 += int256(a0In + f0) - int256(a0Out);
            acc.netGross1 += int256(a1In + f1) - int256(a1Out);
            acc.netPostFee0 += int256(a0In) - int256(a0Out);
            acc.netPostFee1 += int256(a1In) - int256(a1Out);
            acc.totalFee0 += f0;
            acc.totalFee1 += f1;
        }

        // Per-asset vault net position: (deposits - debts) should equal initial + Σ(grossIn - out)
        VaultSnapshot memory finalVault = _vaultSnapshot();

        int256 initNet0 = int256(initVault.deposit0) - int256(initVault.debt0);
        int256 initNet1 = int256(initVault.deposit1) - int256(initVault.debt1);
        int256 finalNet0 = int256(finalVault.deposit0) - int256(finalVault.debt0);
        int256 finalNet1 = int256(finalVault.deposit1) - int256(finalVault.debt1);

        uint256 tolerance = 0;

        assertApproxEqAbs(
            finalNet0,
            initNet0 + acc.netGross0,
            tolerance,
            "Asset0 vault net position mismatch"
        );
        assertApproxEqAbs(
            finalNet1,
            initNet1 + acc.netGross1,
            tolerance,
            "Asset1 vault net position mismatch"
        );

        // The difference between vault net growth and reserve growth should be fees
        int256 vaultGrowth0 = finalNet0 - initNet0;
        int256 reserveGrowth0 = acc.netPostFee0;
        int256 vaultGrowth1 = finalNet1 - initNet1;
        int256 reserveGrowth1 = acc.netPostFee1;

        assertApproxEqAbs(
            uint256(vaultGrowth0 - reserveGrowth0),
            acc.totalFee0,
            tolerance,
            "Asset0: vault - reserve growth should equal fees"
        );
        assertApproxEqAbs(
            uint256(vaultGrowth1 - reserveGrowth1),
            acc.totalFee1,
            tolerance,
            "Asset1: vault - reserve growth should equal fees"
        );

        _logSigned("Asset0 vault growth:", vaultGrowth0);
        _logSigned("Asset0 reserve growth:", reserveGrowth0);
        console.log("Asset0 fees:", acc.totalFee0);
        _logSigned("Asset1 vault growth:", vaultGrowth1);
        _logSigned("Asset1 reserve growth:", reserveGrowth1);
        console.log("Asset1 fees:", acc.totalFee1);
    }

    /// @notice With c=1 (constant-sum), there is NO price impact / curvature.
    /// Every swap exchanges at exactly px/py regardless of reserve displacement.
    /// So NAV growth should equal EXACTLY the total fees — no "curve spread".
    /// This confirms that the surplus in the c=0.5 NAV test comes from curvature.
    function test_accumulator_constant_sum_nav_equals_fees() public {
        // Create constant-sum pool: c=1e18, 1:1 price, 1% fee
        EulerSwap csPool = createEulerSwap(10e18, 10e18, 0.01e18, 1e18, 1e18, 1e18, 1e18);
        IEulerSwap.StaticParams memory csSParams = csPool.getStaticParams();

        // Snapshot
        address account = csSParams.eulerAccount;
        int256 initNav;
        {
            uint256 s0 = IEVault(csSParams.supplyVault0).balanceOf(account);
            uint256 d0 = s0 == 0 ? 0 : IEVault(csSParams.supplyVault0).convertToAssets(s0);
            uint256 s1 = IEVault(csSParams.supplyVault1).balanceOf(account);
            uint256 d1 = s1 == 0 ? 0 : IEVault(csSParams.supplyVault1).convertToAssets(s1);
            uint256 debt0 = IEVault(csSParams.borrowVault0).debtOf(account);
            uint256 debt1 = IEVault(csSParams.borrowVault1).debtOf(account);
            initNav = int256(d0 + d1) - int256(debt0 + debt1);
        }

        uint256 totalFees;

        // 50 balanced swaps (25 each direction) to avoid hitting reserve limits
        for (uint256 i = 0; i < 50; i++) {
            bool asset0In = (i % 2 == 0);
            uint256 size = 0.01e18 + (i % 5) * 0.005e18;

            vm.recordLogs();

            if (asset0In) {
                assetTST.mint(swapper, size);
                vm.prank(swapper);
                assetTST.transfer(address(csPool), size);
                uint256 q = csPool.computeQuote(address(assetTST), address(assetTST2), size, true);
                require(q > 0, "quote zero");
                vm.prank(swapper);
                csPool.swap(0, q, swapper, "");
            } else {
                assetTST2.mint(swapper, size);
                vm.prank(swapper);
                assetTST2.transfer(address(csPool), size);
                uint256 q = csPool.computeQuote(address(assetTST2), address(assetTST), size, true);
                require(q > 0, "quote zero");
                vm.prank(swapper);
                csPool.swap(q, 0, swapper, "");
            }

            Vm.Log[] memory logs = vm.getRecordedLogs();
            (,,,, uint256 f0, uint256 f1) = _parseSwapEvent(logs);
            totalFees += f0 + f1;
        }

        int256 finalNav;
        {
            uint256 s0 = IEVault(csSParams.supplyVault0).balanceOf(account);
            uint256 d0 = s0 == 0 ? 0 : IEVault(csSParams.supplyVault0).convertToAssets(s0);
            uint256 s1 = IEVault(csSParams.supplyVault1).balanceOf(account);
            uint256 d1 = s1 == 0 ? 0 : IEVault(csSParams.supplyVault1).convertToAssets(s1);
            uint256 debt0 = IEVault(csSParams.borrowVault0).debtOf(account);
            uint256 debt1 = IEVault(csSParams.borrowVault1).debtOf(account);
            finalNav = int256(d0 + d1) - int256(debt0 + debt1);
        }

        int256 navGrowth = finalNav - initNav;

        // With constant-sum: NAV growth should equal fees (no curve spread)
        assertApproxEqAbs(
            uint256(navGrowth),
            totalFees,
            0,
            "Constant-sum: NAV growth should equal exactly fees"
        );

        console.log("Constant-sum NAV growth:", uint256(navGrowth));
        console.log("Constant-sum total fees:", totalFees);
        console.log("Difference (should be ~0):", navGrowth > int256(totalFees) ? uint256(navGrowth - int256(totalFees)) : uint256(int256(totalFees) - navGrowth));
    }
}
