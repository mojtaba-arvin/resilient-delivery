import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, restoreDatabase } from "./backup-restore.mjs";

test("backup and restore verify a SHA-256 manifest and replace atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resilient-backup-"));
  try {
    const source = join(dir, "collector.duckdb");
    const backup = join(dir, "backups", "collector.duckdb");
    const target = join(dir, "restore", "collector.duckdb");
    await writeFile(source, "durable database bytes");
    await mkdir(join(dir, "restore"), { recursive: true });
    await writeFile(target, "old database bytes");
    const result = await backupDatabase(source, backup);
    assert.equal((await readFile(backup, "utf8")), "durable database bytes");
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await restoreDatabase(backup, target);
    assert.equal(await readFile(target, "utf8"), "durable database bytes");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("tampered backup is rejected without changing the destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resilient-backup-tamper-"));
  try {
    const source = join(dir, "source.db");
    const backup = join(dir, "backup.db");
    const target = join(dir, "target.db");
    await writeFile(source, "valid");
    await writeFile(target, "keep-this");
    await backupDatabase(source, backup);
    await writeFile(backup, "tampered");
    await assert.rejects(restoreDatabase(backup, target), /SHA-256/);
    assert.equal(await readFile(target, "utf8"), "keep-this");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backup refuses to overwrite its source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resilient-backup-same-"));
  try {
    const source = join(dir, "source.db");
    await writeFile(source, "bytes");
    await assert.rejects(backupDatabase(source, source), /differ/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
