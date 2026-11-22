use axum::body::Bytes;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};

pub mod storage;
pub use storage::{export_parquet, open_store, persist_batch};

pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_BATCH_EVENTS: usize = 100;
pub const DEFAULT_QUEUE_CAPACITY: usize = 256;
const RATE_CAPACITY: f64 = 30.0;
const RATE_PER_SECOND: f64 = 2.0;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    NetworkError,
    HttpError,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub schema_version: u8,
    pub route_index: u8,
    pub outcome: Outcome,
    pub duration_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryBatch {
    pub schema_version: u8,
    pub events: Vec<Observation>,
}

impl TelemetryBatch {
    fn validate(&self) -> Result<(), ApiError> {
        if self.schema_version != 1
            || self.events.is_empty()
            || self.events.len() > MAX_BATCH_EVENTS
        {
            return Err(ApiError::BadRequest);
        }
        for event in &self.events {
            if event.schema_version != 1
                || event.route_index > 31
                || event.duration_ms > 600_000
                || event
                    .status
                    .is_some_and(|status| !(100..=599).contains(&status))
            {
                return Err(ApiError::BadRequest);
            }
        }
        Ok(())
    }
}

pub struct QueuedBatch {
    pub batch: TelemetryBatch,
    pub acknowledgement: oneshot::Sender<Result<(), ()>>,
}

#[derive(Clone)]
struct AppState {
    token_digest: [u8; 32],
    sender: mpsc::Sender<QueuedBatch>,
    limiter: Arc<Mutex<TokenBucket>>,
}

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new() -> Self {
        Self {
            tokens: RATE_CAPACITY,
            last_refill: Instant::now(),
        }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * RATE_PER_SECOND).min(RATE_CAPACITY);
        self.last_refill = now;
        if self.tokens < 1.0 {
            false
        } else {
            self.tokens -= 1.0;
            true
        }
    }
}

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    TooManyRequests,
    Unavailable,
    BadRequest,
}

impl ApiError {
    fn response(self) -> (StatusCode, &'static str) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_batch"),
        }
    }
}

pub fn router(bearer_token: &str, queue_capacity: usize) -> (Router, mpsc::Receiver<QueuedBatch>) {
    let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
    let state = AppState {
        token_digest: Sha256::digest(bearer_token.as_bytes()).into(),
        sender,
        limiter: Arc::new(Mutex::new(TokenBucket::new())),
    };
    let app = Router::new()
        .route(
            "/healthz",
            axum::routing::get(|| async { StatusCode::NO_CONTENT }),
        )
        .route("/v1/telemetry/batches", post(ingest))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);
    (app, receiver)
}

async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    authenticate(&state, &headers).map_err(ApiError::response)?;
    let batch: TelemetryBatch =
        serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest.response())?;
    batch.validate().map_err(ApiError::response)?;

    let allowed = state
        .limiter
        .lock()
        .map(|mut limiter| limiter.allow())
        .unwrap_or(false);
    if !allowed {
        return Err(ApiError::TooManyRequests.response());
    }

    let (acknowledgement, committed) = oneshot::channel();
    state
        .sender
        .try_send(QueuedBatch {
            batch,
            acknowledgement,
        })
        .map_err(|_| ApiError::Unavailable.response())?;

    match committed.await {
        Ok(Ok(())) => Ok(StatusCode::ACCEPTED),
        Ok(Err(())) | Err(_) => Err(ApiError::Unavailable.response()),
    }
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .ok_or(ApiError::Unauthorized)?;
    let value = value.to_str().map_err(|_| ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    if bool::from(candidate.ct_eq(&state.token_digest)) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    fn batch() -> String {
        r#"{"schemaVersion":1,"events":[{"schemaVersion":1,"routeIndex":0,"outcome":"success","durationMs":42}]}"#.to_owned()
    }

    fn request(body: String) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/telemetry/batches")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer test-secret")
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn rejects_missing_or_invalid_credentials() {
        let (app, _rx) = router("test-secret", 4);
        let missing = Request::builder()
            .method("POST")
            .uri("/v1/telemetry/batches")
            .body(Body::from(batch()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(missing).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let wrong = Request::builder()
            .method("POST")
            .uri("/v1/telemetry/batches")
            .header(header::AUTHORIZATION, "Bearer wrong")
            .body(Body::from(batch()))
            .unwrap();
        assert_eq!(
            app.oneshot(wrong).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn acknowledges_only_after_storage_worker_commits() {
        let (app, mut rx) = router("test-secret", 4);
        // Tower's oneshot future is lazy: it must be polled before the handler
        // can enqueue a batch. Run it as a task while the test worker receives
        // and acknowledges the queued item.
        let request =
            tokio::spawn(async move { app.oneshot(request(batch())).await.unwrap().status() });
        let queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("request was not enqueued within five seconds")
            .expect("collector queue closed before receiving the request");
        assert_eq!(queued.batch.events.len(), 1);
        queued.acknowledgement.send(Ok(())).unwrap();
        assert_eq!(request.await.unwrap(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn rejects_unknown_fields_and_invalid_values() {
        let (app, _rx) = router("test-secret", 4);
        let unknown = r#"{"schemaVersion":1,"events":[],"ip":"203.0.113.1"}"#;
        assert_eq!(
            app.clone()
                .oneshot(request(unknown.into()))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let invalid = r#"{"schemaVersion":1,"events":[{"schemaVersion":1,"routeIndex":32,"outcome":"success","durationMs":1}]}"#;
        assert_eq!(
            app.oneshot(request(invalid.into())).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn applies_backpressure_when_queue_is_full() {
        let (app, mut rx) = router("test-secret", 1);
        let first_app = app.clone();
        let first =
            tokio::spawn(
                async move { first_app.oneshot(request(batch())).await.unwrap().status() },
            );
        let first_queued = rx.recv().await.unwrap();

        let second_app = app.clone();
        let second =
            tokio::spawn(
                async move { second_app.oneshot(request(batch())).await.unwrap().status() },
            );
        // Keep the queued request in the bounded channel while checking that
        // the second producer has filled it. Bound this synchronization so a
        // scheduling regression cannot hang the entire collector test suite.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while rx.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("second request was not queued within five seconds");

        assert_eq!(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                app.oneshot(request(batch()))
            )
            .await
            .expect("backpressure response timed out")
            .unwrap()
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let second_queued = rx.recv().await.unwrap();
        first_queued.acknowledgement.send(Ok(())).unwrap();
        second_queued.acknowledgement.send(Ok(())).unwrap();
        assert_eq!(first.await.unwrap(), StatusCode::ACCEPTED);
        assert_eq!(second.await.unwrap(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn rejects_oversized_request_bodies() {
        let (app, _rx) = router("test-secret", 4);
        let body = " ".repeat(MAX_BODY_BYTES + 1);
        assert_eq!(
            app.oneshot(request(body)).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn enforces_process_wide_rate_limit() {
        let (app, mut rx) = router("test-secret", 40);
        for _ in 0..30 {
            // Spawn the lazy Tower future before waiting for the worker queue.
            let request_task = tokio::spawn({
                let app = app.clone();
                async move { app.oneshot(request(batch())).await.unwrap().status() }
            });
            let queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("rate-limit request was not enqueued")
                .expect("collector queue closed");
            queued
                .acknowledgement
                .send(Ok(()))
                .unwrap();
            assert_eq!(request_task.await.unwrap(), StatusCode::ACCEPTED);
        }
        assert_eq!(
            app.oneshot(request(batch())).await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn rejects_batches_larger_than_contract_limit() {
        let (app, _rx) = router("test-secret", 4);
        let events = (0..=MAX_BATCH_EVENTS)
            .map(|_| r#"{"schemaVersion":1,"routeIndex":0,"outcome":"success","durationMs":1}"#)
            .collect::<Vec<_>>()
            .join(",");
        let body = format!(r#"{{"schemaVersion":1,"events":[{events}]}}"#);
        assert_eq!(
            app.oneshot(request(body)).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
}
