use std::error::Error;
use substreams_ethereum::Abigen;

fn main() -> Result<(), Box<dyn Error>> {
    Abigen::new("EulerSwapRegistry", "abi/EulerSwapRegistry.json")?
        .generate()?
        .write_to_file("src/abi/euler_swap_registry.rs")?;

    Abigen::new("EulerSwapPool", "abi/EulerSwapPool.json")?
        .generate()?
        .write_to_file("src/abi/euler_swap_pool.rs")?;

    Ok(())
}
