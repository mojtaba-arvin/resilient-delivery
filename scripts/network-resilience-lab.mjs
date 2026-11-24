#!/usr/bin/env node
/**
 * Toxiproxy control utility for deterministic local network-fault experiments.
 * Usage: node scripts/network-resilience-lab.mjs <latency|partition|reset|clear|report>
 */
const admin = new URL(process.env.TOXIPROXY_ADMIN_URL ?? "http://127.0.0.1:8474");
const proxyName = process.env.TOXIPROXY_NAME ?? "resilient-delivery";
const listen = process.env.TOXIPROXY_LISTEN ?? "0.0.0.0:18080";
const upstream = process.env.TOXIPROXY_UPSTREAM ?? "host.docker.internal:8080";

export function toxicFor(mode) {
  switch (mode) {
    case "latency":
      return { name: "delivery-latency", type: "latency", stream: "downstream", toxicity: 1, attributes: { latency: 750, jitter: 150 } };
    case "partition":
      return { name: "delivery-partition", type: "timeout", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } };
    case "reset":
      return { name: "delivery-reset", type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } };
    default:
      throw new Error(`Unsupported fault mode: ${mode}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, admin), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Toxiproxy API ${path} failed: HTTP ${response.status}`);
  }
  return response.status === 204 || response.status === 404 ? null : response.json();
}

async function ensureProxy() {
  const proxies = await api("/proxies");
  if (proxies?.[proxyName]) return;
  await api("/proxies", { method: "POST", body: JSON.stringify({ name: proxyName, listen, upstream, enabled: true }) });
}

async function main(mode) {
  if (mode === "report") {
    const proxies = await api("/proxies");
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), proxy: proxies?.[proxyName] ?? null }, null, 2) + "\n");
    return;
  }
  await ensureProxy();
  if (mode === "clear") {
    for (const toxic of (await api(`/proxies/${proxyName}/toxics`)) ?? []) {
      await api(`/proxies/${proxyName}/toxics/${toxic.name}`, { method: "DELETE" });
    }
    process.stdout.write("Network faults cleared.\n");
    return;
  }
  const toxic = toxicFor(mode);
  await api(`/proxies/${proxyName}/toxics`, { method: "POST", body: JSON.stringify(toxic) });
  process.stdout.write(`Applied ${mode} fault to ${proxyName}.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (!mode) {
    process.stderr.write("Usage: node scripts/network-resilience-lab.mjs <latency|partition|reset|clear|report>\n");
    process.exitCode = 2;
  } else {
    main(mode).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
