use duckdb::{params, Connection};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

use crate::{Outcome, TelemetryBatch};

pub fn open_store(path: impl AsRef<Path>) -> Result<Connection, Box<dyn std::error::Error + Send + Sync>> {
    let path = path.as_ref();
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS observations (
            schema_version UTINYINT NOT NULL,
            route_index UTINYINT NOT NULL,
            outcome VARCHAR NOT NULL,
            duration_ms UINTEGER NOT NULL,
            status USMALLINT,
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

/// Writes a consistent Parquet snapshot to a sibling temporary file and then
/// atomically replaces the destination. DuckDB remains the recovery source of truth.
pub fn export_parquet(
    connection: &Connection,
    destination: impl AsRef<Path>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let destination = destination.as_ref();
    if let Some(parent) = destination.parent().filter(|parent| !parent.as_os_str().is_empty()) {
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
    if let Some(parent) = destination.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn temporary_path(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .unwrap_or_default()
        .to_os_string();
    name.push(".tmp");
    destination.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Observation, Outcome};
    use std::{env, time::{SystemTime, UNIX_EPOCH}};

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
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
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM read_parquet('{}')", parquet.display()),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_batch_does_not_partially_commit() {
        let directory = test_dir();
        let database = directory.join("collector.duckdb");
        let mut connection = open_store(&database).unwrap();
        let mut batch = sample_batch();
        batch.events.push(Observation {
            schema_version: 1,
            route_index: 0,
            outcome: Outcome::NetworkError,
            duration_ms: 1,
            status: None,
        });
        // Storage accepts only validated batches from the HTTP boundary; this
        // test exercises transaction rollback on a database-level constraint.
        connection.execute_batch(
            "ALTER TABLE observations ADD CONSTRAINT route_index_bound CHECK (route_index <= 31)"
        ).unwrap();
        batch.events[1].route_index = 255;
        assert!(persist_batch(&mut connection, &batch).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM observations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
