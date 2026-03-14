# EulerSwap Curve Math Specification

Mathematical specification for porting EulerSwap's concentrated constant-product curve to Rust.

## Source Files

- Solidity: `contracts/eulerswap/src/libraries/CurveLib.sol`
- Quote logic: `contracts/eulerswap/src/libraries/QuoteLib.sol`
- TypeScript: `src/lib/math.ts`
- Math utils: `contracts/eulerswap/src/math/{FullMath,Sqrt,Clz}.sol`

## Parameters

All pricing is determined by 10 parameters from `DynamicParams`:

| Parameter | Type | Scale | Description |
|-----------|------|-------|-------------|
| `equilibriumReserve0` (x0) | uint112 | 1 | Virtual X reserve at equilibrium |
| `equilibriumReserve1` (y0) | uint112 | 1 | Virtual Y reserve at equilibrium |
| `priceX` (px) | uint80 | 1e18 | Oracle price of asset0 |
| `priceY` (py) | uint80 | 1e18 | Oracle price of asset1 |
| `concentrationX` (cx) | uint64 | 1e18 | Concentration on X-side (0=constant-product, 1e18=constant-sum) |
| `concentrationY` (cy) | uint64 | 1e18 | Concentration on Y-side |
| `fee0` | uint64 | 1e18 | Fee when asset0 is input (1e18 = 100%) |
| `fee1` | uint64 | 1e18 | Fee when asset1 is input |
| `minReserve0` | uint112 | 1 | Lower bound for reserve0 |
| `minReserve1` | uint112 | 1 | Lower bound for reserve1 |

Additionally, current reserves are needed: `reserve0`, `reserve1` (uint112).

## Curve Overview

The curve is **piecewise** around equilibrium (x0, y0):

- **X-side** (x ≤ x0): Y is computed via `f(x)` — the forward function
- **Y-side** (x > x0): Y is computed via `fInverse(x)` — the inverse function (quadratic)

The same functions are used symmetrically: to compute X given Y, swap the roles of X/Y and their parameters.

## Forward Function: `f(x, px, py, x0, y0, c)`

Domain: `1 ≤ x ≤ x0`
Range: `y0 ≤ y ≤ uint112_max`

```
if c == 1e18:
    # Constant-sum
    v = ceil((x0 - x) * px / py)
    y = y0 + v

else:
    # Concentrated constant-product
    a = px * (x0 - x)                          # scale: 1e18, range: 196 bits
    b = c * x + (1e18 - c) * x0                # scale: 1e18, range: 172 bits
    d = 1e18 * x * py                          # scale: 1e36, range: 255 bits
    v = saturating_mul_div_up(a, b, d)          # scale: 1, rounds UP
    y = saturating_add(y0, v)

if y > uint112_max: return uint256_max (overflow sentinel)
return y
```

**Rounding**: `f()` rounds UP (overestimates y), which is conservative — the curve is above the true value.

## Inverse Function: `fInverse(y, px, py, x0, y0, cx)`

Domain: `y0 ≤ y ≤ uint112_max`
Range: `0 ≤ x ≤ x0`

This solves the quadratic equation derived from the curve for x given y.

### Step 1: Compute B (absolute value and sign)

```
term1 = 1e18 * ((y - y0) * py + x0 * px)       # scale: 1e36, range: 256 bits
term2 = (cx << 1) * x0 * px                     # scale: 1e36, range: 256 bits

(difference, sign) = abs_diff(term1, term2)
# sign = true when B is negative (term1 < term2)

# Division with conditional rounding
if sign:
    absB = ceil(difference / px)
else:
    absB = floor(difference / px)
```

### Step 2: Compute shift to prevent overflow

```
shiftSquaredB = saturating_sub(bit_length(absB), 127)
shiftFourAc   = saturating_sub(bit_length(x0 * 3814697265625), 109)
# Note: 3814697265625 = 5e17 with trailing zeros removed

shift    = max(shiftSquaredB, shiftFourAc)
twoShift = shift << 1
```

### Step 3: Solve quadratic (sign-dependent formula)

**When B is negative** (sign = true) — standard quadratic formula, everything rounds UP:

```
fourAC  = unsafe_mul_shift_up(cx * (1e18 - cx) << 2, x0 * x0, twoShift)
squaredB = unsafe_mul_shift_up(absB, absB, twoShift)
discriminant = squaredB + fourAC
sqrt = sqrt_up(discriminant) << shift

x = ceil((absB + sqrt) / (cx << 1))
```

**When B is non-negative** (sign = false) — citardauq formula, everything except final division rounds DOWN:

```
fourAC  = unsafe_mul_shift(cx * (1e18 - cx) << 2, x0 * x0, twoShift)
squaredB = unsafe_mul_shift(absB, absB, twoShift)
discriminant = squaredB + fourAC
sqrt = sqrt_down(discriminant) << shift

x = ceil(((1e18 - cx) << 1) * x0 * x0 / (absB + sqrt))
```

### Step 4: Clamp result

```
if x > x0: x = x0
return x
```

### Why citardauq?

When B is large and positive, the standard formula computes `(-B + sqrt(B² + 4AC))` — subtracting two nearly-equal large numbers causes catastrophic cancellation. The citardauq formula `2C / (B + sqrt(B² + 4AC))` avoids this by only adding positive terms.

## Quote Computation: `findCurvePoint`

The quote dispatcher handles 4 cases based on `exactIn` × `asset0IsInput`:

### Exact Input (trader sends known amount)

**Asset0 in, Asset1 out:**
```
xNew = reserve0 + amount
if xNew ≤ x0:
    yNew = f(xNew, px, py, x0, y0, cx)       # same side
else:
    yNew = fInverse(xNew, py, px, y0, x0, cy) # cross to other side (note swapped params!)
output = max(reserve1 - yNew, 0)
```

**Asset1 in, Asset0 out:**
```
yNew = reserve1 + amount
if yNew ≤ y0:
    xNew = f(yNew, py, px, y0, x0, cy)
else:
    xNew = fInverse(yNew, px, py, x0, y0, cx)
output = max(reserve0 - xNew, 0)
```

### Exact Output (trader receives known amount)

**Asset0 in, Asset1 out (want exact Y out):**
```
if reserve1 ≤ amount: return uint256_max  # insufficient reserves
yNew = reserve1 - amount
if yNew ≤ y0:
    xNew = f(yNew, py, px, y0, x0, cy)
else:
    xNew = fInverse(yNew, px, py, x0, y0, cx)
output = max(xNew - reserve0, 0)          # amount of X needed
```

**Asset1 in, Asset0 out (want exact X out):**
```
if reserve0 ≤ amount: return uint256_max
xNew = reserve0 - amount
if xNew ≤ x0:
    yNew = f(xNew, px, py, x0, y0, cx)
else:
    yNew = fInverse(xNew, py, px, y0, x0, cy)
output = max(yNew - reserve1, 0)          # amount of Y needed
```

### CRITICAL: Parameter swapping

When crossing from one side to the other (e.g., xNew > x0), the call to `fInverse` swaps:
- `px ↔ py`
- `x0 ↔ y0`
- Uses `cy` instead of `cx` (or vice versa)

This is because the inverse function on the X-side IS the forward function on the Y-side with swapped roles.

## Fee Application

Fees are applied **outside** the curve math:

**Exact input:**
```
effectiveAmount = amount - (amount * fee / 1e18)    # floor division
quote = findCurvePoint(dParams, effectiveAmount, exactIn=true, asset0IsInput)
return quote  # this is the output amount
```

**Exact output:**
```
rawQuote = findCurvePoint(dParams, amount, exactIn=false, asset0IsInput)
quote = (rawQuote * 1e18) / (1e18 - fee)            # floor division, inflates input
return quote  # this is the required input amount
```

**Dynamic fees:** When a hook is configured (`swapHookedOperations & EULER_SWAP_HOOK_GET_FEE`), the fee is determined by calling `hook.getFee()` rather than using `fee0`/`fee1`. For Phase 1 (eth_call), this is handled automatically by `computeQuote()`. For Phase 2 (Rust math), call `getFee()` via eth_call and use the returned fee with native curve math.

## Curve Verification: `verify(dParams, newReserve0, newReserve1)`

Checks that a point (newReserve0, newReserve1) is on or above the curve:

```
if newReserve0 > uint112_max or newReserve1 > uint112_max: return false
if newReserve0 < minReserve0 or newReserve1 < minReserve1: return false

if newReserve0 ≥ x0:
    if newReserve1 ≥ y0: return true  # both above equilibrium = always valid
    return newReserve0 ≥ f(newReserve1, py, px, y0, x0, cy)
else:
    if newReserve1 < y0: return false  # both below equilibrium = always invalid
    return newReserve1 ≥ f(newReserve0, px, py, x0, y0, cx)
```

## Required Math Primitives

### `mul_div(a, b, d)` → uint256
512-bit intermediate: `floor(a * b / d)`. See `FullMath.mulDiv`.

### `mul_div_up(a, b, d)` → uint256
512-bit intermediate: `ceil(a * b / d)`. See `FullMath.mulDivUp`.

### `saturating_mul_div_up(a, b, d)` → uint256
Like `mul_div_up` but returns `uint256_max` on overflow instead of reverting.

### `unsafe_mul_shift(a, b, s)` → uint256
512-bit multiply then right-shift: `floor((a * b) >> s)`. See `FullMath.unsafeMulShift`.

### `unsafe_mul_shift_up(a, b, s)` → uint256
Same but rounds up: `ceil((a * b) >> s)`. See `FullMath.unsafeMulShiftUp`.

### `sqrt(x)` → uint256
Integer square root, rounds down. Babylonian method with 7 Newton iterations. See `Sqrt.sqrt`.

### `sqrt_up(x)` → uint256
Integer square root, rounds up: `sqrt(x) + (sqrt(x)² < x ? 1 : 0)`. See `Sqrt.sqrtUp`.

### `bit_length(x)` → uint256
Number of significant bits: `256 - clz(x)`. See `Clz.bitLength`.

### `abs_diff(a, b)` → (uint256, bool)
Returns `(|a - b|, a < b)`.

### `saturating_add(a, b)` → uint256
Returns `min(a + b, uint256_max)`.

### `saturating_sub(a, b)` → uint256
Returns `max(a - b, 0)`.

## Rust Implementation Notes

1. **Use `U256` from `ruint` or `ethnum`** for 256-bit arithmetic. Both support the operations needed.

2. **`mul_div` is the critical primitive.** The Solidity implementation uses inline assembly for 512-bit intermediate products. In Rust, use `U512` for the intermediate or a dedicated `mul_div` implementation.

3. **The citardauq formula is essential.** Do not simplify to always use the standard quadratic formula — it will produce incorrect results when B is large and positive.

4. **Dynamic bit-shifting** prevents overflow in the discriminant computation. The shift amount adapts based on the magnitude of B and 4AC. This is unusual but necessary for 256-bit arithmetic.

5. **Rounding direction matters.** `f()` rounds UP (conservative — overestimates y). `fInverse` uses direction-dependent rounding based on the sign of B.

6. **Test against `computeQuote()`** on a mainnet fork to validate. See `spec/test-vectors.json`.
