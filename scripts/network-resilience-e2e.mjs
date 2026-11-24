import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const admin = process.env.TOXIPROXY_ADMIN_URL ?? "http://127.0.0.1:8474";
const proxyUrl = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:18081";
const collectorUrl = new URL(process.env.COLLECTOR_URL ?? "http://127.0.0.1:8080/v1/telemetry/batches");
const token = process.env.COLLECTOR_BEARER_TOKEN;
if (!token || token.length < 32) throw new Error("COLLECTOR_BEARER_TOKEN must contain at least 32 characters");
const proxyName = "resilient-delivery-e2e";
const idempotencyKey = `fault-e2e-${randomUUID()}`;
const body = JSON.stringify({
  schemaVersion: 1,
  events: [{ schemaVersion: 1, routeIndex: 3, outcome: "success", durationMs: 37, status: 200 }],
});
const proxiedEndpoint = new URL(collectorUrl.pathname, proxyUrl);

async function api(path, options = {}) {
  const response = await fetch(new URL(path, admin), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  if (!response.ok && response.status !== 404) throw new Error(`Toxiproxy API ${path}: HTTP ${response.status}`);
  return response.status === 204 || response.status === 404 ? null : response.json();
}
async function clear() {
  const toxics = await api(`/proxies/${proxyName}/toxics`);
  for (const toxic of toxics ?? []) await api(`/proxies/${proxyName}/toxics/${toxic.name}`, { method: "DELETE" });
}
async function apply(toxic) {
  await api(`/proxies/${proxyName}/toxics`, { method: "POST", body: JSON.stringify(toxic) });
}
async function sendThroughProxy(timeoutMs = 3000) {
  return fetch(proxiedEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
async function expectUnavailable(label) {
  let delivered = false;
  try {
    const response = await sendThroughProxy(900);
    delivered = response.status === 202;
  } catch { /* A reset/partition is an expected transport failure. */ }
  assert.equal(delivered, false, `${label} unexpectedly delivered a response`);
}
const report = { startedAt: new Date().toISOString(), collector: collectorUrl.origin, scenarios: [] };
try {
  await api("/proxies", {
    method: "POST",
    body: JSON.stringify({
      name: proxyName,
      listen: "0.0.0.0:18081",
      upstream: process.env.TOXIPROXY_UPSTREAM ?? "host.docker.internal:8080",
      enabled: true,
    }),
  });

  await apply({
    name: "latency",
    type: "latency",
    stream: "downstream",
    toxicity: 1,
    attributes: { latency: 200, jitter: 0 },
  });
  const latencyStart = performance.now();
  const delayed = await sendThroughProxy();
  assert.equal(delayed.status, 202, "collector did not accept the latency scenario batch");
  const latencyMs = performance.now() - latencyStart;
  assert.ok(latencyMs >= 100, `latency toxic was not applied: ${latencyMs}ms`);
  report.scenarios.push({ name: "latency", elapsedMs: Math.round(latencyMs), passed: true });
  await clear();

  await apply({ name: "partition", type: "timeout", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } });
  await expectUnavailable("network partition");
  report.scenarios.push({ name: "partition", passed: true });
  await clear();

  await apply({ name: "peer-reset", type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } });
  await expectUnavailable("peer reset");
  report.scenarios.push({ name: "peer-reset", passed: true });
  await clear();

  // Apply real kernel-level packet loss to the Toxiproxy network namespace.
  const packetLoss = spawn("docker", [
    "run", "--rm", "--network", "container:resilient-toxiproxy",
    "--cap-add=NET_ADMIN", "alpine:3.20", "sh", "-ec",
    "apk add --no-cache iproute2 >/dev/null; tc qdisc add dev eth0 root netem loss 100%; echo FAULT_ACTIVE; sleep 2; tc qdisc del dev eth0 root",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let packetLossOutput = "";
  let faultActive = false;
  const packetLossExitPromise = new Promise(resolve => packetLoss.once("exit", resolve));
  await new Promise((resolve, reject) => {
    packetLoss.stdout.on("data", chunk => {
      packetLossOutput += chunk.toString();
      if (!faultActive && packetLossOutput.includes("FAULT_ACTIVE")) {
        faultActive = true;
        resolve();
      }
    });
    packetLoss.once("error", reject);
    packetLoss.once("exit", code => {
      if (!faultActive) reject(new Error(`packet-loss sidecar exited before applying netem (code ${code}): ${packetLossOutput}`));
    });
  });
  await expectUnavailable("100% kernel packet loss");
  const packetLossExit = await packetLossExitPromise;
  assert.equal(packetLossExit, 0, `packet-loss sidecar failed: ${packetLossOutput}`);
  report.scenarios.push({ name: "packet-loss", lossPercent: 100, passed: true });

  const recoveryStart = performance.now();
  const recovered = await sendThroughProxy();
  assert.equal(recovered.status, 202, "collector did not recover after network faults");
  report.recoveryMs = Math.round(performance.now() - recoveryStart);

  // The same request key must be safely replayable after an ambiguous network
  // outcome. Verify the real collector's durable-path idempotency counters.
  const metricsResponse = await fetch(new URL("/metrics", collectorUrl.origin), {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(metricsResponse.status, 200, "collector metrics endpoint was not available");
  const metrics = await metricsResponse.json();
  assert.equal(metrics.batches_committed_total, 1, "replayed batch was inserted more than once");
  assert.ok(metrics.batches_deduplicated_total >= 1, "collector did not record an idempotent replay");
  report.collectorMetrics = {
    batchesCommitted: metrics.batches_committed_total,
    batchesDeduplicated: metrics.batches_deduplicated_total,
  };
  report.scenarios.push({ name: "collector-idempotent-recovery", passed: true });
  report.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await clear().catch(() => {});
  await api(`/proxies/${proxyName}`, { method: "DELETE" }).catch(() => {});
}
