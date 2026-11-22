import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("release manifest validates component version parity", () => {
  const result = spawnSync(process.execPath, ["scripts/release-manifest.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.components.collector, manifest.components.webSdk);
  assert.ok(manifest.releaseChecks.includes("backup-restore"));
});

test("release manifest rejects a mismatched release tag", () => {
  const result = spawnSync(process.execPath, ["scripts/release-manifest.mjs"], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_TAG: "v9.9.9" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match version/);
});
