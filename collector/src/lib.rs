use axum::body::Bytes;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};

pub mod storage;
pub use storage::{
    compact_store, export_parquet, open_store, persist_batch, persist_batch_idempotent,
    prune_retention, IdempotencyConflict, PersistOutcome, RetentionSummary,
};

pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_BATCH_EVENTS: usize = 100;
pub const DEFAULT_QUEUE_CAPACITY: usize = 256;
pub const MAX_TENANT_TOKENS: usize = 1000;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitError {
    Storage,
    IdempotencyConflict,
}

pub struct QueuedBatch {
    pub batch: TelemetryBatch,
    pub idempotency: Option<(String, String)>,
    pub acknowledgement: oneshot::Sender<Result<PersistOutcome, CommitError>>,
}

#[derive(Default)]
struct CollectorMetrics {
    requests_total: AtomicU64,
    batches_committed_total: AtomicU64,
    events_committed_total: AtomicU64,
    batches_deduplicated_total: AtomicU64,
    auth_failures_total: AtomicU64,
    invalid_batches_total: AtomicU64,
    rate_limited_total: AtomicU64,
    queue_rejected_total: AtomicU64,
    storage_errors_total: AtomicU64,
    idempotency_conflicts_total: AtomicU64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MetricsSnapshot {
    pub requests_total: u64,
    pub batches_committed_total: u64,
    pub events_committed_total: u64,
    pub batches_deduplicated_total: u64,
    pub auth_failures_total: u64,
    pub invalid_batches_total: u64,
    pub rate_limited_total: u64,
    pub queue_rejected_total: u64,
    pub storage_errors_total: u64,
    pub idempotency_conflicts_total: u64,
    pub queue_capacity: usize,
    pub queue_available: usize,
}

#[derive(Clone)]
struct AppState {
    token_digests: Vec<[u8; 32]>,
    sender: mpsc::Sender<QueuedBatch>,
    limiter: Arc<Mutex<HashMap<[u8; 32], TokenBucket>>>,
    metrics: Arc<CollectorMetrics>,
    rate_capacity: f64,
    rate_per_second: f64,
}

impl AppState {
    fn snapshot(&self) -> MetricsSnapshot {
        let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        MetricsSnapshot {
            requests_total: load(&self.metrics.requests_total),
            batches_committed_total: load(&self.metrics.batches_committed_total),
            events_committed_total: load(&self.metrics.events_committed_total),
            batches_deduplicated_total: load(&self.metrics.batches_deduplicated_total),
            auth_failures_total: load(&self.metrics.auth_failures_total),
            invalid_batches_total: load(&self.metrics.invalid_batches_total),
            rate_limited_total: load(&self.metrics.rate_limited_total),
            queue_rejected_total: load(&self.metrics.queue_rejected_total),
            storage_errors_total: load(&self.metrics.storage_errors_total),
            idempotency_conflicts_total: load(&self.metrics.idempotency_conflicts_total),
            queue_capacity: self.sender.max_capacity(),
            queue_available: self.sender.capacity(),
        }
    }
}

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
    capacity: f64,
    refill_per_second: f64,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_second: f64) -> Self {
        Self {
            tokens: capacity,
            last_refill: Instant::now(),
            capacity,
            refill_per_second,
        }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_second).min(self.capacity);
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
    IdempotencyConflict,
}

impl ApiError {
    fn response(self) -> (StatusCode, &'static str) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_batch"),
            Self::IdempotencyConflict => (StatusCode::CONFLICT, "idempotency_conflict"),
        }
    }
}

pub fn router(bearer_token: &str, queue_capacity: usize) -> (Router, mpsc::Receiver<QueuedBatch>) {
    router_with_tokens(&[bearer_token.to_owned()], queue_capacity)
}

/// Creates an ingestion router with one independent rate-limit bucket per
/// bearer token. Tokens are hashed immediately; raw credentials are not retained.
pub fn router_with_tokens(
    tokens: &[String],
    queue_capacity: usize,
) -> (Router, mpsc::Receiver<QueuedBatch>) {
    router_with_tokens_and_limits(tokens, queue_capacity, RATE_CAPACITY, RATE_PER_SECOND)
}

pub fn router_with_tokens_and_limits(
    tokens: &[String],
    queue_capacity: usize,
    rate_capacity: f64,
    rate_per_second: f64,
) -> (Router, mpsc::Receiver<QueuedBatch>) {
    assert!(rate_capacity.is_finite() && (1.0..=1_000_000.0).contains(&rate_capacity));
    assert!(rate_per_second.is_finite() && (0.01..=1_000_000.0).contains(&rate_per_second));
    assert!(
        !tokens.is_empty(),
        "at least one collector token is required"
    );
    assert!(
        tokens.len() <= MAX_TENANT_TOKENS,
        "tenant token count exceeds configured safety limit"
    );
    let token_digests: Vec<[u8; 32]> = tokens
        .iter()
        .map(|token| Sha256::digest(token.as_bytes()).into())
        .collect();
    let mut unique = token_digests.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        token_digests.len(),
        "collector tokens must be unique"
    );

    let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
    let state = AppState {
        token_digests,
        sender,
        limiter: Arc::new(Mutex::new(HashMap::new())),
        metrics: Arc::new(CollectorMetrics::default()),
        rate_capacity,
        rate_per_second,
    };
    let app = Router::new()
        .route("/healthz", get(|| async { StatusCode::NO_CONTENT }))
        .route("/readyz", get(|| async { StatusCode::NO_CONTENT }))
        .route("/metrics", get(metrics))
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
    state.metrics.requests_total.fetch_add(1, Ordering::Relaxed);
    let tenant_digest = match authenticate(&state, &headers) {
        Ok(digest) => digest,
        Err(error) => {
            state
                .metrics
                .auth_failures_total
                .fetch_add(1, Ordering::Relaxed);
            return Err(error.response());
        }
    };
    let batch: TelemetryBatch = match serde_json::from_slice(&body) {
        Ok(batch) => batch,
        Err(_) => {
            state
                .metrics
                .invalid_batches_total
                .fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::BadRequest.response());
        }
    };
    if batch.validate().is_err() {
        state
            .metrics
            .invalid_batches_total
            .fetch_add(1, Ordering::Relaxed);
        return Err(ApiError::BadRequest.response());
    }
    let event_count = batch.events.len() as u64;

    let idempotency = match headers.get("idempotency-key") {
        None => None,
        Some(value) => {
            let key = value
                .to_str()
                .map_err(|_| ApiError::BadRequest.response())?;
            if key.is_empty() || key.len() > 128 || !key.bytes().all(|byte| byte.is_ascii_graphic())
            {
                return Err(ApiError::BadRequest.response());
            }
            let digest = format!("{:x}", Sha256::digest(&body));
            // Scope receipt keys to the authenticated tenant so two tenants
            // can safely choose the same client-generated idempotency key.
            let tenant_scope = tenant_digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let scoped_key = format!("{tenant_scope}:{key}");
            Some((scoped_key, digest))
        }
    };

    let allowed = state
        .limiter
        .lock()
        .map(|mut limiters| {
            limiters
                .entry(tenant_digest)
                .or_insert_with(|| TokenBucket::new(state.rate_capacity, state.rate_per_second))
                .allow()
        })
        .unwrap_or(false);
    if !allowed {
        state
            .metrics
            .rate_limited_total
            .fetch_add(1, Ordering::Relaxed);
        return Err(ApiError::TooManyRequests.response());
    }

    let (acknowledgement, committed) = oneshot::channel();
    if state
        .sender
        .try_send(QueuedBatch {
            batch,
            idempotency,
            acknowledgement,
        })
        .is_err()
    {
        state
            .metrics
            .queue_rejected_total
            .fetch_add(1, Ordering::Relaxed);
        return Err(ApiError::Unavailable.response());
    }

    match committed.await {
        Ok(Ok(PersistOutcome::Inserted)) => {
            state
                .metrics
                .batches_committed_total
                .fetch_add(1, Ordering::Relaxed);
            state
                .metrics
                .events_committed_total
                .fetch_add(event_count, Ordering::Relaxed);
            Ok(StatusCode::ACCEPTED)
        }
        Ok(Ok(PersistOutcome::Duplicate)) => {
            state
                .metrics
                .batches_deduplicated_total
                .fetch_add(1, Ordering::Relaxed);
            Ok(StatusCode::ACCEPTED)
        }
        Ok(Err(CommitError::IdempotencyConflict)) => {
            state
                .metrics
                .idempotency_conflicts_total
                .fetch_add(1, Ordering::Relaxed);
            Err(ApiError::IdempotencyConflict.response())
        }
        Ok(Err(CommitError::Storage)) | Err(_) => {
            state
                .metrics
                .storage_errors_total
                .fetch_add(1, Ordering::Relaxed);
            Err(ApiError::Unavailable.response())
        }
    }
}

async fn metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MetricsSnapshot>, (StatusCode, &'static str)> {
    authenticate(&state, &headers).map_err(ApiError::response)?;
    Ok(Json(state.snapshot()))
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .ok_or(ApiError::Unauthorized)?;
    let value = value.to_str().map_err(|_| ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    state
        .token_digests
        .iter()
        .find(|digest| bool::from(candidate.ct_eq(*digest)))
        .copied()
        .ok_or(ApiError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{HeaderValue, Request},
    };
    use tower::ServiceExt;

    fn batch() -> String {
        r#"{"schemaVersion":1,"events":[{"schemaVersion":1,"routeIndex":0,"outcome":"success","durationMs":42}]}"#.to_owned()
    }

    fn request(body: String) -> Request<Body> {
        request_with_token(body, "test-secret")
    }

    fn request_with_token(body: String, token: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/telemetry/batches")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn metrics_endpoint_requires_bearer_authentication() {
        let (app, _rx) = router("test-secret", 4);
        let unauthorized = Request::builder()
            .uri("/metrics")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(unauthorized).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let authorized = Request::builder()
            .uri("/metrics")
            .header(header::AUTHORIZATION, "Bearer test-secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(authorized).await.unwrap().status(),
            StatusCode::OK
        );
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
        queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
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
    async fn idempotency_keys_are_scoped_to_authenticated_tenant() {
        let tokens = vec!["tenant-a-secret".to_owned(), "tenant-b-secret".to_owned()];
        let (app, mut rx) = router_with_tokens(&tokens, 4);

        let mut first_request = request_with_token(batch(), "tenant-a-secret");
        first_request.headers_mut().insert(
            "idempotency-key",
            HeaderValue::from_static("shared-client-key"),
        );
        let first = tokio::spawn({
            let app = app.clone();
            async move { app.oneshot(first_request).await.unwrap().status() }
        });
        let first_queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("tenant A request was not queued")
            .unwrap();
        let first_key = first_queued.idempotency.as_ref().unwrap().0.clone();
        first_queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
        assert_eq!(first.await.unwrap(), StatusCode::ACCEPTED);

        let mut second_request = request_with_token(batch(), "tenant-b-secret");
        second_request.headers_mut().insert(
            "idempotency-key",
            HeaderValue::from_static("shared-client-key"),
        );
        let second = tokio::spawn({
            let app = app.clone();
            async move { app.oneshot(second_request).await.unwrap().status() }
        });
        let second_queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("tenant B request was not queued")
            .unwrap();
        let second_key = second_queued.idempotency.as_ref().unwrap().0.clone();
        second_queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
        assert_eq!(second.await.unwrap(), StatusCode::ACCEPTED);
        assert_ne!(first_key, second_key);
    }

    #[tokio::test]
    async fn bearer_tenants_have_independent_rate_limit_buckets() {
        let tokens = vec!["tenant-a-secret".to_owned(), "tenant-b-secret".to_owned()];
        let (app, mut rx) = router_with_tokens(&tokens, 40);
        for _ in 0..30 {
            let request_task = tokio::spawn({
                let app = app.clone();
                async move {
                    app.oneshot(request_with_token(batch(), "tenant-a-secret"))
                        .await
                        .unwrap()
                        .status()
                }
            });
            let queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("tenant A rate-limit request was not queued")
                .unwrap();
            queued
                .acknowledgement
                .send(Ok(PersistOutcome::Inserted))
                .unwrap();
            assert_eq!(request_task.await.unwrap(), StatusCode::ACCEPTED);
        }
        let tenant_b = tokio::spawn({
            let app = app.clone();
            async move {
                app.oneshot(request_with_token(batch(), "tenant-b-secret"))
                    .await
                    .unwrap()
                    .status()
            }
        });
        let queued = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("tenant B request was not queued")
            .unwrap();
        queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
        assert_eq!(tenant_b.await.unwrap(), StatusCode::ACCEPTED);
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
        first_queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
        second_queued
            .acknowledgement
            .send(Ok(PersistOutcome::Inserted))
            .unwrap();
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
    async fn enforces_per_tenant_rate_limit() {
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
                .send(Ok(PersistOutcome::Inserted))
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
