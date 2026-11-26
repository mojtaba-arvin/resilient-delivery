#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { summarizeTrials } from "./benchmark-summary.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const endpoint = args.url ?? "http://127.0.0.1:8080/v1/telemetry/batches";
const token = process.env.COLLECTOR_BEARER_TOKEN;
const total = Number(args.requests ?? 30);
const concurrency = Number(args.concurrency ?? 4);
const trialCount = Number(args.trials ?? 3);
const warmupRequests = Number(args.warmup ?? 0);
const pauseMs = Number(args["pause-ms"] ?? 15000);
if (!token || token.length < 32) throw new Error("Set COLLECTOR_BEARER_TOKEN to a 32+ character collector token");
if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new RangeError("--requests must be 1..10000 per trial");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError("--concurrency must be 1..100");
if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 20) throw new RangeError("--trials must be 1..20");
if (!Number.isSafeInteger(warmupRequests) || warmupRequests < 0 || warmupRequests > 10000) throw new RangeError("--warmup must be 0..10000");
if (!Number.isSafeInteger(pauseMs) || pauseMs < 0 || pauseMs > 300000) throw new RangeError("--pause-ms must be 0..300000");

async function runTrial(trialNumber, requestCount = total) {
  const latencies = [];
  const statuses = {};
  let next = 0;
  const runId = randomUUID();
  const started = performance.now();

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= requestCount) return;
      const before = performance.now();
      let status = "network_error";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + token,
            "idempotency-key": "bench-" + runId + "-" + index,
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
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()));
  return {
    trial: trialNumber,
    requests: requestCount,
    concurrency,
    elapsed_ms: performance.now() - started,
    latencies_ms: latencies,
    statuses,
  };
}

const warmupResult = warmupRequests > 0 ? await runTrial(0, warmupRequests) : null;
const trials = [];
for (let index = 1; index <= trialCount; index++) {
  trials.push(await runTrial(index));
  if (index < trialCount && pauseMs > 0) await delay(pauseMs);
}
const result = summarizeTrials(trials);
result.warmup = warmupResult ? { requests: warmupResult.requests, elapsed_ms: Number(warmupResult.elapsed_ms.toFixed(2)), statuses: warmupResult.statuses } : { requests: 0, elapsed_ms: 0, statuses: {} };
result.pause_ms = pauseMs;
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
