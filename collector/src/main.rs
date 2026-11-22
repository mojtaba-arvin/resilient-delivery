use resilient_delivery_collector::{router, QueuedBatch, DEFAULT_QUEUE_CAPACITY};
use std::{env, net::SocketAddr};
use tokio::{net::TcpListener, signal};

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
    let (app, mut queue) = router(&token, DEFAULT_QUEUE_CAPACITY);
    // The queue is intentionally volatile in this first vertical slice. The next
    // storage milestone will replace this drain with a durable Parquet writer.
    let consumer = tokio::spawn(async move {
        while let Some(QueuedBatch(_batch)) = queue.recv().await {
            // Never log observation payloads; no durable persistence is claimed.
        }
    });

    let listener = TcpListener::bind(address).await?;
    eprintln!("collector listening on {}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = signal::ctrl_c().await;
        })
        .await?;
    consumer.await?;
    Ok(())
}
