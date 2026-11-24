#!/usr/bin/env node
import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { open, readFile, mkdir, link, unlink, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Policy contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Policy contains non-JSON data");
}

function validatePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Policy must be a JSON object");
  const allowed = new Set(["schema_version", "policy_version", "issued_at", "expires_at", "origins", "max_attempts"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError("Input policy contains unknown fields");
  if (input.schema_version !== 1) throw new TypeError("schema_version must be 1");
  if (!Number.isSafeInteger(input.policy_version) || input.policy_version < 1) throw new TypeError("policy_version must be a positive safe integer");
  if (!Number.isSafeInteger(input.issued_at) || input.issued_at < 0 ||
      !Number.isSafeInteger(input.expires_at) || input.expires_at <= input.issued_at) {
    throw new TypeError("Policy validity interval is invalid");
  }
  if (!Array.isArray(input.origins) || input.origins.length < 1 || input.origins.length > 32) {
    throw new TypeError("origins must contain 1 to 32 HTTPS origins");
  }
  for (const value of input.origins) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
      throw new TypeError("Every origin must be a canonical HTTPS origin");
    }
  }
  if (new Set(input.origins).size !== input.origins.length) throw new TypeError("origins must be unique");
  if (input.max_attempts !== undefined &&
      (!Number.isInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > 8)) {
    throw new TypeError("max_attempts must be an integer from 1 to 8");
  }
  return input;
}

async function writeImmutable(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(path, "utf8");
      if (existing !== contents) throw new Error("An immutable policy version already exists with different content");
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function atomicReplace(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function publishPolicy({ inputPath, outputDirectory, privateKeyPem, keyId }) {
  if (!privateKeyPem || !keyId || keyId.length > 128) throw new TypeError("Signing key and key ID are required");
  const input = validatePolicy(JSON.parse(await readFile(inputPath, "utf8")));
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Signing key must be Ed25519");
  const signature = sign(null, Buffer.from(canonicalize(input)), key).toString("base64");
  const bundle = { ...input, signature: { algorithm: "Ed25519", key_id: keyId, value: signature } };
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const directory = join(outputDirectory, "v1");
  await mkdir(directory, { recursive: true });
  const lockPath = join(outputDirectory, ".publish.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const latestPath = join(outputDirectory, "latest.json");
    let previousVersion = 0;
    try {
      const latest = JSON.parse(await readFile(latestPath, "utf8"));
      previousVersion = latest.policy_version;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (input.policy_version <= previousVersion) {
      throw new Error(`Policy version ${input.policy_version} is not newer than published version ${previousVersion}`);
    }
    const versionedPath = join(directory, `${input.policy_version}.json`);
    await writeImmutable(versionedPath, serialized);
    await atomicReplace(latestPath, serialized);
    return { version: input.policy_version, versionedPath, latestPath };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function main() {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory) {
    throw new Error("Usage: node scripts/policy-publisher.mjs <unsigned-policy.json> <output-directory>");
  }
  const privateKeyPem = process.env.POLICY_SIGNING_PRIVATE_KEY;
  const keyId = process.env.POLICY_SIGNING_KEY_ID;
  const result = await publishPolicy({ inputPath, outputDirectory, privateKeyPem, keyId });
  process.stdout.write(`Published signed policy version ${result.version}\n${result.versionedPath}\n${result.latestPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Policy publish failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
