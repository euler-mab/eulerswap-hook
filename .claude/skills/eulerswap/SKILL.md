---
name: eulerswap
description: "EulerSwap and Euler protocol reference for implementing onchain LP strategies. Covers pool deployment, hooks, EVC, EVaults, price oracles, orderflow routing, and periphery contracts."
---

# EulerSwap & Euler Protocol Reference

## Source Code Layout

| Submodule | Path | Purpose |
|-----------|------|---------|
| EulerSwap | `contracts/eulerswap/src/` | AMM pool contracts, hooks, factory, registry |
| Euler Vault Kit | `contracts/euler-vault-kit/src/` | EVault lending/borrowing vaults |
| EVC | `contracts/ethereum-vault-connector/src/` | Cross-vault account/operator/safety layer |
| Price Oracle | `contracts/euler-price-oracle/src/` | Modular oracle adapters + router |
| Orderflow Router | `contracts/euler-orderflow-router/src/` | Swap aggregation API + Swapper contract |
| EVK Periphery | `contracts/evk-periphery/src/` | Lens contracts, swap helpers, liquidators |
| Interfaces | `contracts/euler-interfaces/interfaces/` | Canonical interface definitions |

## Architecture Overview

EulerSwap pools are minimal proxies (EIP-3448) deployed via a factory. Each pool:
- Stores **static params** (vaults, owner) in creation code (immutable)
- Stores **dynamic params** (reserves, prices, concentration, fees, hooks) in storage (reconfigurable)
- Integrates with **Euler lending vaults** for capital efficiency (deposit/borrow)
- Supports **hooks** for dynamic fee and releverage strategies
- Can act as a **Uniswap V4 liquidity source** via a hook contract

## Key Contracts

| Contract | Purpose |
|----------|---------|
| `EulerSwap.sol` | Pool instance (delegatecall proxy) |
| `EulerSwapManagement.sol` | Management logic (activate, reconfigure) |
| `EulerSwapFactory.sol` | Deploys pools via CREATE2 |
| `EulerSwapRegistry.sol` | Registry with validity bonds + challenge mechanism |
| `EulerSwapPeriphery.sol` | User-facing router (exactIn/exactOut with slippage) |
| `UniswapHook.sol` | Uniswap V4 integration |
| `LPAgentHook.sol` (in `contracts/src/`) | Example: oracle-based dynamic fee hook |

## Data Structures

### StaticParams (immutable, in creation code)

```solidity
struct StaticParams {
    address supplyVault0;    // Euler vault for asset 0 deposits
    address supplyVault1;    // Euler vault for asset 1 deposits
    address borrowVault0;    // Euler vault for asset 0 borrowing (address(0) = disabled)
    address borrowVault1;    // Euler vault for asset 1 borrowing (address(0) = disabled)
    address eulerAccount;    // EVC account that owns the pool
    address feeRecipient;    // LP fee recipient (address(0) = fees stay in vault)
}
```

### DynamicParams (reconfigurable, in storage)

```solidity
struct DynamicParams {
    uint112 equilibriumReserve0;   // x₀ — equilibrium reserve of asset 0
    uint112 equilibriumReserve1;   // y₀ — equilibrium reserve of asset 1
    uint112 minReserve0;           // floor reserve for asset 0
    uint112 minReserve1;           // floor reserve for asset 1
    uint80  priceX;                // px — price scalar for asset 0 (1e18 scale)
    uint80  priceY;                // py — price scalar for asset 1 (1e18 scale)
    uint64  concentrationX;        // cx — curve flatness [0, 1e18]. 0=xy=k, 1e18=constant-sum
    uint64  concentrationY;        // cy — curve flatness [0, 1e18]
    uint64  fee0;                  // fee on asset 0 input (1e18 scale)
    uint64  fee1;                  // fee on asset 1 input (1e18 scale)
    uint40  expiration;            // Unix timestamp, 0 = no expiry
    uint8   swapHookedOperations;  // Bitmask: BEFORE_SWAP=0x01, GET_FEE=0x02, AFTER_SWAP=0x04
    address swapHook;              // Hook contract address
}
```

### Mapping: UI params → contract params

| UI / TS param | Contract field | Scale | Notes |
|---------------|---------------|-------|-------|
| `xr` (real deposit X) | `equilibriumReserve0` | token units | After boost computation |
| `yr` (real deposit Y) | `equilibriumReserve1` | token units | After boost computation |
| `px` | `priceX` | 1e18 | `px * 1e18` |
| `py` | `priceY` | 1e18 | `py * 1e18` |
| `cx` | `concentrationX` | 1e18 | `cx * 1e18` (0.5 → 0.5e18) |
| `cy` | `concentrationY` | 1e18 | `cy * 1e18` |
| `feeBps` | `fee0` / `fee1` | 1e18 | `feeBps * 1e14` (30 bps → 0.003e18) |
| `rx` | — | — | Determines price range: `pUpper = (px/py) × (1 + rx)` |
| `ry` | — | — | Determines price range: `pLower = (px/py) / (1 + ry)` |

The `rx`/`ry` params don't map directly to a single contract field — they determine the equilibrium reserves and min reserves together with the deposit amounts. The `minReserve` fields enforce the price boundaries.

## Pool Lifecycle

### 1. Deploy a Pool

```solidity
// Via factory (caller must be eulerAccount)
address pool = factory.deployPool(
    StaticParams({
        supplyVault0: vaultETH,
        supplyVault1: vaultUSDC,
        borrowVault0: vaultETH,   // address(0) to disable leverage
        borrowVault1: vaultUSDC,
        eulerAccount: msg.sender,
        feeRecipient: feeAddr
    }),
    DynamicParams({
        equilibriumReserve0: 10e18,        // 10 ETH
        equilibriumReserve1: 20000e6,      // 20,000 USDC
        minReserve0: 0,
        minReserve1: 0,
        priceX: 2000e18,                   // ETH = $2000
        priceY: 1e18,                      // USDC = $1
        concentrationX: 0.5e18,            // cx = 0.5
        concentrationY: 0.5e18,            // cy = 0.5
        fee0: 0.003e18,                    // 30 bps
        fee1: 0.003e18,
        expiration: 0,
        swapHookedOperations: 0,
        swapHook: address(0)
    }),
    InitialState({
        reserve0: 10e18,
        reserve1: 20000e6
    }),
    salt
);
```

The factory calls `pool.activate()` which:
1. Validates vault/asset consistency
2. Stores dynamic params + initial reserves
3. Approves vaults for token transfers
4. Enables collateral if borrow vaults are set
5. Activates Uniswap V4 hook if applicable
6. Sets pool status to unlocked

### 2. Reconfigure a Pool

```solidity
// Only callable by eulerAccount, manager, or swapHook
pool.reconfigure(newDynamicParams, newInitialState);
```

This allows changing prices, concentration, fees, range, and hook — without redeploying. The hook's `afterSwap` callback can call `reconfigure()` to implement releverage.

### 3. Execute Swaps

**Direct (flash-swap pattern):**
```solidity
// Request output first, then provide input in callback
pool.swap(amount0Out, amount1Out, to, callbackData);

// In your callback:
function eulerSwapCall(
    address sender,
    uint256 amount0,  // amount0 owed
    uint256 amount1,  // amount1 owed
    bytes calldata data
) external {
    // Transfer owed tokens to pool
    IERC20(asset).transfer(msg.sender, amountOwed);
}
```

**Via Periphery (recommended for users):**
```solidity
// Exact input with slippage protection
periphery.swapExactIn(pool, tokenIn, tokenOut, amountIn, receiver, amountOutMin, deadline);

// Exact output
periphery.swapExactOut(pool, tokenIn, tokenOut, amountOut, receiver, amountInMax, deadline);
```

**Quoting:**
```solidity
uint256 out = pool.computeQuote(tokenIn, tokenOut, amountIn, true);  // exactIn
uint256 in_ = pool.computeQuote(tokenIn, tokenOut, amountOut, false); // exactOut
(uint256 inLimit, uint256 outLimit) = pool.getLimits(tokenIn, tokenOut);
```

### Swap Flow (internal)

```
swap(amount0Out, amount1Out, to, data)
  → invokeBeforeSwapHook()         // if BEFORE_SWAP flag set
  → withdraw outputs from vaults
  → eulerSwapCall() callback       // caller provides input tokens
  → measure inputs, apply fees
  → doDeposit: repay debt first, then deposit to vault
  → CurveLib.verify()              // assert new reserves satisfy invariant
  → emit Swap event
  → invokeAfterSwapHook()          // if AFTER_SWAP flag set (pool UNLOCKED)
```

## Hook System

Hooks enable dynamic strategies. Set `swapHookedOperations` bitmask and `swapHook` address.

### Hook Operations

```solidity
EULER_SWAP_HOOK_BEFORE_SWAP = 0x01  // Validate/block swaps
EULER_SWAP_HOOK_GET_FEE     = 0x02  // Dynamic fee pricing
EULER_SWAP_HOOK_AFTER_SWAP  = 0x04  // Post-swap actions (releverage, rebalance)
```

### Hook Interface

```solidity
interface IEulerSwapHookTarget {
    // Gate swaps (revert to block)
    function beforeSwap(
        uint256 amount0Out, uint256 amount1Out,
        address msgSender, address to
    ) external;

    // Return dynamic fee (WAD scale). Return type(uint64).max to use static fee.
    function getFee(
        bool asset0IsInput,
        uint112 reserve0, uint112 reserve1,
        bool readOnly  // true when called from computeQuote
    ) external returns (uint64 fee);

    // Post-swap callback. Pool is UNLOCKED — can call reconfigure().
    function afterSwap(
        uint256 amount0In, uint256 amount1In,
        uint256 amount0Out, uint256 amount1Out,
        uint256 fee0, uint256 fee1,
        address msgSender, address to,
        uint112 reserve0, uint112 reserve1
    ) external;
}
```

### Releverage Strategy via afterSwap

The discrete releverage strategy simulated in `yieldBasisSim.ts` works like this onchain:

```solidity
function afterSwap(
    uint256 amount0In, uint256 amount1In,
    uint256 amount0Out, uint256 amount1Out,
    uint256 fee0, uint256 fee1,
    address, address,
    uint112 reserve0, uint112 reserve1
) external {
    // 1. Read current reserves (post-swap)
    // 2. Compute new equilibrium at current price
    // 3. Reconfigure pool to re-center around current price
    //    This effectively "re-leverages" — the pool always acts as if
    //    freshly deployed at the current price with L=2 leverage.

    DynamicParams memory dp = pool.getDynamicParams();
    // Update equilibrium reserves to current position
    dp.equilibriumReserve0 = reserve0;
    dp.equilibriumReserve1 = reserve1;

    pool.reconfigure(dp, InitialState(reserve0, reserve1));
}
```

Key insight: the afterSwap hook fires with the pool **unlocked**, so `reconfigure()` succeeds. This is how you build continuous releverage without external keepers.

### Dynamic Fee Strategy (LPAgentHook pattern)

See `contracts/src/LPAgentHook.sol` for a complete example:

```solidity
function getFee(
    bool asset0IsInput,
    uint112 reserve0, uint112 reserve1,
    bool readOnly
) external returns (uint64 fee) {
    // 1. Get oracle price
    uint256 oraclePrice = getOraclePrice();

    // 2. Compute pool marginal price from reserves
    uint256 marginalPrice = uint256(reserve1) * 1e18 / reserve0;

    // 3. Compute mismatch
    uint256 mismatch = oraclePrice > marginalPrice
        ? (oraclePrice - marginalPrice) * 1e18 / oraclePrice
        : (marginalPrice - oraclePrice) * 1e18 / oraclePrice;

    // 4. Asymmetric fee: charge more on underpriced side
    uint256 rawFee = baseFee + mismatch * mismatchScale / 1e18;

    // 5. Clamp to [minFee, maxFee]
    return uint64(rawFee > maxFee ? maxFee : rawFee < minFee ? minFee : rawFee);
}
```

## Leverage via Euler Vaults

When `borrowVault0` or `borrowVault1` is set (non-zero), the pool can borrow:

**How it works internally (`FundsLib`):**
- **Withdraw**: first tries supply vault. If insufficient, enables controller + borrows from borrow vault.
- **Deposit**: if controller enabled, repays debt first (up to deposit amount). Then deposits remainder. Auto-disables controller when debt fully repaid.

**For leveraged LP positions:**
1. Deploy pool with both supply and borrow vaults
2. Set equilibrium reserves larger than actual deposits (virtual > real)
3. The pool borrows the difference when the price moves
4. LLTVs are managed at the Euler vault level, not in EulerSwap

## Registry & Validity Bonds

Pools can be registered for discoverability:

```solidity
// Register (requires validity bond in ETH)
registry.registerPool{value: bond}(poolAddress);

// Unregister (returns bond)
registry.unregisterPool();

// Challenge a broken pool (earns bond if pool can't service swaps)
registry.challengePool(pool, tokenIn, tokenOut, amount, exactIn, recipient);
```

The challenge mechanism catches pools where swaps fail due to `AccountLiquidity` (health) or `HookError` — meaning the pool is configured incorrectly or is undercollateralized.

## Curve Math

The invariant is a concentration-weighted blend of constant-product and constant-sum:

```
y = y₀ + (px × (x₀ - x) × (cx × x + (1 - cx) × x₀)) / (x × py)
```

- `cx = 0`: reduces to constant-product (`xy = k`)
- `cx = 1e18`: reduces to constant-sum (linear, infinite depth)
- `0 < cx < 1e18`: blended curve with tunable flatness

**Piecewise structure**: the curve has two branches meeting at equilibrium (x₀, y₀):
- X branch: `x ≤ x₀` (price above equilibrium)
- Y branch: `y ≤ y₀` (price below equilibrium), uses `cy` instead of `cx`

**Price at position**: `p = (px/py) × (cx + (1-cx) × (x₀/x)²)`

**Boundary prices**:
- Upper: `pUpper = (px/py) × (1 + rx)` (at x = xb, the X boundary)
- Lower: `pLower = (px/py) / (1 + ry)` (at y = yb, the Y boundary)

## Events

```solidity
// On every swap
event Swap(address indexed sender, uint256 amount0In, uint256 amount1In,
           uint256 amount0Out, uint256 amount1Out, uint256 fee0, uint256 fee1,
           uint112 reserve0, uint112 reserve1, address indexed to);

// On pool configuration
event EulerSwapConfigured(DynamicParams dParams, InitialState initialState);
event EulerSwapManagerSet(address indexed manager, bool installed);

// Factory
event PoolDeployed(address indexed asset0, address indexed asset1,
                   address indexed eulerAccount, address pool, StaticParams sParams);
```

## Common Errors

| Error | Meaning |
|-------|---------|
| `CurveViolation()` | Swap would break the invariant |
| `SwapLimitExceeded()` | Amount exceeds vault capacity |
| `SwapRejected()` | Fee ≥ 100% |
| `Unauthorized()` | Caller not owner/manager/hook |
| `Expired()` | Pool past expiration timestamp |
| `OperatorNotInstalled()` | Pool not authorized in EVC |

## Strategy Patterns

### Static LP
Deploy pool with desired `rx`, `ry`, `cx`, `cy`. Collect fees passively. No hooks needed.

### Discrete Releverage (afterSwap hook)
Set `swapHookedOperations = AFTER_SWAP`. Hook calls `reconfigure()` to re-center after every swap. Achieves L=2 leverage with residual IL ≈ σ²T/4.

### Dynamic Fee (getFee hook)
Set `swapHookedOperations = GET_FEE`. Hook reads oracle, computes fee based on price mismatch. Charge more on the underpriced side to extract MEV.

### Combined (getFee + afterSwap)
Set `swapHookedOperations = GET_FEE | AFTER_SWAP`. Dynamic fees + releverage. This is the "Yield Basis" ideal — high fees on arb, low fees on retail, continuous re-centering.

### Time-Decay Fee
Hook tracks last swap timestamp. Fee starts high after reconfiguration (capturing arb value), decays to base fee over τ seconds (attracting retail). Simulated as `dynamicFee` in `yieldBasisSim.ts`.

---

## Ethereum Vault Connector (EVC)

Source: `contracts/ethereum-vault-connector/src/EthereumVaultConnector.sol`

The EVC is the security middleware that enables cross-vault atomic operations.

### Sub-Account System

Each address has 256 sub-accounts sharing the same owner (first 19 bytes):
```
Owner:           0x1234...7890
Sub-account 0:   0x1234...7800  (main)
Sub-account 1:   0x1234...7801
Sub-account 255: 0x1234...78ff
```

### Core Operations

```solidity
// Batch: atomic multi-contract calls (the primary integration pattern)
evc.batch(BatchItem[] items);
// Each BatchItem: { targetContract, onBehalfOfAccount, value, data }

// Operators: authorize contracts to act on your behalf
evc.setAccountOperator(account, operator, true);

// Collateral: enable vaults as collateral sources
evc.enableCollateral(account, vaultAddress);

// Controllers: enable vaults that manage your debt
evc.enableController(account, vaultAddress);

// Call through EVC (sets execution context + defers checks)
evc.call(targetContract, onBehalfOfAccount, value, data);
```

### Deferred Status Checks

Operations within an EVC batch defer health checks until the outermost call completes. This enables multi-step strategies (withdraw → swap → deposit → borrow) that would fail if checked individually.

### `callThroughEVC` Pattern

EulerSwap's `swap()` uses `callThroughEVC` modifier — it routes through EVC to set execution context, authenticate the caller, and defer checks. All vault-touching operations go through EVC.

### Permits (Meta-Transactions)

```solidity
evc.permit(signer, sender, nonceNamespace, nonce, deadline, value, data, signature);
// EIP-712 signed transactions — enables gasless operations
```

---

## Euler Vaults (EVault)

Source: `contracts/euler-vault-kit/src/EVault/`

ERC4626-compliant lending vaults with modular architecture (Token, Vault, Borrowing, RiskManager, Liquidation, Governance modules).

### Core Operations

```solidity
// Deposit (supply assets, receive eTokens)
uint256 shares = vault.deposit(amount, receiver);

// Withdraw
uint256 assets = vault.withdraw(amount, receiver, owner);

// Borrow (requires controller enabled via EVC)
uint256 borrowed = vault.borrow(amount, receiver);

// Repay
uint256 repaid = vault.repay(amount, borrower);
// amount = type(uint256).max → repay full debt

// Flash loan
vault.flashLoan(amount, data);
// Callback: onFlashLoan(data) — must repay before returning
```

### Interest Accrual

Debt accrues continuously via a global interest accumulator:
```
currentDebt = originalDebt × (globalAccumulator / userAccumulator)
```
No per-user updates needed — the accumulator scales all debts automatically.

### LLTVs (Two-Tier System)

```solidity
vault.setLTV(collateral, borrowLTV, liquidationLTV, rampDuration);
// borrowLTV:      used for health checks (stricter)
// liquidationLTV: used for liquidation eligibility (more relaxed)
// rampDuration:   gradual LTV reduction over time (seconds)
```

Health: `collateralValue × borrowLTV ≥ liabilityValue`
Liquidatable: `collateralValue × liquidationLTV < liabilityValue`

### Health & Liquidation

```solidity
// Check account health
(uint256 collateralValue, uint256 liabilityValue) = vault.accountLiquidity(account, false);

// Check liquidation eligibility
(uint256 maxRepay, uint256 maxYield) = vault.checkLiquidation(liquidator, violator, collateral);

// Execute liquidation
vault.liquidate(violator, collateral, repayAmount, minYield);
```

### How EulerSwap Uses Vaults (FundsLib)

When a swap moves the price:
1. **Withdraw output**: tries supply vault first; if insufficient, borrows from borrow vault
2. **Deposit input**: repays outstanding debt first; deposits remainder to supply vault
3. Auto-enables/disables controller based on debt state

---

## Price Oracles

Source: `contracts/euler-price-oracle/src/`

### Interface

```solidity
interface IPriceOracle {
    // Mid-price: how much quote for inAmount of base
    function getQuote(uint256 inAmount, address base, address quote) returns (uint256);

    // Bid/ask: conservative pricing for lending
    function getQuotes(uint256 inAmount, address base, address quote)
        returns (uint256 bidOut, uint256 askOut);
}
```

### EulerRouter (Oracle Dispatcher)

Governable router that maps token pairs to oracle adapters:
```solidity
router.govSetConfig(base, quote, oracleAdapter);    // Set adapter for pair
router.govSetResolvedVault(vault, true);             // Enable ERC4626 share→asset resolution
router.govSetFallbackOracle(fallbackOracle);         // Default for unconfigured pairs
```

Resolution order: direct mapping → ERC4626 vault recursion → fallback oracle.

### Available Adapters

| Adapter | Type | Source |
|---------|------|--------|
| `ChainlinkOracle` | Push | Chainlink feeds, configurable `maxStaleness` |
| `UniswapV3Oracle` | Push | Uniswap V3 TWAP, configurable `twapWindow` (min 5min) |
| `PythOracle` | Pull | Pyth Network, `maxStaleness` + `maxConfWidth` |
| `RedstoneCoreOracle` | Pull | Redstone, signature verification |
| `ChronicleOracle` | Push | Chronicle (ex-Maker) feeds |
| `LidoOracle` | On-chain | stETH ↔ wstETH exchange rate |
| `PendleOracle` | On-chain | Pendle PT TWAP |
| `CrossAdapter` | Composite | Chain two oracles: X/Z = (X/Y) × (Y/Z) |
| `FixedRateOracle` | Static | Constant exchange rate |

### Using Oracles in Hooks

```solidity
// In a getFee hook — compare oracle vs pool price
uint256 oraclePrice = IPriceOracle(oracle).getQuote(1e18, asset0, asset1);
uint256 poolPrice = uint256(reserve1) * 1e18 / reserve0;
uint256 mismatch = abs(oraclePrice - poolPrice) * 1e18 / oraclePrice;
// Set fee proportional to mismatch
```

For pull-based oracles (Pyth/Redstone), update price feeds atomically in the same EVC batch before querying.

---

## Orderflow Router

Source: `contracts/euler-orderflow-router/src/`

A swap aggregation API that routes through 20+ DEX sources via the Balmy SDK.

### Swapper Contract (On-Chain)

The untrusted swap executor used by the router:

```solidity
// Key functions
swapper.swap(SwapParams params);           // Execute swap via handler
swapper.deposit(token, vault, minAmt, account);   // Deposit to vault
swapper.repay(token, vault, amount, account);      // Repay vault debt
swapper.repayAndDeposit(token, vault, amt, account); // Combined
swapper.sweep(token, minAmt, to);          // Recover remaining tokens
swapper.multicall(bytes[] calls);          // Batch all above

// SwapParams
struct SwapParams {
    bytes32 handler;        // HANDLER_GENERIC, HANDLER_UNISWAP_V2, HANDLER_UNISWAP_V3
    uint256 mode;           // 0=EXACT_IN, 1=EXACT_OUT, 2=TARGET_DEBT
    address account;        // Sub-account
    address tokenIn/tokenOut;
    address vaultIn/receiver;
    uint256 amountOut;
    bytes data;             // Handler-specific calldata
}
```

### SwapVerifier Contract (On-Chain)

Trusted post-swap validation:
```solidity
verifier.verifyAmountMinAndSkim(vault, account, amountMin, deadline);
verifier.verifyDebtMax(vault, account, amountMax, deadline);
```

### Typical Swap Transaction (EVC Batch)

```solidity
evc.batch([
    // 1. Withdraw from supply vault
    { target: vault, data: withdraw(amount, swapper, account) },
    // 2. Execute swap + deposit result
    { target: swapper, data: multicall([swap(...), deposit(...)]) },
    // 3. Verify slippage
    { target: verifier, data: verifyAmountMinAndSkim(vault, account, minOut, deadline) }
]);
```

---

## EVK Periphery

Source: `contracts/evk-periphery/src/`

### Lens Contracts (Read-Only Views)

| Lens | Key Functions |
|------|---------------|
| `VaultLens` | `getVaultInfoFull()` — complete vault state (balances, rates, LTVs, oracle, caps) |
| `AccountLens` | `getAccountInfo()`, `getAccountLiquidityInfo()`, `getTimeToLiquidation()` |
| `OracleLens` | `getOracleInfo()` — oracle type detection, staleness checks |
| `UtilsLens` | `getAPYs()`, `getControllerAssetPriceInfo()`, `tokenBalances()` |
| `IRMLens` | `getInterestRateModelInfo()` — parse IRM type and parameters |

### Liquidation Helpers

```solidity
// Extend for custom liquidation logic
abstract contract CustomLiquidatorBase {
    function liquidate(vault, violator, collateral, repayAmount, minYield);
    function _customLiquidation(...) virtual; // Override point
}
```

### Interest Rate Models

| IRM | Description |
|-----|-------------|
| `IRMLinearKink` | Piecewise linear with kink at target utilization |
| `IRMAdaptiveCurve` | Dynamic rate adjustment toward target utilization |
| `IRMLinearKinky` | Smooth exponential curve |
| `IRMFixedCyclicalBinary` | Alternates between two rates on schedule |

---

## End-to-End Strategy Example

### Deploying a Releverage Pool with Dynamic Fees

```solidity
// 1. Deploy hook contract
LPAgentHook hook = new LPAgentHook(oracle, pool, baseFee, maxFee, minFee, scale);

// 2. Deploy pool via factory
address pool = factory.deployPool(
    StaticParams({
        supplyVault0: eWETH, supplyVault1: eUSDC,
        borrowVault0: eWETH, borrowVault1: eUSDC,  // enable leverage
        eulerAccount: myAccount,
        feeRecipient: address(hook)  // hook collects fees
    }),
    DynamicParams({
        equilibriumReserve0: 10e18, equilibriumReserve1: 20000e6,
        minReserve0: 0, minReserve1: 0,
        priceX: 2000e18, priceY: 1e18,
        concentrationX: 0.9e18, concentrationY: 0.9e18,  // high concentration
        fee0: 0.003e18, fee1: 0.003e18,                  // fallback fee
        expiration: 0,
        swapHookedOperations: 0x06,  // GET_FEE | AFTER_SWAP
        swapHook: address(hook)
    }),
    InitialState({ reserve0: 10e18, reserve1: 20000e6 }),
    salt
);

// 3. Register in registry
registry.registerPool{value: bond}(pool);

// The hook now:
// - getFee: charges high fees on arb (price mismatch), low on retail
// - afterSwap: re-centers pool (releverage) after every swap
```

### Reading Position State

```solidity
// Via periphery lens
VaultInfoFull memory info = vaultLens.getVaultInfoFull(eUSDC);
AccountLiquidityInfo memory liq = accountLens.getAccountLiquidityInfo(eUSDC, myAccount);

// Direct
(uint112 r0, uint112 r1, uint32 status) = pool.getReserves();
DynamicParams memory dp = pool.getDynamicParams();
uint256 quote = pool.computeQuote(WETH, USDC, 1e18, true); // 1 ETH → ? USDC
```
