# EulerSwap Curve Math Specification

Mathematical specification for EulerSwap's concentrated constant-product curve. Originally
written as a porting guide for a native Rust implementation (Phase 2), which has been
**deferred** — Phase 1 `eth_call` quoting is sufficient in practice. This spec remains
the canonical reference for the curve math and is maintained alongside 31 test vectors
in `test-vectors.json`. See the Rust README's "Phase 2 Roadmap" section for rationale.

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

The discriminant `B² + 4AC` is computed via 512-bit multiply-then-shift. The shift amount
must be large enough that neither `B²` nor `4AC` overflows 254 bits after shifting.

```
shiftSquaredB = saturating_sub(bit_length(absB), 127)
shiftFourAc   = saturating_sub(bit_length(x0 * 3814697265625), 109)
shift    = max(shiftSquaredB, shiftFourAc)
twoShift = shift << 1
```

**Why 127?** `unsafeMulShift(absB, absB, twoShift)` computes `(absB * absB) >> twoShift`.
The 512-bit product is 2 * bit_length(absB) bits. To fit in 254 bits after shifting:
`2 * bit_length(absB) - twoShift ≤ 254`, so `twoShift ≥ 2 * (bit_length(absB) - 127)`.
Since `twoShift = 2 * shift`, we need `shift ≥ bit_length(absB) - 127`.

**Why 109?** `4AC = (cx * (1e18 - cx) << 2) * (x0 * x0) >> twoShift`.
The first factor `cx * (1e18 - cx) << 2` is at most `1e36 << 2` ≈ 122 bits.
The product with `x0²` is at most `122 + 2 * bit_length(x0)` bits.
But the constant `3814697265625` (= 5e17 >> 17, i.e. 5e17 with trailing zero bits removed)
is used as a proxy: `x0 * 3814697265625` approximates the bit-width of the full `4AC` term.
`bit_length(x0 * 3814697265625) - 109` ensures `4AC >> twoShift` fits in 254 bits.
The threshold 109 accounts for the remaining constant factors and the `<< 2` shift.

**Why 3814697265625?** This is `5 * 10^17 / 2^17 = 5e17 >> 17`. The full 4AC expression
includes `cx * (1e18 - cx)` which is maximized at `cx = 0.5e18`, giving `0.25e36`.
The constant `3814697265625` captures the bit-width contribution of this maximum value
in a single multiplication with `x0`, avoiding a separate multi-step bit-length calculation.

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

The quadratic equation is `A·x² + B·x - C = 0` where A > 0, C > 0, and B can be positive
or negative. The positive root we want is always `x = (-B + sqrt(B² + 4AC)) / (2A)`.

**When B < 0:** `-B` is positive, `sqrt(B² + 4AC) > |B|`, so the numerator sums two
positive values. Standard formula is numerically stable.

**When B ≥ 0:** `-B` is negative, `sqrt(B² + 4AC)` is slightly larger than B. The
numerator subtracts two nearly-equal large numbers → catastrophic cancellation (e.g.,
if B = 1e36 and sqrt(B²+4AC) = 1e36 + 1e18, the result should be 1e18 but floating
rounding loses all precision).

The **citardauq** (quadratic spelled backwards) uses the identity:
```
(-B + sqrt(D)) / (2A) = 2C / (B + sqrt(D))
```
The denominator `B + sqrt(D)` **adds** two positive values — no cancellation. This is
algebraically identical but numerically stable when B ≥ 0.

**Both branches compute the same mathematical root.** The choice is purely numerical.

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

### Dynamic Fees (Hook-Based)

When a hook is configured (`swapHookedOperations & 0x02 != 0`), the fee is determined by
calling the hook's `getFee()` instead of using `fee0`/`fee1` from DynamicParams.

**Hook interface** (ABI in `abi/IEulerSwapHookTarget.json`):

```solidity
function getFee(
    bool asset0IsInput,   // swap direction
    uint112 reserve0,     // current reserve0
    uint112 reserve1,     // current reserve1
    bool readOnly         // true for view calls (quoting), false for state-changing (swap)
) external returns (uint64 fee);  // scale: 1e18
```

**Return value:** Fee as a fraction of 1e18. Examples:
- `5e14` = 0.05% (5 bps)
- `1e16` = 1%
- `type(uint64).max` = sentinel meaning "use fallback fee0/fee1"

**Fallback logic:**
```
fee = hook.getFee(asset0IsInput, reserve0, reserve1, readOnly)
if fee == type(uint64).max:
    fee = asset0IsInput ? fee0 : fee1
```

**Fee rejection:** If `fee >= 1e18`, the swap is rejected (`SwapRejected` error).
This is how hooks block swaps — return fee = 1e18.

**For Phase 1 (eth_call):** `computeQuote()` handles all of this automatically.

**For Phase 2 (Rust math):** Call `hook.getFee(direction, r0, r1, true)` via `eth_call` to
get the current fee, then apply it with native curve math. Cache per block per direction.
If the call reverts, fall back to `fee0`/`fee1`. If both are 0 and no hook is set, the pool
has zero fees (unusual but valid for some pool types).

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

## Implementation Notes

### Cross-language parity

The Solidity (`CurveLib.sol`) is the **source of truth**. The TypeScript (`math.ts`)
is a design/visualization tool that uses IEEE 754 floats and **does not produce
identical results**. Key differences:

1. **Arithmetic model.** Solidity uses 256-bit integers with 1e18 fixed-point scaling
   and 512-bit intermediates (`FullMath.mulDiv`). TypeScript uses 64-bit floats (~15-16
   significant digits). The Solidity form accumulates terms into one big fraction
   `a*b/d` before dividing; TypeScript divides early (`px/py` first), losing precision
   at each step.

2. **Rounding direction.** Solidity `f()` always rounds UP (`saturatingMulDivUp`).
   Solidity `fInverse()` uses direction-dependent rounding (up when B < 0, mixed when
   B ≥ 0). TypeScript rounds to nearest (IEEE 754 default) with no directional guarantees.

3. **Overflow handling.** Solidity saturates to `uint256_max` and clamps to `uint112_max`.
   TypeScript uses `Infinity`/`NaN`.

4. **Inverse function.** Solidity uses dynamic bit-shifting to prevent overflow in the
   discriminant, with conditional standard/citardauq quadratic formula and ~8 carefully
   directed rounding operations. TypeScript uses `Math.sqrt()` with no overflow prevention
   or rounding control.

Any native reimplementation (Rust or otherwise) **must replicate the Solidity's integer
arithmetic and rounding directions exactly** to produce matching results. Test against
`computeQuote()` on a mainnet fork — see `test-vectors.json` for 31 pinned vectors.

### Rust-specific notes

1. **Use `U256` from `ruint` or `ethnum`** for 256-bit arithmetic. Both support the operations needed.

2. **`mul_div` is the critical primitive.** The Solidity implementation uses inline assembly for 512-bit intermediate products. In Rust, use `U512` for the intermediate or a dedicated `mul_div` implementation.

3. **The citardauq formula is essential.** Do not simplify to always use the standard quadratic formula — it will produce incorrect results when B is large and positive.

4. **Dynamic bit-shifting** prevents overflow in the discriminant computation. The shift amount adapts based on the magnitude of B and 4AC. This is unusual but necessary for 256-bit arithmetic.

5. **Rounding direction matters.** `f()` rounds UP (conservative — overestimates y). `fInverse` uses direction-dependent rounding based on the sign of B.

6. **Dynamic fees are not captured by curve math alone.** The V7 hook reads a Uniswap
   oracle to set fees dynamically. A pure curve port would still need `eth_call` for
   `getFee()`, or a separate reimplementation of the hook's fee logic — which is complex
   and changes frequently.

## Curve Derivative (Marginal Price)

The derivative of the EulerSwap curve has a clean closed form:

```
X-side (x ≤ x0):  f'(x) = -(px/py) × [cx + (1 - cx) × (x0/x)²]
Y-side (y ≤ y0):  g'(y) = -(py/px) × [cy + (1 - cy) × (y0/y)²]
```

The marginal price (Y per X) is `-f'(x)` on the X-side, or `1/(-g'(y))` on the Y-side.

### Second derivative and convexity

```
f''(x) = +2(px/py)(1 - cx)(x0²/x³)  > 0  (convex in reserve space)
```

The curve f(x) is convex (f'' > 0), meaning the slope flattens toward equilibrium.
The **output function** g(a) = f(currentX) - f(currentX + a) is concave (g'' < 0) —
standard diminishing-returns AMM behavior.

### Existing implementations

- **Hook internal**: `_getMarginalPrice()` in `LPAgentHookV7.sol` — used for auction
  clearing and dynamic fee calculation. Compares against oracle with a threshold;
  does not need to be a tight bound on `computeQuote`.
- **Test utility**: `CurveExtrasLib.df_dx()` — mixed rounding directions, test-only.
- **TypeScript**: `fXd()`, `gYd()`, `pXxy()` etc. in `src/lib/math.ts`.

### Why we decided against a production onchain derivative

Investigated March 2026. A production Solidity implementation would be straightforward
(~10 lines using `FullMath.mulDiv`, achieving ~2-3 wei error in 1e18 scale), but was
determined not worth implementing for the following reasons:

1. **Integer rounding breaks safety guarantees in concentrated regions.** With high
   concentration (c near 1e18), the curve is nearly linear and f'' ≈ 0. In this regime,
   integer rounding dominates the concavity: a correctly-rounded derivative can report a
   marginal price that exceeds what `computeQuote(1 wei)` actually delivers, because
   `computeQuote` rounds conservatively (less output via `saturatingMulDivUp`). Making
   the derivative a provably tight lower bound on `computeQuote(δ)/δ` for all valid
   states and all δ would require matching every rounding decision in `f()` and
   `fInverse()` — fragile and hard to maintain across upstream CurveLib changes.

2. **Dynamic fees make a pure curve derivative insufficient.** The V7 hook reads the
   Uniswap oracle to set fees dynamically. A curve derivative doesn't capture fee
   effects. Solvers need the fee-inclusive price, which only `computeQuote` provides.
   This is why the Tycho adapter's `trade.price` returns `Fraction(0, 1)`.

3. **No external consumer needs it.** The Tycho adapter already returns average
   execution price (`computeQuote(amt)/amt`) for non-zero amounts, which is what
   solvers actually need for routing. CoW, UniswapX, and 1inch use `computeQuote`
   directly for settlement. The hook's internal `_getMarginalPrice()` already serves
   its purpose for auction clearing and fee calculation.

4. **The Tycho adapter documents the concentrated-curve issue.** See
   `EulerSwapAdapter.sol:_priceAt()` — the adapter explicitly switched from numerical
   differentiation to average execution price because the numerical derivative violated
   the Tycho spec's `executedPrice >= marginalPrice` invariant in concentrated regions.
