# Observability, benchmark, and fault-injection lab

## Authenticated collector metrics

The collector exposes `GET /metrics` as bearer-authenticated JSON. It reports ingestion request totals, committed batches/events, idempotent duplicates, authentication and validation failures, rate limiting, queue rejections, storage failures, idempotency conflicts, and current queue capacity/availability.

Serve `dashboard/index.html` through the same origin as the collector, typically behind a reverse proxy that serves the static file and forwards `/metrics` to the collector. The collector does not enable permissive CORS. Enter the collector URL and bearer token in the page. The token is held only in page memory; it is not written to local storage. Do not expose the metrics endpoint publicly without TLS and access controls.

## Benchmark

```sh
COLLECTOR_BEARER_TOKEN="$COLLECTOR_BEARER_TOKEN" node scripts/benchmark-collector.mjs --url=http://127.0.0.1:8080/v1/telemetry/batches --requests=30 --concurrency=4
```

The script reports throughput, p50/p95/p99 latency, and HTTP status distribution. The collector's default rate limiter (burst 30, refill 2 requests/second) materially affects results; this benchmark does not bypass it. Run repeated trials on an otherwise idle host and record hardware, build mode, database path, and configuration before comparing numbers.

## Fault injection proxy

For local development only:

```sh
node scripts/fault-proxy.mjs --target=http://127.0.0.1:8080 --port=9080 --delayMs=150 --failEvery=5 --status=503
```

The proxy can add fixed latency, return a chosen status every Nth request, or drop every Nth connection. Point a local test client at the proxy. It binds only to loopback and does not log request bodies or authorization values. Do not use it as a production proxy.

## Limits

Metrics are in-memory and reset when the collector restarts. They are process-local, not a durable audit log or distributed monitoring system. The dashboard is a thin read-only view; no historical time series or multi-tenant views are included.
