#![cfg(unix)]

use duckdb::Connection;
use std::{
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const TOKEN: &str = "integration-test-token-with-at-least-32-bytes";

fn test_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    env::temp_dir().join(format!(
        "resilient-delivery-shutdown-{}-{nonce}",
        std::process::id()
    ))
}

fn start_collector(directory: &Path) -> (Child, u16, PathBuf) {
    let reservation = TcpListener::bind("127.0.0.1:0").expect("reserve ephemeral port");
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);

    let database = directory.join("collector.duckdb");
    let parquet = directory.join("telemetry.parquet");
    let child = Command::new(env!("CARGO_BIN_EXE_resilient-delivery-collector"))
        .env("COLLECTOR_BEARER_TOKEN", TOKEN)
        .env("COLLECTOR_BIND", format!("127.0.0.1:{port}"))
        .env("COLLECTOR_DATABASE_PATH", &database)
        .env("COLLECTOR_PARQUET_PATH", &parquet)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start collector process");
    (child, port, parquet)
}

fn wait_until_ready(port: u16, child: &mut Child) {
    for _ in 0..100 {
        if let Some(status) = child.try_wait().expect("poll collector") {
            panic!("collector exited before becoming ready: {status}");
        }
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            if response.contains("204 No Content") {
                return;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("collector did not become ready within five seconds");
}

fn post_one_batch(port: u16) {
    let body = br#"{"schemaVersion":1,"events":[{"schemaVersion":1,"routeIndex":3,"outcome":"success","durationMs":37,"status":200}]}"#;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to collector");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "POST /v1/telemetry/batches HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nIdempotency-Key: shutdown-restart-key\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(body).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 202"),
        "unexpected ingest response: {response}"
    );
}

fn read_metrics(port: u16) -> serde_json::Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to collector metrics");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(
            format!(
                "GET /metrics HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "unexpected metrics response: {response}"
    );
    let body = response
        .split_once("\r\n\r\n")
        .expect("HTTP response body")
        .1;
    serde_json::from_str(body).expect("parse collector metrics JSON")
}

#[test]
fn committed_batch_survives_restart_and_deduplicates_replay() {
    let directory = test_directory();
    fs::create_dir_all(&directory).unwrap();
    let database = directory.join("collector.duckdb");

    let (mut first, first_port, parquet) = start_collector(&directory);
    wait_until_ready(first_port, &mut first);
    post_one_batch(first_port);
    let result = unsafe { libc::kill(first.id() as libc::pid_t, libc::SIGKILL) };
    assert_eq!(result, 0, "crash first collector process");
    let crash_status = first.wait().expect("wait for crashed collector");
    assert!(
        !crash_status.success(),
        "SIGKILL must not look like graceful shutdown"
    );

    let (mut restarted, second_port, second_parquet) = start_collector(&directory);
    wait_until_ready(second_port, &mut restarted);
    post_one_batch(second_port);
    let metrics = read_metrics(second_port);
    assert_eq!(metrics["batches_committed_total"], 0);
    assert_eq!(metrics["batches_deduplicated_total"], 1);

    let result = unsafe { libc::kill(restarted.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(result, 0, "stop restarted collector process");
    assert_clean_shutdown(restarted, &second_parquet);

    let connection = Connection::open(&database).expect("open database after restart");
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM observations", [], |row| row.get(0))
        .expect("count persisted observations");
    assert_eq!(
        count, 1,
        "restart replay must not duplicate the committed event"
    );
    fs::remove_dir_all(directory).unwrap();
}

fn assert_clean_shutdown(mut child: Child, parquet: &Path) {
    let mut exit_status = None;
    for _ in 0..200 {
        if let Some(status) = child.try_wait().expect("poll collector shutdown") {
            exit_status = Some(status);
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let Some(status) = exit_status else {
        let _ = child.kill();
        let _ = child.wait();
        panic!("collector did not finish graceful shutdown within ten seconds");
    };
    assert!(
        status.success(),
        "collector exited unsuccessfully: {status}"
    );
    assert!(
        parquet.is_file(),
        "graceful shutdown did not publish Parquet snapshot"
    );

    let connection = Connection::open_in_memory().expect("open DuckDB verifier");
    let path = parquet.to_string_lossy().replace('\'', "''");
    let count: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM read_parquet('{path}')"),
            [],
            |row| row.get(0),
        )
        .expect("read shutdown snapshot");
    assert_eq!(
        count, 1,
        "shutdown snapshot must contain the acknowledged event"
    );
}

fn exercise_signal(signal: i32) {
    let directory = test_directory();
    fs::create_dir_all(&directory).unwrap();
    eprintln!("shutdown integration: starting collector for signal {signal}");
    let (mut child, port, parquet) = start_collector(&directory);
    eprintln!("shutdown integration: waiting for health check on port {port}");
    wait_until_ready(port, &mut child);
    eprintln!("shutdown integration: posting telemetry batch");
    post_one_batch(port);

    eprintln!("shutdown integration: sending signal {signal}");
    let result = unsafe { libc::kill(child.id() as libc::pid_t, signal) };
    assert_eq!(result, 0, "send shutdown signal to collector");
    eprintln!("shutdown integration: verifying process exit and Parquet snapshot");
    assert_clean_shutdown(child, &parquet);
    fs::remove_dir_all(directory).unwrap();
    eprintln!("shutdown integration: completed signal {signal}");
}

#[test]
fn sigterm_drains_committed_work_and_exports_parquet() {
    exercise_signal(libc::SIGTERM);
}

#[test]
fn sigint_drains_committed_work_and_exports_parquet() {
    exercise_signal(libc::SIGINT);
}
