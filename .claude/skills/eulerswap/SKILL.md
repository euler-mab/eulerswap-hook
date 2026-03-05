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
    uint80  priceX;                // px — price numerator (must encode decimal adjustment)
    uint80  priceY;                // py — price denominator (see Token Decimals section)
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
| `px` | `priceX` | uint80 | Must include decimal adjustment: `humanPrice × 10^(dec1−dec0)` scaled |
| `py` | `priceY` | uint80 | Denominator of price ratio. See Token Decimals section |
| `cx` | `concentrationX` | 1e18 | `cx * 1e18` (0.5 → 0.5e18) |
| `cy` | `concentrationY` | 1e18 | `cy * 1e18` |
| `feeBps` | `fee0` / `fee1` | 1e18 | `feeBps * 1e14` (30 bps → 0.003e18) |
| `rx` | — | — | Determines price range: `pUpper = (px/py) × (1 + rx)` |
| `ry` | — | — | Determines price range: `pLower = (px/py) / (1 + ry)` |

The `rx`/`ry` params don't map directly to a single contract field — they determine the equilibrium reserves and min reserves together with the deposit amounts. The `minReserve` fields enforce the price boundaries.

## Token Decimals

Reserves and amounts are always in **native token decimals** (1 ETH = `1e18`, 1 USDC = `1e6`, 1 WBTC = `1e8`). The `priceX`/`priceY` parameters must account for both the economic price AND the decimal difference between assets.

### priceX / priceY — decimal-adjusted price ratio

The curve formula converts asset X amounts to asset Y amounts via `(x0 - x) * priceX / priceY`. Since `x` is in asset0's native decimals and the result must be in asset1's native decimals, the ratio must embed decimal scaling:

```
priceX / priceY = humanPrice × 10^(decimals1 - decimals0)
```

Where `humanPrice` is "how many human units of asset1 per 1 human unit of asset0."

| Pair (asset0/asset1) | Human Price | dec0 | dec1 | priceX | priceY | Ratio |
|----------------------|-------------|------|------|--------|--------|-------|
| ETH / USDC | 2000 | 18 | 6 | `2000e6` | `1e18` | 2e-9 |
| WBTC / USDC | 60000 | 8 | 6 | `60000` | `100` | 600 |
| USDC / USDT | 1 | 6 | 6 | `1e18` | `1e18` | 1 |
| USDC / DAI | 1 | 6 | 18 | `1e18` | `1e6` | 1e12 |
| wstETH / ETH | 1.15 | 18 | 18 | `1.15e18` | `1e18` | 1.15 |

**Verification**: for ETH/USDC, swap 1 ETH: `v = 1e18 × 2000e6 / 1e18 = 2000e6` (2000 USDC) ✓

**Bounds**: `priceX` and `priceY` are `uint80` values in range `[1, 1e24]`.

### Oracle prices — fully decimal-aware

`IPriceOracle.getQuote(inAmount, base, quote)` handles decimals automatically via `ScaleUtils`:
- `inAmount` is in **base token's native decimals**
- Return value is in **quote token's native decimals**
- Example: `oracle.getQuote(1e18, WETH, USDC)` → `~2000e6` (2000 USDC)
- Example: `oracle.getQuote(1e6, USDC, WETH)` → `~500000000000000` (0.0005 ETH)

The `ScaleUtils.calcScale(baseDecimals, quoteDecimals, feedDecimals)` computes scale factors from ERC20 `decimals()` and the feed's own decimals (e.g., Chainlink uses 8).

### Marginal price comparison in hooks

In `LPAgentHook.getFee()`, the marginal price is computed as:
```solidity
uint256 marginalPrice = uint256(reserve1) * WAD / uint256(reserve0);
```

For ETH(18)/USDC(6): `marginalPrice = 20000e6 * 1e18 / 10e18 = 2000e6`

The oracle price computation uses `WAD` as `inAmount` for both assets, then divides:
```solidity
uint256 price0 = oracle.getQuote(WAD, asset0, unitOfAccount);  // price of 1e18 units of asset0
uint256 price1 = oracle.getQuote(WAD, asset1, unitOfAccount);  // price of 1e18 units of asset1
return (price0 * WAD) / price1;  // ratio preserves decimal scaling
```

Both values end up in the same units (asset1-native-per-asset0-native scaled by WAD), so the mismatch comparison works correctly across any decimal combination.

### Fee parameters — always WAD scale

Fees (`fee0`, `fee1`, `baseFee`, `maxFee`, `minFee`) are always in WAD (1e18) scale regardless of token decimals:
- 1 basis point = `1e14`
- 30 bps = `0.003e18` = `3e15`
- 100% = `1e18` (rejected by swap — `SwapRejected()`)

### Reserve limits

Both `equilibriumReserve` and `reserve` are `uint112` (max ~5.19 × 10³³). For 18-decimal tokens this is ~5.19 × 10¹⁵ tokens. For 6-decimal tokens this is ~5.19 × 10²⁷ tokens.

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
        equilibriumReserve0: 10e18,        // 10 ETH (18 decimals)
        equilibriumReserve1: 20000e6,      // 20,000 USDC (6 decimals)
        minReserve0: 0,
        minReserve1: 0,
        priceX: 2000e6,                    // decimal-adjusted: 2000 × 10^(6-18) × 1e18
        priceY: 1e18,                      // reference denominator
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
// Only callable by eulerAccount, manager, or swapHook (from within afterSwap)
pool.reconfigure(newDynamicParams, newInitialState);
```

**Important**: External callers (owner, manager) must call through EVC:
```solidity
evc.call(pool, eulerAccount, 0, abi.encodeCall(IEulerSwap.reconfigure, (newDP, newIS)));
```
Only the `swapHook` can call `reconfigure()` directly — and only from within the `afterSwap` callback (when the pool is unlocked). Direct calls from EOAs without EVC routing will revert with `Unauthorized()`.

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
    // 1. Get current pool price from oracle or compute from reserves
    uint256 currentPrice = getOraclePrice();

    // 2. Compute new equilibrium reserves at current price
    //    preserving the LP's equity and desired leverage ratio.
    //    Simply copying current reserves (dp.eq0 = reserve0) is wrong —
    //    that just declares "where I am is equilibrium" without
    //    properly recomputing the curve parameters for the new price.
    (uint112 newEq0, uint112 newEq1) = computeEquilibrium(currentPrice, equity);

    DynamicParams memory dp = pool.getDynamicParams();
    dp.equilibriumReserve0 = newEq0;
    dp.equilibriumReserve1 = newEq1;
    // Update price scalars to reflect new equilibrium price
    dp.priceX = uint80(currentPrice);

    pool.reconfigure(dp, InitialState(newEq0, newEq1));
}
```

Key insight: the afterSwap hook fires with the pool **unlocked**, so the hook can call `reconfigure()` directly (no EVC routing needed). This is how you build continuous releverage without external keepers.

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

**For leveraged LP positions (booster pools where supplyVault == borrowVault):**
1. Deploy pool with both supply and borrow vaults (same vault = "booster")
2. Set equilibrium reserves larger than actual deposits (virtual > real)
3. The pool borrows the difference when the price moves
4. Self-LTV = 0 in booster vaults; only cross-collateral counts for health

**Booster math — computing equilibrium from equity:**

At the boundary, debt = eq − min (only what's actually borrowed, NOT the full equilibrium).
Collateral = real equity + swap inflows deposited in the other vault.

For one-sided equity E, cross-LTV L, range r, concentration c=0, target health H:
```
X₀ = E × L / (H × β − L × α)
where α = √(1+r) − 1,  β = 1 − 1/√(1+r)
```

Example: E=500 USDC, L=0.94, r=1%, H=1.01 → X₀ ≈ 1,450,000 (2900× boost).
The leverage is high because at ±1% range the boundary debt is only ~0.5% of eq.

For two-sided equity, use the general boost computation in `src/lib/math.ts`
which handles concentration boost, leverage boost, Z-debt, and multiple candidate solutions.

**IMPORTANT**: Do NOT use the naive formula H = minReserve × LTV / equilibrium.
That treats the full equilibrium as debt, which is wrong by orders of magnitude.

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

Each address has 256 sub-accounts sharing the same owner (first 19 bytes). Sub-accounts are computed via XOR with the account ID:
```
Owner prefix:    0x1234...78  (19 bytes)
Sub-account 0:   0x1234...78 XOR 0x00 = 0x1234...7800  (main)
Sub-account 1:   0x1234...78 XOR 0x01 = 0x1234...7801
Sub-account 255: 0x1234...78 XOR 0xff = 0x1234...78ff
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
| `PendleUniversalOracle` | On-chain | Pendle PT + LP tokens |
| `CrossAdapter` | Composite | Chain two oracles: X/Z = (X/Y) × (Y/Z) |
| `FixedRateOracle` | Static | Constant exchange rate |
| `RateProviderOracle` | On-chain | Balancer rate providers (`getRate()`) |
| `IdleTranchesOracle` | On-chain | Idle tranches via CDO `virtualPrice()` |
| `OndoOracle` | On-chain | Ondo RWA tokens |
| `ChainlinkInfrequentOracle` | Push | Like Chainlink but for infrequently-updated feeds |
| `LidoFundamentalOracle` | On-chain | wETH ↔ wstETH (1:1 ETH/stETH assumption) |

### Using Oracles in Hooks

```solidity
// In a getFee hook — compare oracle vs pool price
// getQuote is decimal-aware: inAmount in base decimals, returns quote decimals
// Using same inAmount (WAD) for both tokens, then taking ratio, preserves
// the decimal scaling so it matches the pool's marginal price formula
uint256 price0 = IPriceOracle(oracle).getQuote(1e18, asset0, unitOfAccount);
uint256 price1 = IPriceOracle(oracle).getQuote(1e18, asset1, unitOfAccount);
uint256 oraclePrice = (price0 * 1e18) / price1;  // same units as marginal
uint256 poolPrice = uint256(reserve1) * 1e18 / reserve0;
uint256 mismatch = abs(oraclePrice - poolPrice) * 1e18 / oraclePrice;
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
verifier.verifyAmountMinAndSkim(vault, receiver, amountMin, deadline);
verifier.verifyDebtMax(vault, receiver, amountMax, deadline);
```

### Typical Swap Transaction (EVC Batch)

```solidity
evc.batch([
    // 1. Withdraw from supply vault
    { target: vault, data: withdraw(amount, swapper, account) },
    // 2. Execute swap + deposit result
    { target: swapper, data: multicall([swap(...), deposit(...)]) },
    // 3. Verify slippage
    { target: verifier, data: verifyAmountMinAndSkim(vault, receiver, minOut, deadline) }
]);
```

---

## EVK Periphery

Source: `contracts/evk-periphery/src/`

### Lens Contracts (Read-Only Views)

| Lens | Key Functions |
|------|---------------|
| `VaultLens` | `getVaultInfoStatic()`, `getVaultInfoDynamic()` — complete vault state (balances, rates, LTVs, oracle, caps) |
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

The deploy order matters: pool must exist before the hook (hook constructor reads pool state).

```solidity
// 1. Deploy pool first — without hook
address pool = factory.deployPool(
    StaticParams({
        supplyVault0: eWETH, supplyVault1: eUSDC,
        borrowVault0: eWETH, borrowVault1: eUSDC,  // enable leverage
        eulerAccount: myAccount,
        feeRecipient: address(0)     // set later via reconfigure
    }),
    DynamicParams({
        equilibriumReserve0: 10e18, equilibriumReserve1: 20000e6,
        minReserve0: 0, minReserve1: 0,
        priceX: 2000e6, priceY: 1e18,                    // decimal-adjusted (see Token Decimals)
        concentrationX: 0.9e18, concentrationY: 0.9e18,  // high concentration
        fee0: 0.003e18, fee1: 0.003e18,                  // fallback fee
        expiration: 0,
        swapHookedOperations: 0,     // no hook yet
        swapHook: address(0)
    }),
    InitialState({ reserve0: 10e18, reserve1: 20000e6 }),
    salt
);

// 2. Deploy hook — constructor reads pool.getStaticParams()
//    mismatchScale is uint256 (not uint64) — realistic values like 10e18 overflow uint64
LPAgentHook hook = new LPAgentHook(pool, owner, baseFee, maxFee, minFee, mismatchScale);

// 3. Reconfigure pool to install hook (must go through EVC)
DynamicParams memory dp = IEulerSwap(pool).getDynamicParams();
dp.swapHookedOperations = 0x06;  // GET_FEE | AFTER_SWAP
dp.swapHook = address(hook);
evc.call(pool, myAccount, 0, abi.encodeCall(
    IEulerSwap.reconfigure, (dp, InitialState(10e18, 20000e6))
));

// 4. Register in registry
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
