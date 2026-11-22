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

Retryable HTTP statuses: 408, 425, 429, 500, 502, 503, 504. GET, HEAD, OPTIONS, PUT, DELETE are treated as idempotent. Other methods get one attempt unless an Idempotency-Key is present; the server must enforce that key.

Deferred: jittered backoff, request deadlines, Ed25519 policy verification, service worker/offline queue, OTLP export, Rust collector, dashboard, HTTP/3 discovery, WebTransport, native SDKs.
