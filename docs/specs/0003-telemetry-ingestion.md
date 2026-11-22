# Spec 0003: telemetry batch ingestion

- Status: Initial Rust/Axum ingestion boundary implemented; durable storage deferred
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
- A bounded in-memory queue has a default capacity of 256 batches. A full queue returns 503; rate exhaustion returns 429.
- Deployments must terminate TLS at a trusted ingress. The default listener binds to loopback.

## Responses and durability

- 202: batch enqueued in volatile process memory.
- 400: malformed JSON, unknown fields, or invalid schema values.
- 401: missing or invalid bearer token.
- 413: request exceeds the body limit.
- 429: process-wide admission limit exceeded.
- 503: bounded queue is full or unavailable.

**202 is not a durable acknowledgement.** The initial executable drains the queue and does not persist observations. Process termination can lose accepted batches. DuckDB/Parquet storage, durable acknowledgements, tenant-aware quotas, and OTLP compatibility require a later milestone.

## Privacy

The collector accepts only the fields defined by the telemetry schema. It rejects arbitrary properties such as IP addresses, user/device identifiers, URLs, and request bodies. Event payloads and bearer tokens are never logged.
