import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const admin = process.env.TOXIPROXY_ADMIN_URL ?? "http://127.0.0.1:8474";
const proxyUrl = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:18081";
const proxyName = "resilient-delivery-e2e";
let accepted = 0;
const server = createServer((_request, response) => {
  accepted += 1;
  response.writeHead(202, { "content-type": "application/json" });
  response.end(JSON.stringify({ accepted }));
});
await new Promise(resolve => server.listen(8080, "0.0.0.0", resolve));

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
async function expectUnavailable(label) {
  let delivered = false;
  try {
    const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(900) });
    delivered = response.status === 202;
  } catch { /* A reset/partition is an expected transport failure. */ }
  assert.equal(delivered, false, `${label} unexpectedly delivered a response`);
}
const report = { startedAt: new Date().toISOString(), scenarios: [], acceptedBefore: 0, acceptedAfter: 0 };
try {
  await api("/proxies", {
    method: "POST",
    body: JSON.stringify({
      name: proxyName,
      listen: "0.0.0.0:18081",
      upstream: "host.docker.internal:8080",
      enabled: true,
    }),
  });
  const start = performance.now();
  await apply({ name: "latency", type: "latency", stream: "downstream", toxicity: 1, attributes: { latency: 150, jitter: 25 } });
  const delayed = await fetch(proxyUrl);
  assert.equal(delayed.status, 202);
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs >= 100, `latency toxic was not applied: ${elapsedMs}ms`);
  report.scenarios.push({ name: "latency", elapsedMs: Math.round(elapsedMs), passed: true });
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
  // A short-lived sidecar has NET_ADMIN only for this isolated test namespace.
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

  report.acceptedBefore = accepted;
  const recoveryStart = performance.now();
  const recovered = await fetch(proxyUrl);
  assert.equal(recovered.status, 202);
  report.recoveryMs = Math.round(performance.now() - recoveryStart);
  report.acceptedAfter = accepted;
  report.scenarios.push({ name: "recovery", passed: true });
  report.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await clear().catch(() => {});
  await api(`/proxies/${proxyName}`, { method: "DELETE" }).catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
