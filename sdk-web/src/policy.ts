export interface PolicyVersionStore {
  /** Atomically advance the highest accepted policy version; return false for stale/equal versions. */
  advanceIfNewer(version: number): Promise<boolean>;
}
export interface PolicyBundle {
  schema_version: 1;
  policy_version: number;
  issued_at: number;
  expires_at: number;
  origins: string[];
  max_attempts?: number;
  signature: { algorithm: "Ed25519"; key_id: string; value: string };
}
export interface VerifiedPolicy {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly origins: readonly string[];
  readonly maxAttempts: number;
}
export interface VerifyPolicyOptions {
  publicKeys: Readonly<Record<string, string>>;
  allowedOrigins: readonly string[];
  versionStore: PolicyVersionStore;
  now?: () => number;
  maxClockSkewSeconds?: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Policy contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Policy contains a value that is not JSON data");
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function decodeBase64(value: string, expectedBytes: number, field: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`Malformed base64 in policy ${field}`);
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new TypeError(`Malformed base64 in policy ${field}`); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.byteLength !== expectedBytes) throw new TypeError(`Invalid byte length in policy ${field}`);
  return bytes;
}
function httpsOrigin(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Policy ${field} must contain strings`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new TypeError(`Policy ${field} must contain HTTPS origins only`);
  }
  return url.origin;
}
function validateBundle(value: unknown): PolicyBundle {
  if (!isRecord(value)) throw new TypeError("Policy bundle must be an object");
  const allowed = new Set(["schema_version", "policy_version", "issued_at", "expires_at", "origins", "max_attempts", "signature"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError("Policy bundle contains unknown fields");
  if (value.schema_version !== 1) throw new TypeError("Unsupported policy schema version");
  for (const key of ["policy_version", "issued_at", "expires_at"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < (key === "policy_version" ? 1 : 0)) {
      throw new TypeError(`Invalid policy ${key}`);
    }
  }
  if (!Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 32) {
    throw new TypeError("Policy origins must contain 1 to 32 entries");
  }
  const origins = value.origins.map(origin => httpsOrigin(origin, "origins"));
  if (new Set(origins).size !== origins.length) throw new TypeError("Policy origins must be unique");
  if (value.max_attempts !== undefined && (!Number.isInteger(value.max_attempts) || (value.max_attempts as number) < 1 || (value.max_attempts as number) > 8)) {
    throw new TypeError("Invalid policy max_attempts");
  }
  if (!isRecord(value.signature) || Object.keys(value.signature).length !== 3 ||
      value.signature.algorithm !== "Ed25519" ||
      typeof value.signature.key_id !== "string" || value.signature.key_id.length < 1 || value.signature.key_id.length > 128 ||
      typeof value.signature.value !== "string") {
    throw new TypeError("Invalid Ed25519 policy signature envelope");
  }
  return value as unknown as PolicyBundle;
}
/**
 * Verify an owner-signed policy. Signature verification, expiry checks, allowlist
 * narrowing, and monotonic version advancement all fail closed.
 * The signature covers canonical JSON of the bundle with its signature property omitted.
 */
export async function verifyPolicyBundle(input: unknown, options: VerifyPolicyOptions): Promise<VerifiedPolicy> {
  const bundle = validateBundle(input);
  const now = (options.now ?? (() => Date.now() / 1000))();
  const skew = options.maxClockSkewSeconds ?? 60;
  if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0) throw new RangeError("Invalid policy clock configuration");
  if (bundle.expires_at <= bundle.issued_at || bundle.issued_at > now + skew || bundle.expires_at <= now) {
    throw new TypeError("Policy bundle is not currently valid");
  }
  const ownerOrigins = new Set(options.allowedOrigins.map((origin, index) => httpsOrigin(origin, `allowedOrigins[${index}]`)));
  for (const origin of bundle.origins) {
    if (!ownerOrigins.has(origin)) throw new TypeError("Policy cannot expand the application origin allowlist");
  }
  const keyId = bundle.signature.key_id;
  const encodedKey = options.publicKeys[keyId];
  if (!encodedKey) throw new TypeError("Unknown policy signing key");
  const rawKey = decodeBase64(encodedKey, 32, "public key");
  const signature = decodeBase64(bundle.signature.value, 64, "signature");
  const payload = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "signature"));
  const message = new TextEncoder().encode(canonicalize(payload));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", toArrayBuffer(rawKey), { name: "Ed25519", false, ["verify"]);
  } catch {
    throw new TypeError("Ed25519 verification is unavailable or the public key is invalid");
  }
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, toArrayBuffer(signature), toArrayBuffer(message));
  if (!valid) throw new TypeError("Policy signature verification failed");
  if (!await options.versionStore.advanceIfNewer(bundle.policy_version)) {
    throw new TypeError("Policy version rollback or replay rejected");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    version: bundle.policy_version,
    issuedAt: bundle.issued_at,
    expiresAt: bundle.expires_at,
    origins: Object.freeze([...bundle.origins]),
    maxAttempts: Math.min(bundle.max_attempts ?? bundle.origins.length, bundle.origins.length),
  });
}
