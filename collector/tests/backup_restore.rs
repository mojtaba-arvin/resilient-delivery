use duckdb::Connection;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn test_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "resilient-delivery-duckdb-backup-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create test directory");
    path
}

#[test]
fn backup_and_restore_preserve_a_real_duckdb_database() {
    let directory = test_directory();
    let database = directory.join("collector.duckdb");
    let backup = directory.join("backups/collector.duckdb");
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/backup-restore.mjs");

    let connection = Connection::open(&database).expect("create DuckDB database");
    connection
        .execute_batch(
            "CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, value VARCHAR); \
             INSERT INTO backup_probe VALUES (1, 'committed-before-backup');",
        )
        .expect("insert real DuckDB row");
    connection.execute_batch("CHECKPOINT").expect("checkpoint source database");
    drop(connection);

    let result = Command::new("node")
        .arg(&script)
        .arg("backup")
        .arg(&database)
        .arg(&backup)
        .output()
        .expect("run backup script");
    assert!(
        result.status.success(),
        "backup script failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let connection = Connection::open(&database).expect("reopen source DuckDB");
    connection
        .execute("UPDATE backup_probe SET value = 'mutated-after-backup' WHERE id = 1", [])
        .expect("mutate source after backup");
    connection.execute_batch("CHECKPOINT").expect("checkpoint mutated source");
    drop(connection);

    let result = Command::new("node")
        .arg(&script)
        .arg("restore")
        .arg(&backup)
        .arg(&database)
        .output()
        .expect("run restore script");
    assert!(
        result.status.success(),
        "restore script failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let connection = Connection::open(&database).expect("open restored DuckDB database");
    let value: String = connection
        .query_row("SELECT value FROM backup_probe WHERE id = 1", [], |row| row.get(0))
        .expect("query restored DuckDB row");
    assert_eq!(value, "committed-before-backup");
    drop(connection);
    fs::remove_dir_all(directory).expect("remove test directory");
}
