//! Shared test utilities: Anvil fork setup, test vector loading, address constants.

use alloy::primitives::{address, Address, U256};
use alloy::providers::ProviderBuilder;
use serde::Deserialize;

/// Pinned block for test vectors.
pub const TEST_BLOCK: u64 = 24_655_259;

// Contract addresses
pub const REGISTRY: Address = address!("5FcCB84363F020c0cADE052C9c654aABF932814A");

// Token addresses
pub const USDC: Address = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
pub const WETH: Address = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
pub const PYUSD: Address = address!("66bCF6151D5558AfB47c38B20663589843156078");
pub const USDT: Address = address!("dAC17F958D2ee523a2206206994597C13D831ec7");

// Pool addresses
pub const POOL_USDC_WETH: Address = address!("4311031739918Aba578C3C667DA3028A12Ce28A8");
pub const POOL_PYUSD_USDC: Address = address!("6FCFdf043FAef634e0Ae7dC7573cF308fDBB28A8");
pub const POOL_USDC_USDT: Address = address!("719529e99b7b272c5ef4CE07C30d15BC57CD68A8");

/// Expected pool addresses from registry at the pinned block.
pub const EXPECTED_POOLS: [Address; 4] = [
    address!("6FCFdf043FAef634e0Ae7dC7573cF308fDBB28A8"),
    address!("18cF1686721f50077b9020F69E638e9b2eb168A8"),
    address!("4311031739918Aba578C3C667DA3028A12Ce28A8"),
    address!("719529e99b7b272c5ef4CE07C30d15BC57CD68A8"),
];

/// Get fork URL from environment variable.
pub fn fork_url() -> String {
    std::env::var("FORK_URL").expect("FORK_URL env var required for fork tests (set to an Ethereum archive node RPC URL)")
}

/// Create a provider connected to an Anvil fork at the pinned block.
///
/// Requires `anvil` to be installed and FORK_URL env var set.
pub fn fork_provider() -> impl alloy::providers::Provider + Clone {
    let url = fork_url();
    ProviderBuilder::new()
        .connect_anvil_with_config(|anvil| {
            anvil
                .fork(url)
                .fork_block_number(TEST_BLOCK)
        })
}

/// Resolve a token symbol to its address.
pub fn token_address(symbol: &str) -> Address {
    match symbol {
        "USDC" => USDC,
        "WETH" => WETH,
        "PYUSD" => PYUSD,
        "USDT" => USDT,
        _ => panic!("Unknown token symbol: {symbol}"),
    }
}

/// Parse a string amount to U256.
pub fn parse_amount(s: &str) -> U256 {
    U256::from_str_radix(s, 10).expect("Invalid amount string")
}

// --- Test vector deserialization types ---

#[derive(Deserialize)]
pub struct TestVectors {
    #[serde(rename = "registryState")]
    pub registry_state: RegistryState,
    pub pools: Vec<PoolTestData>,
}

#[derive(Deserialize)]
pub struct RegistryState {
    pub registry: String,
    pub block: u64,
    #[serde(rename = "poolCount")]
    pub pool_count: u64,
    pub pools: Vec<String>,
    #[serde(rename = "installedStatus")]
    pub installed_status: Vec<bool>,
}

#[derive(Deserialize)]
pub struct PoolTestData {
    #[serde(rename = "_id")]
    pub id: String,
    pub pool: String,
    pub asset0: String,
    pub asset1: String,
    #[serde(rename = "asset0Symbol")]
    pub asset0_symbol: String,
    #[serde(rename = "asset1Symbol")]
    pub asset1_symbol: String,
    pub quotes: QuoteSet,
}

#[derive(Deserialize)]
pub struct QuoteSet {
    #[serde(rename = "exactIn", default)]
    pub exact_in: Vec<QuoteVector>,
    #[serde(rename = "exactOut", default)]
    pub exact_out: Vec<QuoteVector>,
    #[serde(rename = "zeroAmount", default)]
    pub zero_amount: Vec<QuoteVector>,
}

#[derive(Deserialize)]
pub struct QuoteVector {
    #[serde(rename = "tokenIn")]
    pub token_in: String,
    #[serde(rename = "tokenOut")]
    pub token_out: String,
    #[serde(rename = "amountIn", default)]
    pub amount_in: Option<String>,
    #[serde(rename = "amountOut", default)]
    pub amount_out: Option<String>,
    #[serde(rename = "expectedOut", default)]
    pub expected_out: Option<String>,
    #[serde(rename = "expectedIn", default)]
    pub expected_in: Option<String>,
    pub description: String,
}

/// Load test vectors from the embedded JSON.
pub fn load_test_vectors() -> TestVectors {
    let json = include_str!("../../../../spec/test-vectors.json");
    serde_json::from_str(json).expect("Failed to parse test-vectors.json")
}
