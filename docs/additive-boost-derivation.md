# Additive Boost Derivation

## Motivation

The current boost formula uses a multiplicative structure:
```
x0 = xr * bXC * bXL
```
This requires `xr > 0` for nonzero `x0`. After trading in a highly leveraged pool,
one side's real deposits can hit zero (e.g., all USDC withdrawn and borrowed), making
recentering impossible even though cross-collateral equity exists.

The additive reformulation:
```
x0 = xr + BX
```
Where `BX` is the additional virtual reserves from borrowing capacity. This works for
any `xr >= 0`, including zero.

---

## Setup

### Pool variables
- `x0, y0`: virtual (boosted) equilibrium reserves
- `xb, yb`: boundary reserves (minimum within range)
- `xr, yr`: real deposits in vaults at equilibrium
- `xd, yd`: real debts in vaults at equilibrium (only one nonzero)
- `px, py`: price scalars (external oracle prices in common numeraire)

### Derived quantities
- `sx = sqrt((1 + rx - cx) / (1 - cx))`: range scale factor
- `R = 1 + rx`: boundary price ratio (Y-per-X at xb vs at eq)
- `PX = cx + (1-cx)*sx`: price factor at X boundary
- `pxy = px/py`: equilibrium exchange rate (Y per X)
- `pyx = py/px`: inverse exchange rate (X per Y)
- `pXyxb = py/(px*R) = pyx/R`: X per Y at the X boundary

### Key identities
```
R = 1 + rx
For cx = 0:  sx² = R,  PX = sx,  pXyxb = pyx/sx²
For cx > 0:  sx² ≠ R  (in general)
```

### Key AMM relationships (general cx)
- `xb = x0 / sx`
- Outflow from eq to boundary: `x0 - xb = x0*(sx-1)/sx`
- Y received from curve: `yXdelta = pxy * x0 * (sx-1) * PX / sx`
  (From the AMM curve `y(xb) - y(x0)` at `x = xb = x0/sx`)
- Boundary price: `p_XperY(xb) = (px/py)*R` (independent of cx!)

### Note on cx=0 simplification
When `cx = 0`: `PX = sx`, `R = sx²`, and `yXdelta = pxy * x0 * (sx-1)`.

---

## Euler vault health constraint

For the X vault (X debt, Y collateral) at the X boundary:

```
H_XX = (vyx * CXY * pXyxb + ZXC) / DXX
```

For the Y vault (Y debt, X collateral) at the X boundary:

```
H_XY = (vxy * CXX * (px/py) + ZXY) / (DXY * pXyxb)
```

Wait — let me define all terms properly. All quantities are in **X units**:

| Symbol | Definition | Units |
|--------|-----------|-------|
| CXX | max(0, xr - outflow) | X |
| CXY | yr + yXdelta - yd (Y collateral, positive when yXdelta > yd) | Y |
| DXX | xd + max(0, outflow - xr) (total X debt) | X |
| DXY | max(0, yd - yXdelta) (remaining Y debt) | Y |
| ZXC | vzx*zr*pzx + rXX (external X-phase collateral) | X |
| ZXY | vzy*zr*pzx + rXY (external Y-phase collateral) | X |
| pXyxb | py/(px*R) = pyx/R (X per Y at boundary) | X/Y |

**Health formulas at position x (all terms in X units):**
```
H_XX(x) = (vyx * CXY(x) * pXyx(x) + ZXC) / DXX(x)
H_XY(x) = (vxy * CXX(x) + ZXY) / (DXY(x) * pXyx(x))
```

Where `pXyx(x)` is the marginal price (X per Y) at position x — i.e. the
reciprocal of the AMM curve derivative `1/|fX'(x)|`. At any (x, y), the
derivative at that point converts between X and Y units.

At `x = xb`: `pXyx(xb) = py/(px*(cx + (1-cx)*sx²)) = py/(px*R) = pXyxb`.
(Since `cx + (1-cx)*sx² = 1+rx = R`.)

### One-debt-asset constraint

The lending market allows exactly one debt asset (xd > 0 OR yd > 0 OR zd > 0).
This simplifies the analysis: when xd > 0, yd = 0 so DXY = 0 and only H_XX matters.
When yd > 0, xd = 0 and both phases can occur as x decreases.

---

## Vault state at x = xb (general framework)

With `x0 = xr + BX`:

**Outflow** (X tokens leaving pool):
```
outflow = x0 - xb = (xr + BX) * (sx - 1) / sx
```

**X deposits remaining:**
```
CXX = max(0, xr - outflow) = max(0, xr/sx - BX*(sx-1)/sx)
```
CXX = 0 when `BX ≥ xr/(sx-1)`.

**Net X debt at boundary:**
```
DXX = xd + max(0, outflow - xr)
    = xd + max(0, BX*(sx-1)/sx - xr/sx)
```
When CXX = 0: `DXX = xd + BX*(sx-1)/sx - xr/sx`
When CXX > 0: `DXX = xd` (only pre-existing)

**Y received from trading to boundary:**
```
yXdelta = pxy * (xr + BX) * (sx - 1) * PX / sx
```

**Y collateral surplus:**
```
CXY = yr + yXdelta - yd    (can be negative if yXdelta < yd)
```

**Remaining Y debt:**
```
DXY = max(0, yd - yXdelta)
```

---

## X/Y Debt Cases

There are four cases depending on which max() branches are active:

| Case | CXX | yXdelta vs yd | Phase | BX range |
|------|-----|--------------|-------|----------|
| bXL11 | = 0 | > yd | H_XX | BX > xr/(sx-1) |
| bXL01 | = 0 | ≤ yd | H_XY | BX > xr/(sx-1) |
| bXL10 | > 0 | > yd | H_XX | BX < xr/(sx-1) |
| bXL00 | > 0 | ≤ yd | — | BX = 0 (fallback) |

---

### Case bXL11: CXX = 0, yXdelta > yd (primary case)

This is the dominant case for boosted pools with meaningful leverage.

**Assumptions:**
1. CXX = 0 → `BX > xr/(sx-1)`
2. yXdelta > yd → Y debt fully repaid, Y surplus serves as collateral

**Health constraint** (H_XX = 1):
```
vyx * CXY * pXyxb + ZXC = DXX
```

Substituting:
```
vyx * [yr - yd + pxy*(xr+BX)*(sx-1)*PX/sx] * pXyxb + ZXC
  = BX*(sx-1)/sx - xr/sx + xd
```

**Key simplification:** `pxy * pXyxb = (px/py) * py/(px*R) = 1/R`

So `pxy * (sx-1) * PX * pXyxb / sx = (sx-1)*PX/(sx*R)`.

Substituting:
```
vyx*(yr-yd)*pXyxb + vyx*(xr+BX)*(sx-1)*PX/(sx*R) + ZXC
  = BX*(sx-1)/sx - xr/sx + xd
```

Multiply through by `sx*R`:
```
vyx*(yr-yd)*pXyxb*sx*R + vyx*(xr+BX)*(sx-1)*PX + ZXC*sx*R
  = BX*(sx-1)*R - xr*R + xd*sx*R
```

Expand and collect BX:
```
BX * [(sx-1)*R - vyx*(sx-1)*PX] = vyx*(yr-yd)*pXyxb*sx*R
                                   + xr*[vyx*(sx-1)*PX + R]
                                   + (ZXC - xd)*sx*R
```

Factor left side:
```
BX * (sx-1) * (R - vyx*PX)
```

#### General formula (any cx)

```
          vyx*(yr-yd)*pXyxb*sx*R  +  xr*[vyx*(sx-1)*PX + R]  +  (ZXC - xd)*sx*R
BX_11 = ─────────────────────────────────────────────────────────────────────────────
                                (sx-1) * (R - vyx*PX)
```

Where `R = 1+rx`, `pXyxb = pyx/R`.

#### Simplified for cx = 0

When `cx = 0`: `PX = sx`, `R = sx²`, `pXyxb = pyx/sx²`.

Substituting: `pXyxb*sx*R = (pyx/sx²)*sx*sx² = pyx*sx`.

Numerator: `vyx*(yr-yd)*pyx*sx + xr*sx*[vyx*(sx-1)+sx] + (ZXC-xd)*sx³`

Denominator: `(sx-1)*sx*(sx-vyx)`

Dividing by sx:

```
          vyx*(yr-yd)*pyx  +  xr*[vyx*(sx-1) + sx]  +  (ZXC - xd)*sx²
BX_11 = ─────────────────────────────────────────────────────────────────
                              (sx-1) * (sx - vyx)
```

#### Validity conditions for bXL11
1. `BX_11 > xr/(sx-1)` — CXX = 0 (all X deposits depleted)
2. `pxy*(xr+BX_11)*(sx-1)*PX/sx > yd` — Y debt fully repaid
3. Denominator positive: `R > vyx*PX` (always true — see §Denominator below)

---

### Case bXL01: CXX = 0, yXdelta ≤ yd (H_XY phase)

When the Y received from trading doesn't cover existing Y debt, the binding
constraint is H_XY (Y debt health), not H_XX (X debt health).

**Assumptions:**
1. CXX = 0 → `BX > xr/(sx-1)`
2. yXdelta ≤ yd → Y debt still partially outstanding

**Health constraint** (H_XY = 1):
```
(vxy * CXX + ZXY) / (DXY * pXyxb) = 1
```

With CXX = 0:
```
ZXY = DXY * pXyxb = (yd - yXdelta) * pXyxb
```

Substituting yXdelta:
```
ZXY = [yd - pxy*(xr+BX)*(sx-1)*PX/sx] * pXyxb
```

Using `pxy * pXyxb = 1/R`:
```
ZXY = yd*pXyxb - (xr+BX)*(sx-1)*PX/(sx*R)
```

Solving for BX:
```
(xr+BX)*(sx-1)*PX/(sx*R) = yd*pXyxb - ZXY
```

#### General formula (any cx)

```
BX_01 = (yd*pXyxb - ZXY) * sx*R / ((sx-1)*PX) - xr
```

Where `ZXY = vzy*zr*pzx + rXY`.

#### Simplified for cx = 0

With `PX = sx`, `R = sx²`, `pXyxb = pyx/sx²`:

```
BX_01 = (yd*pyx/sx² - ZXY) * sx*sx² / ((sx-1)*sx) - xr
      = (yd*pyx - ZXY*sx²) / (sx-1) - xr
```

#### Validity conditions for bXL01
1. `BX_01 > xr/(sx-1)` — CXX = 0
2. `pxy*(xr+BX_01)*(sx-1)*PX/sx ≤ yd` — Y debt NOT fully repaid
3. `ZXY > 0` — there must be external collateral backing Y debt; otherwise H_XY = 0

**Self-consistency of condition 2:** Substituting BX_01 back into yXdelta ≤ yd
and using the formula derivation:
```
yXdelta = pxy*(xr+BX_01)*(sx-1)*PX/sx = yd - ZXY/pXyxb = yd - ZXY*R/pyx
```
So yXdelta < yd iff ZXY > 0. ✓  The validity is equivalent to ZXY > 0.

#### When does bXL01 apply?

bXL01 applies when bXL11 is invalid — specifically when the BX_11 value would give
yXdelta ≤ yd (contradicting bXL11's assumption). This happens when:
- yd is large relative to the pool's Y-inflow capacity
- yr is small (little Y collateral for the H_XX phase)
- ZXY > 0 provides the backing for residual Y debt

Since yXdelta is monotonically increasing in BX, and bXL01 requires yXdelta ≤ yd
while bXL11 requires yXdelta > yd, we always have **BX_01 < BX_11**. The bXL01
case provides less leverage because H_XY is the binding constraint.

---

### Case bXL10: CXX > 0, yXdelta > yd (low leverage)

When leverage is low, X deposits are not fully depleted. This case primarily
occurs when xd > 0 (pre-existing X debt is the only debt at boundary).

**Note:** When yd > 0 and CXX > 0, DXX = 0 (no X debt since xd = 0 and outflow < xr).
Health is infinite — no constraint. So bXL10 is only meaningful when **xd > 0** (yd = 0).

**Assumptions (with xd > 0, yd = 0):**
1. CXX > 0 → `BX < xr/(sx-1)` (outflow < xr)
2. yXdelta > 0 = yd → trivially satisfied
3. DXX = xd (only pre-existing debt, no new borrowing)

**Health constraint** (H_XX = 1):
```
vyx * CXY * pXyxb + ZXC = DXX = xd
```

Where CXY = yr + yXdelta (with yd = 0, all Y inflow is surplus).

```
vyx * [yr + pxy*(xr+BX)*(sx-1)*PX/sx] * pXyxb + ZXC = xd
```

Using `pxy * pXyxb = 1/R`:
```
vyx*yr*pXyxb + vyx*(xr+BX)*(sx-1)*PX/(sx*R) + ZXC = xd
```

#### General formula (any cx, xd > 0, yd = 0)

```
BX_10 = [xd - ZXC - vyx*yr*pXyxb] * sx*R / (vyx*(sx-1)*PX) - xr
```

#### Simplified for cx = 0

```
BX_10 = [xd - ZXC - vyx*yr*pyx/sx²] * sx² / (vyx*(sx-1)) - xr
```

#### Validity conditions for bXL10
1. `0 < BX_10 < xr/(sx-1)` — CXX > 0 (low leverage range)
2. `xd > 0` (and yd = 0)

#### Relationship to bXL11

For the same parameters, bXL10 and bXL11 share the same LHS but different RHS:
- bXL11: RHS = DXX = BX*(sx-1)/sx - xr/sx + xd (includes new borrowing)
- bXL10: RHS = DXX = xd (only pre-existing debt)

When BX_11 < xr/(sx-1) (bXL11 would violate CXX = 0 assumption), bXL10 applies
with a smaller DXX. The bXL11 formula in this regime is **conservative** — it
overestimates DXX, computing a smaller BX than the true safe value from bXL10.

---

### Case bXL00: no leverage boost

When none of the above cases produce a valid BX > 0:
```
BX = 0   →   x0 = xr
```
The pool uses only concentration boost (x0 = xr, but the curve shape still
provides virtual liquidity via the concentration parameter cx).

---

## Case Selection Logic

```
1. Compute BX_11 (primary formula)
2. Check validity: BX_11 > xr/(sx-1) AND yXdelta(xr + BX_11) > yd
   → If valid: use BX = BX_11 ✓

3. If BX_11 invalid because yXdelta ≤ yd:
   Compute BX_01 (H_XY phase formula)
   Check: BX_01 > xr/(sx-1) AND ZXY > 0
   → If valid: use BX = BX_01 ✓

4. If BX_11 invalid because BX_11 < xr/(sx-1) AND xd > 0:
   Compute BX_10 (low leverage formula)
   Check: 0 < BX_10 < xr/(sx-1)
   → If valid: use BX = BX_10 ✓

5. Fallback: BX = 0 (bXL00)
```

**Equivalence with multiplicative code:** The multiplicative code computes all four
candidates, checks validity, and picks the highest valid `bXC * bXL`. This is
equivalent because the cases are mutually exclusive (each BX falls in exactly one
regime based on the CXX and yXdelta conditions).

---

## Y-side formulas (symmetric)

By symmetry (swap x↔y, px↔py, vyx↔vxy, rx↔ry, cx↔cy):

Define: `sy`, `Ry = 1+ry`, `PY = cy + (1-cy)*sy`, `pYxyb = px/(py*Ry)`.

### BY_11 (general)
```
          vxy*(xr-xd)*pYxyb*sy*Ry  +  yr*[vxy*(sy-1)*PY + Ry]  +  (ZYC - yd)*sy*Ry
BY_11 = ──────────────────────────────────────────────────────────────────────────────
                                (sy-1) * (Ry - vxy*PY)
```
Where `ZYC = vzy*zr*pzy + rYY`, `pzy = pzx*(px/py)`.

### BY_11 simplified for cy = 0
```
          vxy*(xr-xd)*pxy  +  yr*[vxy*(sy-1) + sy]  +  (ZYC - yd)*sy²
BY_11 = ──────────────────────────────────────────────────────────────
                              (sy-1) * (sy - vxy)
```

### BY_01 (H_YX phase, general)
```
BY_01 = (xd*pYxyb - ZYX) * sy*Ry / ((sy-1)*PY) - yr
```
Where `ZYX = vzx*zr*pzy + rYX`.

### BY_10 (low leverage, yd > 0, xd = 0, general)
```
BY_10 = [yd - ZYC - vxy*xr*pYxyb] * sy*Ry / (vxy*(sy-1)*PY) - yr
```

### Final equilibrium reserves

```
x0 = max(0, xr + BX)
y0 = max(0, yr + BY)
xb = x0 / sx
yb = y0 / sy
```

---

## Denominator positivity

### General case: R - vyx*PX > 0

```
R - vyx*PX = (1+rx) - vyx*(cx + (1-cx)*sx)
```

Since `vyx < 1` and `PX = cx + (1-cx)*sx`:
- When cx = 0: `PX = sx`, so `R - vyx*PX = sx² - vyx*sx = sx*(sx - vyx) > 0`
  since sx > 1 > vyx.
- When cx > 0: PX < sx (mixing in the smaller cx term), so the denominator
  is even more positive.

More precisely: `PX ≤ sx` (with equality at cx=0), and `R = 1+rx ≥ sx²*(1-cx)+cx`.
Since `vyx < 1`, `vyx*PX < PX ≤ sx < sx² ≤ R/(1-cx)`. So R > vyx*PX always. ✓

### Degenerate limit: vyx → sx

If hypothetically vyx ≥ sx, the denominator approaches zero or becomes negative,
implying infinite leverage. This can't happen in practice since vyx < 1 < sx.

---

## Z-debt case

When Z is the debt asset (xd = yd = 0, zd > 0), the health constraint is different.
The pool has Z debt backed by X and Y collateral. The additive reformulation for
Z-debt follows the same principle (solve H_XZ = 1 at the boundary for BX), but
involves a transition-point calibration where health has a valley at x = x0 - xr
(where CXX first becomes 0 and CXY is still small).

The multiplicative code handles this with a quadratic in `t = bXC*bXL - 1`:
```
AQ·t² + BQ·t + CQ = 0
```

The additive version would substitute `t = BX/xr` (for xr > 0) or use a direct
formulation for BX. When xr = 0 the transition point x = x0 - xr = x0 is at
equilibrium itself, which may simplify the analysis.

**TODO:** Derive additive formulas for Z-debt cases (bZL01, bZL11) and verify
the transition-point constraint.

---

## Numerical verification

### Case 1: Original pool state (xr > 0, yd > 0)

```
xr=3611, yr=0.000394, xd=0, yd=0.32
vyx=0.84, vxy=0.85, px=1, py=1986, rx=ry=0.05, cx=cy=0
ZXC=ZYC=0
```

**X-side (bXL11):**
```
sx = sqrt(1.05) = 1.024695
pyx = 1986

Numerator = 0.84*(0.000394-0.32)*1986 + 3611*(0.84*0.024695 + 1.024695) + 0
          = -533.1 + 3611*1.045439
          = -533.1 + 3775.1
          = 3242.0

Denominator = 0.024695 * (1.024695 - 0.84) = 0.024695 * 0.184695 = 0.004561

BX = 3242.0 / 0.004561 = 710,746

x0 = 3611 + 710,746 = 714,357
```

Multiplicative formula gives: **x0 = 714,299** (0.008% difference from rounding)

**Validity checks:**
```
BX = 710,746 > xr/(sx-1) = 3611/0.024695 = 146,213 ✓  (CXX = 0)
yXdelta = (1/1986)*714,357*0.024695 = 8.88 >> yd = 0.32 ✓  (Y debt repaid)
```

**Health at boundary:**
```
xb = 714,357 / 1.024695 = 697,112
outflow = 17,245 > xr=3611 ✓
DXX = 17,245 - 3611 + 0 = 13,634
CXY = 0.000394 + 8.88 - 0.32 = 8.56 WETH
pXyxb = 1986/1.05 = 1891.4

H_XX = 0.84 * 8.56 * 1891.4 / 13,634 = 13,600 / 13,634 ≈ 1.000 ✓
```

### Case 2: After trading (xr = 0)

```
xr=0, yr=40.5, xd=13400, yd=0
vyx=0.84, vxy=0.85, px=1, py=1986, rx=ry=0.05, cx=cy=0
```

**X-side (bXL11):**
```
BX = [0.84*(40.5-0)*1986 + 0 + (0-13400)*1.024695²] / [0.024695*(1.024695-0.84)]
   = [67,564 - 14,070] / 0.004561
   = 53,494 / 0.004561
   = 11,729,448

x0 = 0 + 11,729,448 = 11.7M USDC
```

The multiplicative formula gives x0 = 0 (since xr = 0). The additive formula
correctly computes x0 = 11.7M backed by Y cross-collateral.

**Health at boundary:**
```
xb = 11,729,448 / 1.024695 = 11,447,327
outflow = 282,121 >> xr=0 ✓
DXX = 282,121 - 0 + 13,400 = 295,521
yXdelta = (1/1986)*11,729,448*0.024695 = 145.8 >> yd=0 ✓
CXY = 40.5 + 145.8 - 0 = 186.3 WETH
H = 0.84 * 186.3 * 1891.4 / 295,521 = 296,120 / 295,521 ≈ 1.002 ✓
```

**Y-side (bXL11, same after-trading state):**
```
BY = [0.85*(0-13400)*(1/1986) + 40.5*(0.85*0.024695+1.024695) + 0] / [0.024695*(1.024695-0.85)]
   = [-5.736 + 42.351] / [0.024695*0.174695]
   = 36.615 / 0.004314
   = 8,487

y0 = 40.5 + 8,487 = 8,527 WETH
```

**Health at Y boundary:**
```
yb = 8,527 / 1.024695 = 8,322
outflow = 205.5 > yr=40.5 ✓
DYY = 205.5 - 40.5 + 0 = 165
xYdelta = (1986/1)*8527*0.024695 = 418,200 USDC
CYX = 0 + 418,200 - 13,400 = 404,800 USDC
pYxyb = 1/(1986*1.05) = 0.000480
H = 0.85 * 404,800 * 0.000480 / 165 = 165.2 / 165 ≈ 1.001 ✓
```

### Case 3: Symmetric deposits, no debt

```
xr=1000, yr=1, xd=0, yd=0, vyx=0.85, px=1, py=2000, rx=0.05, cx=0
```

```
BX = [0.85*(1-0)*2000 + 1000*(0.85*0.0247+1.0247) + 0] / [0.0247*0.175]
   = [1700 + 1045.7] / 0.004322
   = 2745.7 / 0.004322
   = 635,279

x0 = 1000 + 635,279 = 636,279 (636x leverage)
```

---

## Comparison with multiplicative formulation

| Property | Multiplicative | Additive |
|----------|---------------|----------|
| Formula | `x0 = xr * bXC * bXL` | `x0 = xr + BX` |
| When xr=0 | `x0 = 0` always | `x0 = BX` (can be > 0) |
| Health at boundary | = 1 by construction | = 1 by construction |
| Equivalent when xr > 0 | Yes | Yes (verified to 0.01%) |
| General cx formula | Uses pXyxb directly | Uses R = 1+rx (correct for all cx) |
| Number of branches | 4 per side | 4 per side (same logical structure) |
| Handles xr = 0 | No | Yes |

**IMPORTANT correction:** The earlier version of this document used `sx²` in place of
`R = 1+rx` in the general formula. These are equal ONLY when cx = 0. For cx > 0,
the correct general formula uses R throughout (as presented in this version).

---

## Implementation notes

### For recentering a boosted pool

When the hook recenters a boosted pool at a new price (from inside `afterSwap`, or via a deploy script for the initial deploy):

1. Read current vault state: `(xr, yr, xd, yd)` from vault `balanceOf`,
   `convertToAssets`, and `debtOf`.
2. Read current market price → `py_new`.
3. Compute `BX` and `BY` using the additive formula with the current vault
   state and new price.
4. Set `x0 = max(0, xr + BX)`, `y0 = max(0, yr + BY)`.
5. Compute `xb = x0/sx`, `yb = y0/sy`.
6. Reconfigure: `eq0=x0, eq1=y0, min0=xb, min1=yb, priceY=py_new`.
7. Set `initialState = {reserve0: x0, reserve1: y0}` (reset to eq).

This works because reconfigure doesn't move tokens — the vault state at
the new equilibrium IS the current vault state.

### Edge cases

- `BX ≤ 0`: Position underwater or insufficient equity. Set `x0 = max(0, xr)`.
- `xr = 0, yr = 0`: No deposits. BX depends on `(ZXC - xd)` and cross-collateral.
  Usually BX ≤ 0 → no boost.
- `vyx ≥ sx`: Denominator approaches zero. Can't happen (vyx < 1 < sx).

---

## Future work

- Derive additive formula for Z-debt cases (bZL01, bZL11)
- Add transition-point calibration for Z-debt (quadratic constraint)
