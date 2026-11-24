import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPolicy } from "./policy-publisher.mjs";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

test("publishes an Ed25519-signed immutable bundle and latest pointer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rd-policy-publisher-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const inputPath = join(directory, "policy.json");
    const outputDirectory = join(directory, "published");
    const policy = {
      schema_version: 1,
      policy_version: 4,
      issued_at: 1000,
      expires_at: 2000,
      origins: ["https://api.example.com"],
      max_attempts: 1,
    };
    await writeFile(inputPath, JSON.stringify(policy));
    const result = await publishPolicy({ inputPath, outputDirectory, privateKeyPem, keyId: "test-key" });
    const bundle = JSON.parse(await readFile(result.versionedPath, "utf8"));
    const signature = Buffer.from(bundle.signature.value, "base64");
    const payload = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "signature"));
    assert.equal(bundle.signature.algorithm, "Ed25519");
    assert.equal(bundle.signature.key_id, "test-key");
    assert.equal(verify(null, Buffer.from(canonicalize(payload)), publicKey, signature), true);
    assert.deepEqual(JSON.parse(await readFile(result.latestPath, "utf8")), bundle);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a policy downgrade without changing the latest pointer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rd-policy-downgrade-"));
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const inputPath = join(directory, "policy.json");
    const outputDirectory = join(directory, "published");
    const policy = { schema_version: 1, policy_version: 3, issued_at: 1000, expires_at: 2000, origins: ["https://api.example.com"] };
    await writeFile(inputPath, JSON.stringify(policy));
    await publishPolicy({ inputPath, outputDirectory, privateKeyPem, keyId: "test-key" });
    const latestBefore = await readFile(join(outputDirectory, "latest.json"), "utf8");
    await writeFile(inputPath, JSON.stringify({ ...policy, policy_version: 2 }));
    await assert.rejects(
      publishPolicy({ inputPath, outputDirectory, privateKeyPem, keyId: "test-key" }),
      /not newer/,
    );
    assert.equal(await readFile(join(outputDirectory, "latest.json"), "utf8"), latestBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
