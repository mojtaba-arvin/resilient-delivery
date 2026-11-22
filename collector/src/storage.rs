use duckdb::{params, Connection};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

use crate::{Outcome, TelemetryBatch};

pub fn open_store(
    path: impl AsRef<Path>,
) -> Result<Connection, Box<dyn std::error::Error + Send + Sync>> {
    let path = path.as_ref();
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS batch_receipts (
            idempotency_key VARCHAR PRIMARY KEY,
            payload_sha256 VARCHAR NOT NULL,
            accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS observations (
            schema_version UTINYINT NOT NULL,
            route_index UTINYINT NOT NULL CHECK (route_index <= 31),
            outcome VARCHAR NOT NULL,
            duration_ms UINTEGER NOT NULL CHECK (duration_ms <= 600000),
            status USMALLINT CHECK (status IS NULL OR (status >= 100 AND status <= 599)),
            ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;
    Ok(connection)
}

/// Commits a complete batch in one DuckDB transaction. The caller acknowledges
/// the HTTP request only after this function returns successfully.
pub fn persist_batch(
    connection: &mut Connection,
    batch: &TelemetryBatch,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let transaction = connection.transaction()?;
    for event in &batch.events {
        let outcome = match event.outcome {
            Outcome::Success => "success",
            Outcome::NetworkError => "network_error",
            Outcome::HttpError => "http_error",
        };
        transaction.execute(
            "INSERT INTO observations (schema_version, route_index, outcome, duration_ms, status)
             VALUES (?, ?, ?, ?, ?)",
            params![
                event.schema_version,
                event.route_index,
                outcome,
                event.duration_ms,
                event.status
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistOutcome {
    Inserted,
    Duplicate,
}

#[derive(Debug)]
pub struct IdempotencyConflict;

impl std::fmt::Display for IdempotencyConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("idempotency key was already used with a different payload")
    }
}

impl std::error::Error for IdempotencyConflict {}

/// Persists a batch and its idempotency receipt in the same transaction.
/// Replaying the same key and payload is a successful no-op; reusing a key
/// with a different payload is rejected without changing stored observations.
pub fn persist_batch_idempotent(
    connection: &mut Connection,
    batch: &TelemetryBatch,
    idempotency: Option<(&str, &str)>,
) -> Result<PersistOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let transaction = connection.transaction()?;

    if let Some((key, payload_sha256)) = idempotency {
        let count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM batch_receipts WHERE idempotency_key = ?",
            params![key],
            |row| row.get(0),
        )?;
        if count > 0 {
            let existing: String = transaction.query_row(
                "SELECT payload_sha256 FROM batch_receipts WHERE idempotency_key = ?",
                params![key],
                |row| row.get(0),
            )?;
            if existing != payload_sha256 {
                return Err(Box::new(IdempotencyConflict));
            }
            return Ok(PersistOutcome::Duplicate);
        }
    }

    for event in &batch.events {
        let outcome = match event.outcome {
            Outcome::Success => "success",
            Outcome::NetworkError => "network_error",
            Outcome::HttpError => "http_error",
        };
        transaction.execute(
            "INSERT INTO observations (schema_version, route_index, outcome, duration_ms, status)
             VALUES (?, ?, ?, ?, ?)",
            params![
                event.schema_version,
                event.route_index,
                outcome,
                event.duration_ms,
                event.status
            ],
        )?;
    }

    if let Some((key, payload_sha256)) = idempotency {
        transaction.execute(
            "INSERT INTO batch_receipts (idempotency_key, payload_sha256) VALUES (?, ?)",
            params![key, payload_sha256],
        )?;
    }

    transaction.commit()?;
    Ok(PersistOutcome::Inserted)
}

/// Writes a consistent Parquet snapshot to a sibling temporary file and then
/// atomically replaces the destination. DuckDB remains the recovery source of truth.
pub fn export_parquet(
    connection: &Connection,
    destination: impl AsRef<Path>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let destination = destination.as_ref();
    if let Some(parent) = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let temporary = temporary_path(destination);
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }

    let escaped = temporary.to_string_lossy().replace('\'', "''");
    let sql = format!(
        "COPY (SELECT schema_version, route_index, outcome, duration_ms, status, ingested_at FROM observations ORDER BY ingested_at) TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    );
    connection.execute_batch(&sql)?;
    File::open(&temporary)?.sync_all()?;
    fs::rename(&temporary, destination)?;
    if let Some(parent) = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn temporary_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    destination.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Observation, Outcome};
    use std::{
        env,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("resilient-delivery-{nonce}"))
    }

    fn sample_batch() -> TelemetryBatch {
        TelemetryBatch {
            schema_version: 1,
            events: vec![Observation {
                schema_version: 1,
                route_index: 2,
                outcome: Outcome::Success,
                duration_ms: 42,
                status: Some(200),
            }],
        }
    }

    #[test]
    fn committed_batches_survive_reopening_the_database() {
        let directory = test_dir();
        let database = directory.join("collector.duckdb");
        {
            let mut connection = open_store(&database).unwrap();
            persist_batch(&mut connection, &sample_batch()).unwrap();
        }
        {
            let connection = open_store(&database).unwrap();
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM observations", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exports_a_readable_parquet_snapshot() {
        let directory = test_dir();
        let database = directory.join("collector.duckdb");
        let parquet = directory.join("snapshots/telemetry.parquet");
        let mut connection = open_store(&database).unwrap();
        persist_batch(&mut connection, &sample_batch()).unwrap();
        export_parquet(&connection, &parquet).unwrap();

        assert!(parquet.metadata().unwrap().len() > 0);
        let parquet_sql_path = parquet.to_string_lossy().replace('\'', "''");
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM read_parquet('{parquet_sql_path}')"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_row_rolls_back_the_entire_batch() {
        let directory = test_dir();
        let database = directory.join("collector.duckdb");
        let mut connection = open_store(&database).unwrap();
        let mut batch = sample_batch();
        batch.events.push(Observation {
            schema_version: 1,
            route_index: 255,
            outcome: Outcome::NetworkError,
            duration_ms: 1,
            status: None,
        });
        assert!(persist_batch(&mut connection, &batch).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM observations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
