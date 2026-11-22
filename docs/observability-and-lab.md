# Observability, benchmark, and fault-injection lab

## Authenticated collector metrics

The collector exposes `GET /metrics` as bearer-authenticated JSON. It reports ingestion request totals, committed batches/events, idempotent duplicates, authentication and validation failures, rate limiting, queue rejections, storage failures, idempotency conflicts, and current queue capacity/availability.

Serve `dashboard/index.html` through the same origin as the collector, typically behind a reverse proxy that serves the static file and forwards `/metrics` to the collector. The collector does not enable permissive CORS. Enter the collector URL and bearer token in the page. The token is held only in page memory; it is not written to local storage. Do not expose the metrics endpoint publicly without TLS and access controls.

## Benchmark

```sh
COLLECTOR_RATE_CAPACITY=10000 COLLECTOR_RATE_PER_SECOND=10000 ./collector/target/release/resilient-delivery-collector &
COLLECTOR_BEARER_TOKEN="$COLLECTOR_BEARER_TOKEN" node scripts/benchmark-collector.mjs --url=http://127.0.0.1:8080/v1/telemetry/batches --requests=1000 --warmup=100 --concurrency=32
```

The runner performs a separate warm-up phase, uses unique idempotency keys, reports run metadata, throughput, p50/p95/p99 latency, and status distribution, and exits non-zero if any measured request is not accepted. Configure the collector's bounded `COLLECTOR_RATE_CAPACITY` and `COLLECTOR_RATE_PER_SECOND` above the offered load for a capacity test; defaults remain burst 30/refill 2 requests per second. Never raise these limits without matching queue, storage, and infrastructure capacity. Run at least five trials on an otherwise idle host and record CPU, memory, storage, build mode, database path, and rate/queue settings. Compare only runs from equivalent hardware and configuration with `scripts/benchmark-regression.mjs`.

## Fault injection proxy

For local development only:

```sh
node scripts/fault-proxy.mjs --target=http://127.0.0.1:8080 --port=9080 --delayMs=150 --failEvery=5 --status=503
```

The proxy can add fixed latency, return a chosen status every Nth request, or drop every Nth connection. Point a local test client at the proxy. It binds only to loopback and does not log request bodies or authorization values. Do not use it as a production proxy.

## Limits

Metrics are in-memory and reset when the collector restarts. They are process-local, not a durable audit log or distributed monitoring system. The dashboard is a thin read-only view; no historical time series or multi-tenant views are included.
