import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const project = `resilient-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
const hostPort = Number(process.env.COLLECTOR_HOST_PORT ?? 18080);
const token = process.env.COLLECTOR_BEARER_TOKEN ?? "local-compose-smoke-token-not-a-secret-0123456789";
if (token.length < 32) throw new Error("COLLECTOR_BEARER_TOKEN must contain at least 32 characters");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) {
  throw new Error("COLLECTOR_HOST_PORT must be an available TCP port between 1024 and 65535");
}

const env = {
  ...process.env,
  COLLECTOR_BEARER_TOKEN: token,
  COLLECTOR_HOST_PORT: String(hostPort),
  COLLECTOR_DOMAIN: process.env.COLLECTOR_DOMAIN ?? "localhost",
};

async function compose(...args) {
  return execFileAsync("docker", ["compose", "--project-name", project, "--file", "compose.yaml", ...args], {
    cwd: root,
    env,
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function request(path, { method = "GET", body, authenticated = true, idempotencyKey } = {}) {
  const headers = {};
  if (authenticated) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return fetch(`http://127.0.0.1:${hostPort}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

async function waitHealthy() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request("/healthz", { authenticated: false });
      if (response.status === 204) return;
      lastError = new Error(`health endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(`collector did not become healthy within 60 seconds: ${lastError?.message ?? "unknown error"}`);
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  }
}

const key = `compose-smoke-${randomUUID()}`;
const batch = {
  schemaVersion: 1,
  events: [{ schemaVersion: 1, routeIndex: 1, outcome: "success", durationMs: 17, status: 200 }],
};
const conflictingBatch = {
  schemaVersion: 1,
  events: [{ schemaVersion: 1, routeIndex: 1, outcome: "success", durationMs: 18, status: 200 }],
};

let started = false;
try {
  const upArgs = ["up", "-d"];
  if (process.env.COMPOSE_SMOKE_NO_BUILD === "1") upArgs.push("--no-build");
  else upArgs.push("--build");
  upArgs.push("collector");
  await compose(...upArgs);
  started = true;
  await waitHealthy();

  const published = (await compose("port", "collector", "8080")).stdout.trim();
  if (!published.startsWith("127.0.0.1:")) {
    throw new Error(`collector port must be loopback-only; Compose published ${published}`);
  }

  assertStatus(await request("/v1/telemetry/batches", { method: "POST", body: batch, authenticated: false }), 401, "unauthenticated ingestion");
  assertStatus(await request("/metrics", { authenticated: false }), 401, "unauthenticated metrics");

  assertStatus(await request("/v1/telemetry/batches", { method: "POST", body: batch, idempotencyKey: key }), 202, "first committed batch");
  assertStatus(await request("/v1/telemetry/batches", { method: "POST", body: batch, idempotencyKey: key }), 202, "idempotent replay");
  assertStatus(await request("/v1/telemetry/batches", { method: "POST", body: conflictingBatch, idempotencyKey: key }), 409, "conflicting idempotency payload");

  const metricsResponse = await request("/metrics");
  assertStatus(metricsResponse, 200, "authenticated metrics");
  const metrics = await metricsResponse.json();
  if (metrics.batches_committed_total !== 1 || metrics.batches_deduplicated_total !== 1 || metrics.idempotency_conflicts_total !== 1) {
    throw new Error(`unexpected collector metrics before restart: ${JSON.stringify(metrics)}`);
  }

  await compose("restart", "collector");
  await waitHealthy();
  assertStatus(await request("/v1/telemetry/batches", { method: "POST", body: conflictingBatch, idempotencyKey: key }), 409, "persisted idempotency receipt after restart");

  process.stdout.write(JSON.stringify({
    result: "passed",
    project,
    hostBinding: published,
    checks: ["health", "loopback-only port", "ingestion authentication", "metrics authentication", "commit acknowledgement", "idempotent replay", "conflict rejection", "receipt persistence after restart"],
  }, null, 2) + "\n");
} finally {
  if (started) {
    await compose("down", "--volumes", "--remove-orphans");
  } else {
    await compose("down", "--volumes", "--remove-orphans").catch(() => {});
  }
}
