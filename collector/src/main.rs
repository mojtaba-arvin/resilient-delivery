use resilient_delivery_collector::{
    export_parquet, open_store, persist_batch_idempotent, prune_retention, router, CommitError,
    IdempotencyConflict, DEFAULT_QUEUE_CAPACITY,
};
use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, signal, task};

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            tokio::select! {
                _ = signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let token = env::var("COLLECTOR_BEARER_TOKEN").map_err(|_| {
        "COLLECTOR_BEARER_TOKEN must be configured; refusing unauthenticated startup"
    })?;
    if token.len() < 32 {
        return Err("COLLECTOR_BEARER_TOKEN must contain at least 32 characters".into());
    }

    let address: SocketAddr = env::var("COLLECTOR_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;
    let database_path = PathBuf::from(
        env::var("COLLECTOR_DATABASE_PATH").unwrap_or_else(|_| "data/collector.duckdb".to_owned()),
    );
    let parquet_path = PathBuf::from(
        env::var("COLLECTOR_PARQUET_PATH").unwrap_or_else(|_| "data/telemetry.parquet".to_owned()),
    );

    let retention_days: u32 = env::var("COLLECTOR_RETENTION_DAYS")
        .unwrap_or_else(|_| "0".to_owned())
        .parse()
        .map_err(|_| "COLLECTOR_RETENTION_DAYS must be an integer")?;
    if retention_days > 36_500 {
        return Err("COLLECTOR_RETENTION_DAYS must not exceed 36500".into());
    }

    // Open and initialize durable storage before accepting traffic.
    let mut connection = open_store(&database_path)?;
    if retention_days > 0 {
        prune_retention(&mut connection, retention_days)?;
    }
    let (app, mut queue) = router(&token, DEFAULT_QUEUE_CAPACITY);
    let consumer = task::spawn_blocking(move || {
        let mut connection = connection;
        let mut last_retention = Instant::now();
        while let Some(queued) = queue.blocking_recv() {
            if retention_days > 0 && last_retention.elapsed() >= Duration::from_secs(3600) {
                if prune_retention(&mut connection, retention_days).is_err() {
                    eprintln!("collector retention maintenance failed");
                }
                last_retention = Instant::now();
            }
            let idempotency = queued
                .idempotency
                .as_ref()
                .map(|(key, digest)| (key.as_str(), digest.as_str()));
            let result = persist_batch_idempotent(&mut connection, &queued.batch, idempotency);
            let acknowledgement = match result {
                Ok(outcome) => Ok(outcome),
                Err(error) if error.downcast_ref::<IdempotencyConflict>().is_some() => {
                    Err(CommitError::IdempotencyConflict)
                }
                Err(_) => {
                    eprintln!("collector storage transaction failed");
                    Err(CommitError::Storage)
                }
            };
            let _ = queued.acknowledgement.send(acknowledgement);
        }
        if retention_days > 0 {
            prune_retention(&mut connection, retention_days)?;
        }
        export_parquet(&connection, &parquet_path)?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });

    let listener = TcpListener::bind(address).await?;
    eprintln!("collector listening on {}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // The server drops its sender on shutdown. The worker drains accepted batches,
    // then publishes a Parquet snapshot before it exits.
    consumer.await??;
    Ok(())
}
