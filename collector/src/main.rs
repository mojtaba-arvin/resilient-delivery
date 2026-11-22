use resilient_delivery_collector::{
    export_parquet, open_store, persist_batch, router, DEFAULT_QUEUE_CAPACITY,
};
use std::{env, net::SocketAddr, path::PathBuf};
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
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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

    // Open and initialize durable storage before accepting traffic.
    let connection = open_store(&database_path)?;
    let (app, mut queue) = router(&token, DEFAULT_QUEUE_CAPACITY);
    let consumer = task::spawn_blocking(move || {
        let mut connection = connection;
        while let Some(queued) = queue.blocking_recv() {
            let result = persist_batch(&mut connection, &queued.batch);
            let committed = result.is_ok();
            if queued.acknowledgement.send(result.map_err(|_| ())).is_err() {
                // The client disconnected while the transaction was committing.
                // The committed data remains durable; clients must tolerate retry duplicates.
            }
            if !committed {
                eprintln!("collector storage transaction failed");
            }
        }
        export_parquet(&connection, &parquet_path)?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });

    let listener = TcpListener::bind(address).await?;
    eprintln!("collector listening on {}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = signal::ctrl_c().await;
        })
        .await?;

    // The server drops its sender on shutdown. The worker drains accepted batches,
    // then publishes a Parquet snapshot before it exits.
    consumer.await??;
    Ok(())
}
