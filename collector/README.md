# Rust telemetry collector (initial ingestion edge)

This crate implements the versioned, privacy-minimized ingestion boundary. It is an early development component, not a durable telemetry service.

## Contract

- `POST /v1/telemetry/batches` accepts JSON `{ "schemaVersion": 1, "events": [...] }`.
- Each event follows `spec/telemetry-v1.schema.json`: `schemaVersion`, `routeIndex` (0–31), `outcome`, `durationMs` (0–600000), and optional HTTP `status` (100–599).
- Unknown fields are rejected. Event batches contain 1–100 observations.
- Request bodies are limited to 64 KiB.
- `Authorization: Bearer <token>` is mandatory. Configure `COLLECTOR_BEARER_TOKEN` with at least 32 characters; startup fails without it.
- A process-wide token bucket allows a burst of 30 requests and replenishes at 2 requests/second.
- A bounded queue (256 batches by default) applies immediate backpressure: full queues return 503; accepted requests return 202.

The token is never logged or stored in plaintext in application state; only its SHA-256 digest is retained and compared in constant time. Deploy behind TLS. The default bind address is loopback; configure `COLLECTOR_BIND` explicitly when running behind a trusted TLS-terminating ingress.

## Privacy and delivery semantics

The collector rejects unknown fields, including identifiers, IP addresses, URLs, and request bodies. It does not derive or persist client IP addresses. It does not log event contents.

**Important:** this milestone uses a bounded in-memory queue only. The executable drains queued batches without durable storage; process restart loses queued data. HTTP 202 means accepted into volatile memory, not persisted. DuckDB/Parquet persistence, durable acknowledgements, distributed rate limiting, per-tenant quotas, and OTLP compatibility are deferred.

## Run

```sh
COLLECTOR_BEARER_TOKEN="$(openssl rand -hex 32)" cargo run --manifest-path collector/Cargo.toml
```

Health check: `GET /healthz` (204). Ingestion: `POST /v1/telemetry/batches`.
