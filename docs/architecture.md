# Architecture (initial)

The first vertical slice is a browser-only TypeScript SDK. It establishes the critical contract: local route selection across a finite, owner-configured origin set without unsafe request replay.

```text
Application -> ResilientClient -> allowlisted origins
                         |              |
                         v              v
                 local Thompson     Fetch attempt
                    sampler              |
                         <---- outcome / score update

Optional local observation callback (explicit consent only)
```

The initial sampler is in-memory with bounded exponential forgetting. No control-plane call is needed to choose a route. The SDK exposes opt-in minimized observations; applications must obtain consent before enabling telemetry transport.

Retryable HTTP statuses: 408, 425, 429, 500, 502, 503, 504. GET, HEAD, OPTIONS, PUT, DELETE are treated as idempotent. Other methods get one attempt unless an Idempotency-Key is present; the server must enforce that key. Streaming request bodies are never replayed. Per-attempt deadlines default to 10 seconds and caller cancellation is not retried. Automatic redirects are disabled (`redirect: error`) to prevent following a redirect outside the configured allowlist. Only retryable statuses and network failures reduce route health; ordinary application 4xx responses do not.

Backoff uses bounded full-jitter-style delays (50–150% of the exponential ceiling, capped at 500ms by default). The values are configurable and injectable for deterministic tests.

Signed policy verification uses Ed25519 and may only narrow the application's configured origin allowlist. The IndexedDB policy-version adapter advances versions transactionally and fails closed when persistent browser storage is unavailable. Browser storage eviction or user deletion remains outside the SDK's control.

Implemented on separate workstreams: bounded IndexedDB offline queue with optional Service Worker wake-up, Ed25519 policy publishing/distribution, authenticated metrics and read-only dashboard, benchmark and network-fault tooling, Node.js SDK, and optional OTLP gateway. The gateway accepts OTLP/HTTP and OTLP/gRPC and translates minimized logs; the Rust collector remains JSON-ingestion-only. Native Python/Go/mobile SDKs and transports such as HTTP/3/WebTransport remain future work.

## Rust collector ingestion edge

The Axum ingestion boundary accepts only schema-versioned, minimized observations. It requires a configured bearer token, enforces a 64 KiB body cap and 100-event batch cap, and applies a process-wide token bucket. A bounded Tokio channel provides immediate backpressure (503 when full). A single blocking storage worker writes each batch in one DuckDB transaction. The HTTP handler waits for the transaction result; 202 is returned only after commit. The DuckDB database is the restart recovery source of truth. On graceful shutdown, the worker drains accepted batches and writes a Parquet snapshot to a temporary sibling file, fsyncs it, and atomically renames it. An ungraceful stop can leave the Parquet snapshot stale while committed DuckDB data remains available for recovery.

Delivery is at-least-once rather than exactly-once. If a client loses the HTTP response after a successful commit, a retry can create duplicates; batch idempotency is not yet in the protocol. The store is local to one process/filesystem and does not provide replication, multi-writer coordination, retention/compaction, or tenant isolation.


## Offline execution boundary

The Service Worker uses Background Sync only to wake controlled pages; it does not persist credentials or send telemetry itself. Background Sync is browser-dependent and best-effort. It cannot guarantee delivery while a browser is fully closed, terminated, or prevented by the operating system from running background tasks. Page startup and the `online` event provide additional flush opportunities, but browser storage eviction and user-cleared site data remain outside the SDK's control.
