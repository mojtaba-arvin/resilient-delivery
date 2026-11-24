import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResilientClient } from "../sdk-web/dist/index.js";
import { createResilientClient } from "../sdk-node/index.mjs";

const token = process.env.COLLECTOR_BEARER_TOKEN;
if (typeof token !== "string" || token.length < 32) {
  throw new Error("COLLECTOR_BEARER_TOKEN must contain at least 32 characters");
}

const collectorEndpoint = new URL(
  process.env.COLLECTOR_URL ?? "http://127.0.0.1:8080/v1/telemetry/batches",
);
const collectorOrigin = collectorEndpoint.origin;
const proxyOrigin = new URL(process.env.TOXIPROXY_URL ?? "http://127.0.0.1:18082").origin;
const adminOrigin = new URL(process.env.TOXIPROXY_ADMIN_URL ?? "http://127.0.0.1:8475");
const upstream = process.env.TOXIPROXY_UPSTREAM ?? "collector:8080";
const proxyName = "sdk-collector-e2e";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function adminRequest(path, init = {}) {
  const response = await fetch(new URL(path, adminOrigin), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("Toxiproxy API " + path + " returned " + response.status + ": " + body);
  }
  return body ? JSON.parse(body) : null;
}

async function waitForAdmin() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(new URL("/proxies", adminOrigin));
      if (response.ok) return;
    } catch {
      // The container may still be starting.
    }
    await delay(250);
  }
  throw new Error("Toxiproxy admin API did not become ready");
}

async function collectorMetrics() {
  const response = await fetch(new URL("/metrics", collectorOrigin), {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function removeFault() {
  await adminRequest("/proxies/" + proxyName + "/toxics/slow-downstream", {
    method: "DELETE",
  }).catch(() => {});
}

async function removeProxy() {
  await removeFault();
  await adminRequest("/proxies/" + proxyName, { method: "DELETE" }).catch(() => {});
}

await waitForAdmin();
await adminRequest("/proxies", {
  method: "POST",
  body: JSON.stringify({
    name: proxyName,
    listen: "0.0.0.0:18082",
    upstream,
    enabled: true,
  }),
});
try {
  await adminRequest("/proxies/" + proxyName + "/toxics", {
    method: "POST",
    body: JSON.stringify({
      name: "slow-downstream",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: 2000, jitter: 0 },
    }),
  });

  const before = await collectorMetrics();
  const payload = JSON.stringify({
    schemaVersion: 1,
    events: [{ schemaVersion: 1, routeIndex: 3, outcome: "success", durationMs: 19, status: 200 }],
  });

  const webObservations = [];
  const webClient = new ResilientClient({
    primaryOrigin: proxyOrigin,
    fallbackOrigins: [collectorOrigin],
    maxAttempts: 2,
    timeoutMs: 500,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    random: () => 0.5,
    sleep: async () => {},
    telemetryConsent: true,
    onObservation: observation => webObservations.push(observation),
  });
  const webResponse = await webClient.fetch(new URL(collectorEndpoint.pathname, proxyOrigin), {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "idempotency-key": "web-sdk-" + randomUUID(),
    },
    body: payload,
  });
  assert.equal(webResponse.status, 202);
  assert.deepEqual(webObservations.map(event => event.outcome), ["network_error", "success"]);
  assert.deepEqual(webObservations.map(event => event.routeIndex), [0, 1]);
  assert.ok(webObservations.every(event =>
    Number.isInteger(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 600_000
  ));

  const nodeClient = createResilientClient({
    primaryOrigin: proxyOrigin,
    fallbackOrigins: [collectorOrigin],
    maxAttempts: 2,
    timeoutMs: 500,
  });
  const nodeResponse = await nodeClient(collectorEndpoint.pathname, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "idempotency-key": "node-sdk-" + randomUUID(),
    },
    body: payload,
  });
  assert.equal(nodeResponse.status, 202);

  await removeFault();
  const observationResponse = await fetch(collectorEndpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "idempotency-key": "web-sdk-observations-" + randomUUID(),
    },
    body: JSON.stringify({ schemaVersion: 1, events: webObservations }),
  });
  assert.equal(observationResponse.status, 202);

  const after = await collectorMetrics();
  const delta = {
    committed: after.batches_committed_total - before.batches_committed_total,
    deduplicated: after.batches_deduplicated_total - before.batches_deduplicated_total,
    events: after.events_committed_total - before.events_committed_total,
  };
  assert.deepEqual(delta, { committed: 3, deduplicated: 2, events: 4 });

  process.stdout.write(JSON.stringify({
    scenario: "web-and-node-sdk-through-toxiproxy-to-real-collector",
    webSdk: { status: webResponse.status, observations: webObservations },
    nodeSdk: { status: nodeResponse.status },
    collectorDelta: delta,
  }, null, 2) + "\n");
} finally {
  await removeProxy();
}
