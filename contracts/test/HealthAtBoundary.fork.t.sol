// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console2 as console} from "forge-std/Test.sol";
import {IEulerSwap} from "../eulerswap/src/interfaces/IEulerSwap.sol";
import {EulerSwapPeriphery} from "../eulerswap/src/EulerSwapPeriphery.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IEVault {
    function accountLiquidity(address, bool) external view returns (uint256 collateralValue, uint256 liabilityValue);
    function accountLiquidityFull(address, bool)
        external
        view
        returns (address[] memory collaterals, uint256[] memory collateralValues, uint256 liabilityValue);
    function debtOf(address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
}

interface IPriceOracle {
    function getQuote(uint256 amount, address base, address quote) external view returns (uint256);
}

/// @notice Mock oracle: getQuote(amount, base, _) = price[base] * amount / 1e18
///         Also supports getQuotes (returns bid=ask).
contract MockOracle {
    mapping(address => uint256) public prices; // slot 0

    function getQuote(uint256 amount, address base, address /* quote */ ) external view returns (uint256) {
        uint256 p = prices[base];
        require(p > 0, "MockOracle: unknown token");
        return p * amount / 1e18;
    }

    function getQuotes(uint256 amount, address base, address quote)
        external
        view
        returns (uint256 bidOut, uint256 askOut)
    {
        uint256 out = this.getQuote(amount, base, quote);
        return (out, out);
    }
}

/// @title HealthAtBoundary — Fork test: verify vault health at pool price boundaries
/// @notice Mocks oracle to boundary prices, executes max swaps.
///         The EVC health check runs during the swap. If it passes → health ≥ 1.
///         Also reads accountLiquidity for the exact health ratio.
contract HealthAtBoundaryTest is Test {
    // Pools
    address constant USDC_WETH_POOL = 0x4311031739918Aba578C3C667DA3028A12Ce28A8;
    address constant USDC_USDT_POOL = 0x719529e99b7b272c5ef4CE07C30d15BC57CD68A8;

    // Sub-accounts
    address constant USDC_WETH_SUB = 0x2909bCc87c17d8Be263621bF087bC806BA313BFE;
    address constant USDC_USDT_SUB = 0x2909BCc87c17D8be263621bf087Bc806ba313BFf;

    // Tokens
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    // Vaults
    address constant USDC_VAULT = 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9;
    address constant WETH_VAULT = 0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2;
    address constant USDT_VAULT = 0x313603FA690301b0CaeEf8069c065862f9162162;

    // Oracle
    address constant ORACLE = 0x83B3b76873D36A28440cF53371dF404c42497136;
    address constant UOA = address(0x348);

    EulerSwapPeriphery periphery;

    // Cached oracle prices (per 1e18 of token/vault-share in UoA)
    uint256 wethPrice;
    uint256 usdcPrice;
    uint256 usdtPrice;
    uint256 wethVaultPrice;
    uint256 usdcVaultPrice;
    uint256 usdtVaultPrice;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        periphery = new EulerSwapPeriphery();

        // Cache current oracle prices for underlying tokens
        wethPrice = IPriceOracle(ORACLE).getQuote(1e18, WETH, UOA);
        usdcPrice = IPriceOracle(ORACLE).getQuote(1e18, USDC, UOA);
        usdtPrice = IPriceOracle(ORACLE).getQuote(1e18, USDT, UOA);

        // Cache oracle prices for vault shares (health check queries vaults, not tokens)
        wethVaultPrice = IPriceOracle(ORACLE).getQuote(1e18, WETH_VAULT, UOA);
        usdcVaultPrice = IPriceOracle(ORACLE).getQuote(1e18, USDC_VAULT, UOA);
        usdtVaultPrice = IPriceOracle(ORACLE).getQuote(1e18, USDT_VAULT, UOA);

        console.log("WETH price:", wethPrice);
        console.log("USDC price:", usdcPrice);
        console.log("USDT price:", usdtPrice);
        console.log("WETH vault share price:", wethVaultPrice);
        console.log("USDC vault share price:", usdcVaultPrice);
        console.log("USDT vault share price:", usdtVaultPrice);
    }

    // ======== USDC/WETH pool: ±5% range ========

    /// @notice Y-boundary: sell USDC → buy max WETH. Market: ETH up 5%.
    function test_usdcWeth_yBoundary_ethUp5pct() public {
        console.log("");
        console.log("=== USDC/WETH Y-boundary: sell USDC -> buy WETH (ETH +5%) ===");

        (uint256 inLimit,) = IEulerSwap(USDC_WETH_POOL).getLimits(USDC, WETH);
        console.log("Max USDC in:", inLimit);

        // Mock oracle: WETH +5% (vault shares scale proportionally)
        _mockOracle(
            wethPrice * 105 / 100,
            usdcPrice,
            usdtPrice,
            wethVaultPrice * 105 / 100,
            usdcVaultPrice,
            usdtVaultPrice
        );

        deal(USDC, address(this), inLimit);
        IERC20Min(USDC).approve(address(periphery), inLimit);
        periphery.swapExactIn(USDC_WETH_POOL, USDC, WETH, inLimit, address(this), 0, block.timestamp + 100);
        console.log("Swap succeeded! EVC health check passed.");

        _logAllHealth(USDC_WETH_SUB, USDC_VAULT, WETH_VAULT, "USDC", "WETH");
    }

    /// @notice X-boundary: sell WETH → buy max USDC. Market: ETH down 5%.
    function test_usdcWeth_xBoundary_ethDown5pct() public {
        console.log("");
        console.log("=== USDC/WETH X-boundary: sell WETH -> buy USDC (ETH -5%) ===");

        (uint256 inLimit,) = IEulerSwap(USDC_WETH_POOL).getLimits(WETH, USDC);
        console.log("Max WETH in:", inLimit);

        // Mock oracle: WETH -5% (= × 100/105)
        _mockOracle(
            wethPrice * 100 / 105,
            usdcPrice,
            usdtPrice,
            wethVaultPrice * 100 / 105,
            usdcVaultPrice,
            usdtVaultPrice
        );

        deal(WETH, address(this), inLimit);
        IERC20Min(WETH).approve(address(periphery), inLimit);
        periphery.swapExactIn(USDC_WETH_POOL, WETH, USDC, inLimit, address(this), 0, block.timestamp + 100);
        console.log("Swap succeeded! EVC health check passed.");

        _logAllHealth(USDC_WETH_SUB, USDC_VAULT, WETH_VAULT, "USDC", "WETH");
    }

    // ======== USDC/USDT pool: ±1% range ========

    /// @notice Y-boundary: sell USDC → buy max USDT. Market: USDT up 1%.
    function test_usdcUsdt_yBoundary_usdtUp1pct() public {
        console.log("");
        console.log("=== USDC/USDT Y-boundary: sell USDC -> buy USDT (USDT +1%) ===");

        (uint256 inLimit,) = IEulerSwap(USDC_USDT_POOL).getLimits(USDC, USDT);
        console.log("Max USDC in:", inLimit);

        _mockOracle(
            wethPrice,
            usdcPrice,
            usdtPrice * 101 / 100,
            wethVaultPrice,
            usdcVaultPrice,
            usdtVaultPrice * 101 / 100
        );

        deal(USDC, address(this), inLimit);
        IERC20Min(USDC).approve(address(periphery), inLimit);
        periphery.swapExactIn(USDC_USDT_POOL, USDC, USDT, inLimit, address(this), 0, block.timestamp + 100);
        console.log("Swap succeeded! EVC health check passed.");

        _logAllHealth(USDC_USDT_SUB, USDC_VAULT, USDT_VAULT, "USDC", "USDT");
    }

    /// @notice X-boundary: sell USDT → buy max USDC. Market: USDT down 1%.
    function test_usdcUsdt_xBoundary_usdtDown1pct() public {
        console.log("");
        console.log("=== USDC/USDT X-boundary: sell USDT -> buy USDC (USDT -1%) ===");

        (uint256 inLimit,) = IEulerSwap(USDC_USDT_POOL).getLimits(USDT, USDC);
        console.log("Max USDT in:", inLimit);

        _mockOracle(
            wethPrice,
            usdcPrice,
            usdtPrice * 100 / 101,
            wethVaultPrice,
            usdcVaultPrice,
            usdtVaultPrice * 100 / 101
        );

        deal(USDT, address(this), inLimit);
        // USDT approve doesn't return bool — use low-level call
        (bool ok,) = USDT.call(abi.encodeWithSelector(IERC20Min.approve.selector, address(periphery), uint256(0)));
        require(ok, "USDT approve(0) failed");
        (ok,) = USDT.call(abi.encodeWithSelector(IERC20Min.approve.selector, address(periphery), inLimit));
        require(ok, "USDT approve failed");
        periphery.swapExactIn(USDC_USDT_POOL, USDT, USDC, inLimit, address(this), 0, block.timestamp + 100);
        console.log("Swap succeeded! EVC health check passed.");

        _logAllHealth(USDC_USDT_SUB, USDC_VAULT, USDT_VAULT, "USDC", "USDT");
    }

    // ======== Helpers ========

    function _mockOracle(
        uint256 _weth,
        uint256 _usdc,
        uint256 _usdt,
        uint256 _wethVault,
        uint256 _usdcVault,
        uint256 _usdtVault
    ) internal {
        MockOracle mock = new MockOracle();
        vm.etch(ORACLE, address(mock).code);

        // Set prices for underlying tokens (slot 0 mapping)
        vm.store(ORACLE, keccak256(abi.encode(WETH, uint256(0))), bytes32(_weth));
        vm.store(ORACLE, keccak256(abi.encode(USDC, uint256(0))), bytes32(_usdc));
        vm.store(ORACLE, keccak256(abi.encode(USDT, uint256(0))), bytes32(_usdt));

        // Set prices for vault shares (health check queries vault address, not underlying)
        vm.store(ORACLE, keccak256(abi.encode(WETH_VAULT, uint256(0))), bytes32(_wethVault));
        vm.store(ORACLE, keccak256(abi.encode(USDC_VAULT, uint256(0))), bytes32(_usdcVault));
        vm.store(ORACLE, keccak256(abi.encode(USDT_VAULT, uint256(0))), bytes32(_usdtVault));

        // Verify key prices
        assertEq(IPriceOracle(ORACLE).getQuote(1e18, WETH, UOA), _weth, "WETH mock");
        assertEq(IPriceOracle(ORACLE).getQuote(1e18, USDC_VAULT, UOA), _usdcVault, "USDC vault mock");
    }

    function _logAllHealth(address sub, address vault0, address vault1, string memory name0, string memory name1)
        internal
        view
    {
        _logHealth(name0, vault0, sub);
        _logHealth(name1, vault1, sub);
    }

    function _logHealth(string memory label, address vault, address account) internal view {
        try IEVault(vault).accountLiquidity(account, false) returns (uint256 col, uint256 liab) {
            if (liab == 0) {
                console.log(label, "vault: no debt");
            } else {
                console.log(label, "vault col:", col);
                console.log(label, "vault liab:", liab);
                uint256 healthBps = col * 10000 / liab;
                console.log(label, "vault health (bps):", healthBps);
            }
        } catch {
            console.log(label, "vault: no controller (no debt)");
        }
    }
}
