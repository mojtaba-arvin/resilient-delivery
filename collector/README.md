# Rust telemetry collector

The collector is a privacy-minimized ingestion service backed by a durable DuckDB database. A Parquet snapshot is published on graceful shutdown.

## Contract

- `POST /v1/telemetry/batches` accepts JSON `{ "schemaVersion": 1, "events": [...] }`.
- Each event follows `spec/telemetry-v1.schema.json`: `schemaVersion`, `routeIndex` (0–31), `outcome`, `durationMs` (0–600000), and optional HTTP `status` (100–599).
- Unknown fields are rejected. Event batches contain 1–100 observations.
- Request bodies are limited to 64 KiB.
- `Authorization: Bearer <token>` is mandatory. Configure `COLLECTOR_BEARER_TOKEN` with at least 32 characters, or provide `COLLECTOR_TENANT_TOKENS` as a JSON array of unique 32+ character bearer tokens.
- Each bearer token has an independent token bucket (burst 30, refill 2 requests/second). The SHA-256 token digest selects the quota and scopes idempotency receipts; different tenants can reuse the same client key. This provides per-token quotas and dedupe namespaces, not separate tenant databases or per-tenant query authorization.
- A bounded queue (256 batches by default) applies immediate backpressure when full.
- Optional `Idempotency-Key` values (1–128 visible ASCII characters) make retries safe: the collector stores the key and SHA-256 digest of the exact request bytes in the same DuckDB transaction as the observations.
- Optional retention pruning removes old observations and their idempotency receipts in one transaction. Configure `COLLECTOR_RETENTION_DAYS`; zero (default) disables pruning.

**HTTP 202 is returned only after the entire batch commits in one DuckDB transaction.** If the queue is full or the database transaction fails, the collector returns 503 instead. A batch is never acknowledged merely because it entered the in-memory queue.

## Durable storage and Parquet

- `COLLECTOR_DATABASE_PATH` selects the DuckDB database; default: `data/collector.duckdb`.
- `COLLECTOR_PARQUET_PATH` selects the Parquet snapshot; default: `data/telemetry.parquet`.
- The database is opened and initialized before the listener accepts traffic. Each batch is inserted in a single transaction; a failed row rolls back the complete batch.
- DuckDB is the recovery source of truth. Its transaction log/database is reopened on restart, so committed batches survive process restarts.
- On graceful shutdown, the worker drains accepted batches and exports a full Parquet snapshot to a sibling temporary file, fsyncs it, and atomically renames it into place.
- An ungraceful termination can leave the Parquet snapshot behind the database. Restart from the DuckDB file and perform a graceful shutdown to regenerate it.
- When `Idempotency-Key` is supplied, the collector stores its key and request-body SHA-256 digest atomically with the batch. Repeating the same key and exact payload returns 202 without inserting observations again; reusing the key with different bytes returns 409. Requests without the header retain at-least-once behavior.
- Idempotency receipts survive a process restart because they are stored in DuckDB. When retention is enabled, receipts are pruned with observations; therefore the configured retention period is also the deduplication guarantee window. Choose a period longer than the maximum client retry horizon.
- `COLLECTOR_RETENTION_DAYS` accepts 0 (disabled) through 36500. When enabled, pruning runs at startup, approximately hourly while batches are being processed, and during graceful shutdown. It deletes old rows and receipts transactionally and issues a DuckDB `CHECKPOINT` to consolidate the write-ahead log. This is not a guaranteed physical database-file shrink; reclaiming free pages requires an offline database rebuild/compaction procedure and remains an operational follow-up.

The token is never logged or stored in plaintext in application state; only its SHA-256 digest is retained and compared in constant time. Event payloads and credentials are never logged. Deploy behind TLS. The default bind address is loopback; configure `COLLECTOR_BIND` explicitly when running behind a trusted TLS-terminating ingress.

## Run

```sh
COLLECTOR_BEARER_TOKEN="$(openssl rand -hex 32)" cargo run --manifest-path collector/Cargo.toml
```

Liveness: `GET /healthz` (204). Readiness: `GET /readyz` (204). Authenticated metrics: `GET /metrics`. Ingestion: `POST /v1/telemetry/batches`.

## Current boundaries

Storage is local to one collector process and filesystem. There is no replication, multi-writer coordination, tenant isolation, physical database-file compaction, distributed rate limiting, or OTLP compatibility. Batch deduplication is opt-in through `Idempotency-Key` and is bounded by the configured retention window. Protect and back up the DuckDB file and its containing volume; do not put it on an unsupported network filesystem.
## Multi-tenant token quotas

Set `COLLECTOR_TENANT_TOKENS` to a JSON array of unique bearer tokens, each at least 32 characters. Each token has an independent in-memory quota. Buckets reset on restart and are local to one process. No tenant identifier is added to event payloads.

## Container deployment

The repository root includes a non-root multi-stage `Dockerfile` and hardened `compose.yaml`. The default Compose port is loopback-only; terminate TLS at a trusted ingress. Keep DuckDB on a supported persistent local volume and back it up. Configure `COLLECTOR_RETENTION_DAYS` to set the retention/deduplication window.

## Offline physical compaction

Retention checkpoints the write-ahead log but does not guarantee physical file shrinkage. Stop the collector, take a verified backup, then run the offline rebuild command:

```sh
docker compose stop collector
docker compose run --rm --no-deps --entrypoint /usr/local/bin/compact collector /data/collector.duckdb
docker compose start collector
```

The command rebuilds the database in a sibling file and atomically replaces the original. Do not run it while any process has the database open.

## OTLP JSON adapter

`integration/otlp-json-adapter.mjs` accepts OTLP JSON Logs at `POST /v1/logs` and maps only the explicit `resilient.route_index`, `resilient.outcome`, `resilient.duration_ms`, and optional `http.response.status_code` attributes. Log bodies, resource attributes, and unrelated fields are discarded. It is not a complete OTLP protobuf/gRPC implementation and does not synthesize idempotency keys; upstream retries remain at-least-once. The pure converter has Node tests for mapping, bounds, and privacy minimization. Configure `COLLECTOR_URL`, `COLLECTOR_BEARER_TOKEN`, and optionally `OTLP_ADAPTER_PORT`.
