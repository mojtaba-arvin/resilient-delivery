use resilient_delivery_collector::compact_store;
use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let database = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| env::var_os("COLLECTOR_DATABASE_PATH").map(PathBuf::from))
        .ok_or("usage: compact <collector.duckdb> (or set COLLECTOR_DATABASE_PATH)")?;
    compact_store(&database)?;
    eprintln!("compacted DuckDB database at {}", database.display());
    Ok(())
}
