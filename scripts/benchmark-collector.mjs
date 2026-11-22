#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const endpoint = args.url ?? "http://127.0.0.1:8080/v1/telemetry/batches";
const token = process.env.COLLECTOR_BEARER_TOKEN;
const total = Number(args.requests ?? 1000);
const concurrency = Number(args.concurrency ?? 16);
const warmup = Number(args.warmup ?? 100);
if (!token || token.length < 32) throw new Error("Set COLLECTOR_BEARER_TOKEN to a 32+ character collector token");
if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new RangeError("--requests must be 1..10000");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError("--concurrency must be 1..100");
if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 10000) throw new RangeError("--warmup must be 0..10000");

const runId = randomUUID();
const startedAt = new Date().toISOString();
async function send(index, phase) {
  const before = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": `bench-${runId}-${phase}-${index}`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        events: [{ schemaVersion: 1, routeIndex: 0, outcome: "success", durationMs: 1, status: 200 }],
      }),
    });
    await response.arrayBuffer();
    return { status: String(response.status), latencyMs: performance.now() - before };
  } catch {
    return { status: "network_error", latencyMs: performance.now() - before };
  }
}
async function runPhase(count, phase, measure) {
  let next = 0;
  const latencies = [];
  const statuses = new Map();
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= count) return;
      const result = await send(index, phase);
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
      if (measure) latencies.push(result.latencyMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, count)) }, () => worker()));
  return { latencies, statuses };
}

const warmupResult = await runPhase(warmup, "warmup", false);
if ([...warmupResult.statuses.keys()].some(status => status !== "202")) {
  throw new Error(`Warm-up failed: ${JSON.stringify(Object.fromEntries(warmupResult.statuses))}`);
}
const started = performance.now();
const result = await runPhase(total, "measure", true);
const elapsed = performance.now() - started;
const completedAt = new Date().toISOString();
result.latencies.sort((a, b) => a - b);
const percentile = p => result.latencies[Math.min(result.latencies.length - 1, Math.ceil(p * result.latencies.length) - 1)] ?? 0;
const successCount = result.statuses.get("202") ?? 0;
const report = {
  run_id: runId,
  started_at: startedAt,
  completed_at: completedAt,
  endpoint: new URL(endpoint).origin + new URL(endpoint).pathname,
  requests: total,
  warmup_requests: warmup,
  concurrency,
  elapsed_ms: Number(elapsed.toFixed(2)),
  requests_per_second: Number((total / (elapsed / 1000)).toFixed(2)),
  latency_ms: {
    p50: Number(percentile(.50).toFixed(2)),
    p95: Number(percentile(.95).toFixed(2)),
    p99: Number(percentile(.99).toFixed(2)),
  },
  successful_requests: successCount,
  statuses: Object.fromEntries(result.statuses),
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (successCount !== total) process.exitCode = 1;
