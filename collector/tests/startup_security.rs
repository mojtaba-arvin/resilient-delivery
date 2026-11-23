use std::{
    fs,
    net::TcpListener,
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[test]
fn shared_storage_collector_rejects_multiple_bearer_tokens_before_startup() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "resilient-delivery-multi-token-startup-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).expect("create isolated test directory");
    let database = directory.join("collector.duckdb");
    let reservation = TcpListener::bind("127.0.0.1:0").expect("reserve ephemeral port");
    let address = reservation.local_addr().expect("read reserved port");
    drop(reservation);

    let mut child = Command::new(env!("CARGO_BIN_EXE_resilient-delivery-collector"))
        .env(
            "COLLECTOR_TENANT_TOKENS",
            r#"["tenant-a-token-with-at-least-32-characters","tenant-b-token-with-at-least-32-characters"]"#,
        )
        .env_remove("COLLECTOR_BEARER_TOKEN")
        .env("COLLECTOR_BIND", address.to_string())
        .env("COLLECTOR_DATABASE_PATH", &database)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("launch collector binary");

    let mut exit_status = None;
    for _ in 0..200 {
        if let Some(status) = child.try_wait().expect("poll collector startup") {
            exit_status = Some(status);
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let Some(status) = exit_status else {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("collector did not fail closed on multiple shared-storage tokens");
    };

    assert!(!status.success(), "collector unexpectedly accepted multiple tokens");
    assert!(
        !database.exists(),
        "collector opened shared storage before rejecting multiple tokens"
    );
    assert!(
        TcpListener::bind(address).is_ok(),
        "collector bound its listener before rejecting multiple tokens"
    );
    fs::remove_dir_all(directory).expect("remove isolated test directory");
}
