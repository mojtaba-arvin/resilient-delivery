import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const checks = [
  ["Docker image declares a non-root runtime user", /USER\s+(?!root\b)[^\s]+/.test(read("../Dockerfile"))],
  ["Collector host port is loopback-only", /127\.0\.0\.1:\$\{COLLECTOR_HOST_PORT:-8080\}:8080/.test(read("../compose.yaml"))],
  ["Collector container is read-only", /read_only:\s*true/.test(read("../compose.yaml"))],
  ["Container drops all Linux capabilities", /cap_drop:\s*\n\s*-\s*ALL/.test(read("../compose.yaml"))],
  ["Container prevents privilege escalation", /no-new-privileges:true/.test(read("../compose.yaml"))],
  ["Environment files are ignored", /^\.env\*$/m.test(read("../.gitignore")) || /^\.env$/m.test(read("../.gitignore"))],
  ["OTLP adapter does not log payloads or bearer credentials", !/console\.(log|info|debug)\([^\n]*(?:request|body|token|authorization)/i.test(read("../integration/otlp-json-adapter.mjs"))],
  ["Collector stores token digests, not raw configured tokens", /Sha256::digest\(token\.as_bytes\(\)\)/.test(read("../collector/src/lib.rs"))],
  ["Production runtime fails closed on shared-storage multi-tenant tokens", /tokens\.len\(\)\s*!=\s*1/.test(read("../collector/src/main.rs"))],
  ["OTLP receiver ports are loopback-only", /127\.0\.0\.1:4317:4317/.test(read("../compose.yaml")) && /127\.0\.0\.1:4318:4318/.test(read("../compose.yaml"))],
];
let failed = 0;
for (const [label, ok] of checks) {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}\n`);
  if (!ok) failed += 1;
}
if (failed) process.exitCode = 1;
