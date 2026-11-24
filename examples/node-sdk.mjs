import { createResilientClient } from "../sdk-node/index.mjs";

const primaryOrigin = process.env.RESILIENT_PRIMARY_ORIGIN;
const fallbackOrigins = (process.env.RESILIENT_FALLBACK_ORIGINS ?? "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

if (!primaryOrigin) throw new Error("Set RESILIENT_PRIMARY_ORIGIN to an application-owned HTTPS origin");

const client = createResilientClient({
  primaryOrigin,
  fallbackOrigins,
  timeoutMs: 3000,
  maxAttempts: 2,
});

const response = await client("/healthz", { method: "GET" });
process.stdout.write(`collector health status: ${response.status}\n`);
if (!response.ok) process.exitCode = 1;
