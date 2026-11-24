import { test } from "node:test";
import assert from "node:assert/strict";
import { createResilientClient } from "./index.mjs";

test("fails over across only explicitly configured origins", async () => {
  const seen = [];
  const client = createResilientClient({
    primaryOrigin: "https://api.example.test",
    fallbackOrigins: ["https://backup.example.test"],
    fetch: async url => {
      seen.push(new URL(url).origin);
      return new Response("ok", { status: seen.length === 1 ? 503 : 200 });
    },
    timeoutMs: 500,
  });
  const response = await client("/v1/items");
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["https://api.example.test", "https://backup.example.test"]);
});

test("does not retry unsafe requests without an idempotency key", async () => {
  const client = createResilientClient({
    primaryOrigin: "https://api.example.test",
    fallbackOrigins: ["https://backup.example.test"],
    fetch: async () => new Response(null, { status: 503 }),
  });
  await assert.rejects(client("/v1/orders", { method: "POST", body: "{}" }), /Idempotency-Key/);
});

test("rejects a path that attempts to escape the configured origin", async () => {
  const client = createResilientClient({ primaryOrigin: "https://api.example.test", fetch: async () => new Response() });
  await assert.rejects(client("https://attacker.example/collect"), /escaped configured origin/);
});

test("returns a terminal application response without failover", async () => {
  let calls = 0;
  const client = createResilientClient({
    primaryOrigin: "https://api.example.test",
    fallbackOrigins: ["https://backup.example.test"],
    fetch: async () => { calls += 1; return new Response(null, { status: 400 }); },
  });
  assert.equal((await client("/v1/items")).status, 400);
  assert.equal(calls, 1);
});

test("refuses retries for streaming request bodies", async () => {
  const client = createResilientClient({
    primaryOrigin: "https://api.example.test",
    fallbackOrigins: ["https://backup.example.test"],
    fetch: async () => new Response(null, { status: 503 }),
  });
  const body = new ReadableStream({ start() {} });
  await assert.rejects(
    client("/v1/upload", { method: "POST", headers: { "Idempotency-Key": "upload-1" }, body }),
    /streaming request bodies/,
  );
});
