import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("security regression check is present and executable", () => {
  const source = readFileSync(new URL("./security-check.mjs", import.meta.url), "utf8");
  assert.match(source, /Collector host port is loopback-only/);
  assert.match(source, /Collector stores token digests/);
  assert.match(source, /fails closed on shared-storage multi-tenant tokens/);
  assert.match(source, /OTLP receiver ports are loopback-only/);
  assert.match(source, /process\.exitCode = 1/);
});

test("Compose host-port override remains explicitly bound to loopback", () => {
  const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.ok(compose.includes(\'"127.0.0.1:${COLLECTOR_HOST_PORT:-8080}:8080"\'));
  assert.doesNotMatch(compose, /0\\.0\\.0\\.0:\\$\\{COLLECTOR_HOST_PORT/);
});
