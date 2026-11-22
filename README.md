# Resilient Delivery

A privacy-first delivery SDK for applications that need reliable requests across explicitly configured origins.

**Status: early development.** The browser SDK includes request deadlines, safe failover, opt-in observations, Ed25519 policy verification, and a persistent IndexedDB policy-version store. The Rust collector now provides an authenticated, bounded, privacy-minimized ingestion edge. Durable storage, policy publishing, dashboard, and native SDKs are not implemented yet.

## Principles

- Routing decisions happen locally; no control-plane round trip is required.
- Only origins explicitly configured by the application owner are eligible.
- No IP address, persistent device identifier, request body, or full URL is collected.
- Telemetry is opt-in. Without consent, local routing still works.
- Non-idempotent requests are never retried unless an idempotency key is supplied and enforced by the server.
- No VPN, traffic obfuscation, covert transport, proxy discovery, or circumvention features.

## Web SDK

Runtime: TypeScript and browser Fetch API; no runtime dependencies.

```ts
import { ResilientClient } from "@resilient-delivery/web";
const client = new ResilientClient({
  primaryOrigin: "https://api.example.com",
  fallbackOrigins: ["https://api-backup.example.com"],
});
const response = await client.fetch("/v1/catalog");
```

For non-idempotent operations, pass an application-generated key that the server enforces:

```ts
await client.fetch("/v1/orders", {
  method: "POST",
  headers: { "Idempotency-Key": orderAttemptId },
  body: JSON.stringify(order),
});
```

## Rust collector (early ingestion edge)

The Axum service accepts versioned telemetry batches at `POST /v1/telemetry/batches`. It requires a bearer token, rejects unknown fields and oversized batches, applies a process-wide token bucket, and uses a bounded queue for backpressure. See [collector/README.md](collector/README.md) for the contract and run instructions. HTTP 202 means volatile in-memory acceptance only; durable persistence is not implemented.

## Development

Requirements: Node.js 22+, pnpm 9+.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Signed policy verification

The SDK exports `verifyPolicyBundle` for owner-signed Ed25519 bundles. Configure the public-key ring and the immutable application-owned origin allowlist. Use `IndexedDBPolicyVersionStore` to persist the highest accepted policy version across page reloads:

```ts
import { IndexedDBPolicyVersionStore, verifyPolicyBundle } from "@resilient-delivery/web";

const versionStore = new IndexedDBPolicyVersionStore({
  databaseName: "my-application",
});
const policy = await verifyPolicyBundle(bundle, {
  publicKeys,
  allowedOrigins: ["https://api.example.com", "https://backup.example.com"],
  versionStore,
});
// On application shutdown, close the connection if appropriate:
await versionStore.close();
```

The adapter reads and conditionally advances the version in one IndexedDB `readwrite` transaction and resolves only after the transaction commits. IndexedDB serializes overlapping readwrite transactions on the same object store, preventing concurrent callers from accepting stale versions. If IndexedDB is unavailable, blocked, or fails, verification fails closed. The application should keep the database name stable and avoid deleting or clearing this store; storage eviction or user-cleared site data cannot be prevented by a browser SDK.

## Roadmap

1. Phase 0: contracts, privacy/security constraints, SDK API, CI.
2. Phase 1: adaptive route selection, safe failover, bounded local telemetry, per-attempt deadlines, cancellation, redirect containment, and signed-policy verification.
3. Phase 2: durable DuckDB/Parquet persistence, policy publishing service, and collector operations hardening.
4. Phase 3: network lab, fault injection, and dashboard.
5. Phase 4: Android and iOS SDKs.

See [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md).
