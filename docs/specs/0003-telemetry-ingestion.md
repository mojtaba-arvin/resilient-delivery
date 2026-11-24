# Spec 0003: telemetry batch ingestion

- Status: DuckDB transactional persistence implemented; Parquet snapshot export on graceful shutdown
- Version: 1

## Request

`POST /v1/telemetry/batches` accepts JSON:

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "schemaVersion": 1,
      "routeIndex": 0,
      "outcome": "success",
      "durationMs": 42,
      "status": 200
    }
  ]
}
```

Each observation follows `spec/telemetry-v1.schema.json`. Unknown properties are rejected. A batch must contain 1–100 events; each route index is 0–31, duration is 0–600000 ms, and optional HTTP status is 100–599. The complete request body is limited to 64 KiB.

## Authentication and admission control

- Every ingestion request requires `Authorization: Bearer <token>`.
- The executable refuses to start unless `COLLECTOR_BEARER_TOKEN` is configured with at least 32 characters.
- The process retains only the SHA-256 digest of the configured token and compares candidate digests in constant time.
- A process-wide token bucket has a burst capacity of 30 and refills at 2 requests/second.
- A bounded in-memory queue has a default capacity of 256 batches. Queue saturation returns 503; rate exhaustion returns 429.
- Deployments must terminate TLS at a trusted ingress. The default listener binds to loopback.

## Durable storage and responses

The collector opens a local DuckDB database before binding its HTTP listener. Each accepted batch is written as one database transaction. A failure inserting any event rolls back all rows in that batch. The request handler waits for the storage worker's commit result.

- 202: the complete batch transaction committed to DuckDB.
- 400: malformed JSON, unknown fields, or invalid schema values.
- 401: missing or invalid bearer token.
- 413: request exceeds the body limit.
- 429: process-wide admission limit exceeded.
- 503: queue is full/closed or the storage transaction failed.

DuckDB is the durable recovery source. `COLLECTOR_DATABASE_PATH` defaults to `data/collector.duckdb`. On graceful shutdown, the worker drains accepted batches and exports a Parquet snapshot to `COLLECTOR_PARQUET_PATH` (default `data/telemetry.parquet`). The snapshot is written to a sibling temporary file, fsynced, and atomically renamed. After an ungraceful termination the Parquet snapshot may be stale; the DuckDB database remains the source used on restart and a subsequent graceful shutdown regenerates the snapshot.

The protocol currently provides at-least-once client semantics, not exactly-once delivery. If the database commit succeeds but the HTTP response is lost, a client retry can insert duplicate observations. Batch idempotency requires a separately versioned request contract.

## Privacy

The collector accepts only the fields defined by the telemetry schema. It rejects arbitrary properties such as IP addresses, user/device identifiers, URLs, and request bodies. Event payloads and bearer tokens are never logged.

## Operational boundaries

The store is local to one process and filesystem. Replication, multi-writer coordination, retention/compaction, tenant isolation, distributed quotas, and OTLP compatibility are not implemented.