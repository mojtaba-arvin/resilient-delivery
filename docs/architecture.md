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

The initial sampler is in-memory with bounded exponential forgetting. No control-plane call is needed to choose a route. No persistence or remote telemetry transport is implemented yet.

Retryable HTTP statuses: 408, 425, 429, 500, 502, 503, 504. GET, HEAD, OPTIONS, PUT, DELETE are treated as idempotent. Other methods get one attempt unless an Idempotency-Key is present; the server must enforce that key. Streaming request bodies are never replayed. Per-attempt deadlines default to 10 seconds and caller cancellation is not retried. Automatic redirects are disabled (`redirect: error`) to prevent following a redirect outside the configured allowlist. Only retryable statuses and network failures reduce route health; ordinary application 4xx responses do not.

Backoff uses bounded full-jitter-style delays (50–150% of the exponential ceiling, capped at 500ms by default). The values are configurable and injectable for deterministic tests.

Deferred: Ed25519 policy verification, service worker/offline queue, OTLP export, Rust collector, dashboard, HTTP/3 discovery, WebTransport, native SDKs.
