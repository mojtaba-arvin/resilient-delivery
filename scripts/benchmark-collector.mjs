#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
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
if (!token || token.length < 32) throw new Error("Set COLLECTOR_BEARER_TOKEN to a 32+ character collector token");
if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new RangeError("--requests must be 1..10000 per trial");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError("--concurrency must be 1..100");
if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 20) throw new RangeError("--trials must be 1..20");

async function runTrial(trialNumber) {
  const latencies = [];
  const statuses = {};
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

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return {
    trial: trialNumber,
    requests: total,
    concurrency,
    elapsed_ms: performance.now() - started,
    latencies_ms: latencies,
    statuses,
  };
}

const trials = [];
for (let index = 1; index <= trialCount; index++) {
  trials.push(await runTrial(index));
}
process.stdout.write(JSON.stringify(summarizeTrials(trials), null, 2) + "\n");
