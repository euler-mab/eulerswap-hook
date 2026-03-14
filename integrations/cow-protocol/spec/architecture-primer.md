# CoW Protocol Driver Architecture Primer

How the CoW driver works and where EulerSwap fits in.

## Auction Lifecycle

CoW Protocol runs **batch auctions** every ~5 seconds:

```
1. COLLECT      Users submit signed trade intents (off-chain)
2. BATCH        Autopilot groups pending intents into an auction
3. DISTRIBUTE   Autopilot sends auction to all registered drivers
4. FETCH        Driver fetches liquidity from all configured sources    ← EulerSwap fits here
5. SOLVE        Driver forwards orders + liquidity to solver engine
6. COMPETE      Solver engine returns candidate solutions
7. SELECT       Driver picks best solution, encodes settlement
8. SETTLE       Winning driver submits on-chain settlement tx
```

## Component Roles

```
┌──────────┐     ┌────────────┐     ┌───────────────┐     ┌──────────────┐
│ Autopilot│────▶│   Driver   │────▶│ Solver Engine  │     │  Settlement  │
│          │     │            │     │  (external)    │     │  Contract    │
│ Batches  │     │ • Fetches  │     │                │     │              │
│ orders,  │     │   liquidity│     │ • Computes     │     │ • Executes   │
│ runs     │     │ • Sends to │     │   optimal      │     │   trades +   │
│ auction  │     │   solver   │     │   routing      │     │   AMM calls  │
│          │     │ • Encodes  │     │                │     │              │
└──────────┘     │   settlement│    └───────────────┘     └──────────────┘
                 └─────────────┘
```

**Autopilot** — Protocol-operated. Runs the auction, collects orders, selects winner.
**Driver** — Per-solver-team. Shared infrastructure: liquidity fetching, settlement encoding, solution validation. Each solver team runs their own driver instance.
**Solver Engine** — Custom HTTP server per team. Receives orders + available liquidity, returns solutions. This is where routing optimization happens.
**Settlement Contract** — On-chain (`0x9008...0ab41`). Executes the winning solution: transfers tokens between users and AMMs.

## Where Liquidity Sources Fit

The driver maintains a **liquidity collector** — a list of liquidity source modules that run concurrently:

```rust
// Pseudocode from cowprotocol/services
struct LiquidityCollector {
    sources: Vec<Box<dyn LiquidityCollecting>>,
}

impl LiquidityCollector {
    async fn get_liquidity(&self, pairs: HashSet<TokenPair>, block: Block) -> Vec<Liquidity> {
        // Run ALL sources concurrently
        let futures = self.sources.iter()
            .map(|s| s.get_liquidity(pairs.clone(), block));
        join_all(futures).await.into_iter().flatten().collect()
    }
}
```

Each source implements `LiquidityCollecting`:

```rust
#[async_trait]
trait LiquidityCollecting: Send + Sync {
    async fn get_liquidity(
        &self,
        pairs: HashSet<TokenPair>,
        at_block: Block,
    ) -> Result<Vec<Liquidity>>;
}
```

**EulerSwap becomes one entry in this list.** When the driver prepares an auction, it calls all sources in parallel. EulerSwap's implementation returns pool state for any registered pools matching the requested token pairs.

## Data Flow: Liquidity Source → Solver → Settlement

### Step 1: Fetch (per block)

The EulerSwap source:
1. Checks which `pairs` overlap with known EulerSwap pools
2. Fetches current state via multicall: `getReserves()` + `getDynamicParams()`
3. Returns `Vec<Liquidity>` with pool parameters

### Step 2: Serialize to Solver

The driver converts domain `Liquidity` objects to JSON DTOs and sends them to the solver:

```json
{
  "id": "euler_swap_0x4311...",
  "kind": "EulerSwap",
  "tokens": { "asset0": "0xA0b8...", "asset1": "0xC02a..." },
  "reserves": { "reserve0": "633609943779", "reserve1": "296143607353420043666" },
  "equilibriumReserves": { ... },
  "concentrationX": "0",
  "concentrationY": "0",
  "fee0": "5000000000000000",
  "fee1": "5000000000000000",
  "gasEstimate": "150000"
}
```

The solver uses these parameters to compute optimal swap amounts across all available liquidity.

### Step 3: Solver Returns Solution

If the solver routes through EulerSwap, it returns a `LiquidityInteraction`:

```json
{
  "id": "euler_swap_0x4311...",
  "inputToken": "0xC02a...",
  "outputToken": "0xA0b8...",
  "inputAmount": "1000000000000000000",
  "outputAmount": "2055313102"
}
```

### Step 4: Encode Settlement

The driver's boundary layer converts this into on-chain interactions:

```rust
fn to_interaction(pool, input, output, settlement) -> Vec<Interaction> {
    vec![
        // Transfer input tokens to pool
        Interaction { target: input.token, calldata: transfer(pool.address, input.amount) },
        // Call swap
        Interaction { target: pool.address, calldata: swap(amount0Out, amount1Out, settlement, "") },
    ]
}
```

These interactions go into the settlement transaction alongside user trade executions.

## Legacy Solver Crate

The `cowprotocol/services` repo contains a legacy `solver` crate alongside the modern `driver`
crate. New liquidity sources must integrate with **both**:

- **`driver` crate** — modern architecture with `LiquidityCollecting`, `SettlementHandling<L>`,
  domain types, and DTOs. This is the primary integration path.
- **`solver` crate** — legacy baseline solver that uses `BaselineSolvable` for offline quoting.
  Still active and needs wiring for EulerSwap pools.

The `BaselineSolvable` trait has a notable API pattern — it uses `impl Future` return types
rather than `async_trait`:

```rust
trait BaselineSolvable {
    fn get_amount_out(&self, out_token: Address, input: (Address, U256))
        -> impl Future<Output = Option<U256>> + Send;
    fn get_amount_in(&self, in_token: Address, output: (Address, U256))
        -> impl Future<Output = Option<U256>> + Send;
    fn gas_cost(&self) -> usize;
}
```

## Three-Layer Architecture

The driver separates concerns into three layers:

### Infrastructure (`driver/src/infra/`)
- Config parsing (TOML)
- Contract bindings (from ABIs)
- RPC calls and caching

### Boundary (`driver/src/boundary/`)
- Converts infrastructure types ↔ domain types
- Implements `LiquidityCollecting` trait
- Encodes settlement interactions

### Domain (`driver/src/domain/`)
- Canonical `Liquidity` type with `Kind` enum
- Business logic (validation, gas estimation)
- No RPC or I/O dependencies

```
Config (TOML) → Infra (RPC, cache) → Boundary (convert) → Domain (Liquidity)
                                                               ↓
                                          Solver ← DTO (JSON) ← Boundary (serialize)
                                            ↓
                                          Solution → Boundary (encode) → Settlement TX
```

## Timing Constraints

- **Auction window:** ~5 seconds from batch distribution to solution deadline
- **Liquidity fetch:** Must complete within ~1-2 seconds (runs concurrently with order processing)
- **Quote computation:** Solvers compute hundreds of quotes per auction. Latency matters.
  - Phase 1 (eth_call): ~50ms per quote. Acceptable for low pool count but limits throughput.
  - Phase 2 (native Rust): <1μs per quote. Required for competitive solving with many pools.

## State Freshness

EulerSwap pools can change state on every block:
- **Reserves** change on every swap
- **DynamicParams** change when the hook triggers a recenter or auction (can happen on any swap)
- **Fees** are dynamic — determined by hook at swap time based on oracle price, exposure, gas

The driver fetches state at the start of each auction round (tagged with block number). Between fetch and settlement (~5-10 seconds), state may become stale. This is acceptable — the settlement validates on-chain, and the solver accounts for potential slippage.

**Key invariant:** The driver must never cache state across auction rounds. Each round starts with fresh state at the current block.
