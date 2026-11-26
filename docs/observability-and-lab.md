# Observability, benchmark, and fault-injection lab

## Authenticated collector metrics

The collector exposes \`GET /metrics\` as bearer-authenticated JSON. It reports ingestion request totals, committed batches/events, idempotent duplicates, authentication and validation failures, rate limiting, queue rejections, storage failures, idempotency conflicts, and current queue capacity/availability.

Serve \`dashboard/index.html\` through the same origin as the collector, typically behind a reverse proxy that serves the static file and forwards \`/metrics\` to the collector. The collector does not enable permissive CORS. Enter the collector URL and bearer token in the page. The token is held only in page memory; it is not written to local storage. Do not expose the metrics endpoint publicly without TLS and access controls.

## Repeatable benchmark

Run against a dedicated, otherwise idle collector with a test-only token:

\`\`\`sh
COLLECTOR_BEARER_TOKEN="$COLLECTOR_BEARER_TOKEN" node scripts/benchmark-collector.mjs --url=http://127.0.0.1:8080/v1/telemetry/batches --requests=30 --concurrency=4 --warmup=10 --trials=5 --pause-ms=15000
\`\`\`

Each trial runs sequentially with fresh idempotency keys. Optional warm-up requests run before measurement and are reported separately, not included in measured throughput. The default 15-second pause between trials allows the default burst-30 token bucket to refill at 2 requests/second; override it with `--pause-ms` only when the rate-limit configuration justifies doing so. The output includes aggregate and per-trial p50/p95/p99 latency, attempted request rate, HTTP status distribution, and committed batches/events per second. **Only HTTP 202 counts as committed throughput**: the collector contract guarantees the batch transaction has committed before returning 202. 409, 429, 503, and transport errors remain visible but do not inflate successful throughput. Every benchmark request contains exactly one event.

The collector's default rate limiter (burst 30, refill 2 requests/second) materially affects results; the benchmark does not bypass it. Choose request counts and concurrency that intentionally exercise the configured limit, and report rate-limited results as such rather than calling attempted requests/sec capacity. Run the benchmark on a quiet host; record hardware/VM size, CPU/memory limits, OS/kernel, container digest, Rust build mode, DuckDB storage path, rate-limit configuration, request count, concurrency, warm-up, and trial duration. Capture CPU, memory, queue pressure, and database growth separately from host/container metrics. This script does not collect those host-level measurements.

Workstation runs are engineering baselines only. They do not establish production SLOs or target capacity. Agree expected-load and overload profiles, run repeated trials on the actual target host, and retain the raw JSON output before making a release decision.

## Fault injection proxy

For local development only:

\`\`\`sh
node scripts/fault-proxy.mjs --target=http://127.0.0.1:8080 --port=9080 --delayMs=150 --failEvery=5 --status=503
\`\`\`

The proxy can add fixed latency, return a chosen status every Nth request, or drop every Nth connection. Point a local test client at the proxy. It binds only to loopback and does not log request bodies or authorization values. Do not use it as a production proxy.

## Limits

Metrics are in-memory and reset when the collector restarts. They are process-local, not a durable audit log or distributed monitoring system. The dashboard is a thin read-only view; no historical time series or multi-tenant views are included.
