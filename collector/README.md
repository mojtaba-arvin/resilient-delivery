# Rust telemetry collector

The collector is a privacy-minimized ingestion service backed by a durable DuckDB database. A Parquet snapshot is published on graceful shutdown.

## Contract

- `POST /v1/telemetry/batches` accepts JSON `{ "schemaVersion": 1, "events": [...] }`.
- Each event follows `spec/telemetry-v1.schema.json`: `schemaVersion`, `routeIndex` (0–31), `outcome`, `durationMs` (0–600000), and optional HTTP `status` (100–599).
- Unknown fields are rejected. Event batches contain 1–100 observations.
- Request bodies are limited to 64 KiB.
- `Authorization: Bearer <token>` is mandatory. Configure `COLLECTOR_BEARER_TOKEN` with at least 32 characters; startup fails without it.
- A process-wide token bucket allows a burst of 30 requests and replenishes at 2 requests/second.
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
- `COLLECTOR_RETENTION_DAYS` accepts 0 (disabled) through 36500. When enabled, pruning runs at startup, approximately hourly while batches are being processed, and during graceful shutdown. It deletes old rows and receipts transactionally; it does not compact the DuckDB file or reclaim all filesystem space.

The token is never logged or stored in plaintext in application state; only its SHA-256 digest is retained and compared in constant time. Event payloads and credentials are never logged. Deploy behind TLS. The default bind address is loopback; configure `COLLECTOR_BIND` explicitly when running behind a trusted TLS-terminating ingress.

## Run

```sh
COLLECTOR_BEARER_TOKEN="$(openssl rand -hex 32)" cargo run --manifest-path collector/Cargo.toml
```

Health check: `GET /healthz` (204). Ingestion: `POST /v1/telemetry/batches`.

## Current boundaries

Storage is local to one collector process and filesystem. There is no replication, multi-writer coordination, tenant isolation, retention/compaction policy, distributed rate limiting, OTLP compatibility, or exactly-once batch deduplication. Protect and back up the DuckDB file and its containing volume; do not put it on an unsupported network filesystem.