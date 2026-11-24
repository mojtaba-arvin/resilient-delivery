#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const endpoint = args.url ?? "http://127.0.0.1:8080/v1/telemetry/batches";
const token = process.env.COLLECTOR_BEARER_TOKEN;
const total = Number(args.requests ?? 30);
const concurrency = Number(args.concurrency ?? 4);
if (!token || token.length < 32) throw new Error("Set COLLECTOR_BEARER_TOKEN to a 32+ character collector token");
if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new RangeError("--requests must be 1..10000");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError("--concurrency must be 1..100");

const latencies = [];
const statuses = new Map();
let next = 0;
const runId = randomUUID();
const started = performance.now();
async function worker() {
  while (true) {
    const index = next++;
    if (index >= total) return;
    const before = performance.now();
    let status = "network_error";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": `bench-${runId}-${index}`,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          events: [{ schemaVersion: 1, routeIndex: 0, outcome: "success", durationMs: 1, status: 200 }],
        }),
      });
      status = String(response.status);
      await response.arrayBuffer();
    } catch { /* Count transport errors without logging request data. */ }
    latencies.push(performance.now() - before);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const percentile = p => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] ?? 0;
process.stdout.write(JSON.stringify({
  requests: total,
  concurrency,
  elapsed_ms: Number(elapsed.toFixed(2)),
  requests_per_second: Number((total / (elapsed / 1000)).toFixed(2)),
  latency_ms: { p50: Number(percentile(.50).toFixed(2)), p95: Number(percentile(.95).toFixed(2)), p99: Number(percentile(.99).toFixed(2)) },
  statuses: Object.fromEntries(statuses),
  note: "Results include collector rate limiting (default burst 30, refill 2 requests/second)."
}, null, 2) + "\n");
