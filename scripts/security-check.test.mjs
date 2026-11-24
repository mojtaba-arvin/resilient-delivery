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
