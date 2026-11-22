# Resilient Delivery

A privacy-first delivery SDK for applications that need reliable requests across explicitly configured origins.

**Status: early development.** The browser SDK includes request deadlines, safe failover, opt-in observations, Ed25519 policy verification, and a persistent IndexedDB policy-version store. The Rust collector provides an authenticated ingestion edge backed by transactional DuckDB storage and graceful-shutdown Parquet snapshots. Policy publishing, a network lab, dashboard, and native SDKs are not implemented yet.

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

## Rust collector

The Axum service accepts versioned telemetry batches at `POST /v1/telemetry/batches`. It requires a bearer token, rejects unknown fields and oversized batches, applies a process-wide token bucket, and uses a bounded queue for backpressure.

**HTTP 202 is returned only after the complete batch commits in DuckDB.** The DuckDB file is the recovery source of truth. On graceful shutdown, the collector drains the queue and writes an fsynced Parquet snapshot using a temporary file and atomic rename. An abrupt stop can leave the Parquet snapshot stale, but committed DuckDB transactions are used for restart recovery. The protocol is at-least-once: if a client loses the response after commit, retrying can create duplicates. See [collector/README.md](collector/README.md) for environment variables, delivery semantics, and operational boundaries.

## Development

Requirements: Node.js 22+, pnpm 9+; Rust stable for the collector.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path collector/Cargo.toml -- --check
cargo clippy --manifest-path collector/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path collector/Cargo.toml
cargo build --release --manifest-path collector/Cargo.toml
```

## Offline browser delivery

The optional `IndexedDBOfflineQueue` stores bounded, age-limited application payloads in IndexedDB. It removes a payload only after the application's authenticated sender confirms success. The sender receives the stable queue item ID as its second argument; forward it as the collector's `Idempotency-Key` header so a crash after server commit but before local deletion does not create duplicate observations. The queue defaults to its own `resilient-delivery-offline` IndexedDB database (separate from the policy-version database); configure a stable database name, maximum item count, maximum age, and per-payload byte limit. The optional Service Worker asset (`sdk-web/public/resilient-delivery-sw.js`) uses Background Sync only as a wake-up signal; it never stores credentials or sends network requests itself. The page handles the message and flushes with the application's authenticated sender. If Background Sync is unavailable, `installOnlineFlushHandler(queue, sender)` flushes on page startup and the browser's `online` event. The Service Worker wake-up handler and online fallback share the queue's per-instance flush lock.

Queue delivery is at-least-once across process crashes: a crash after server acceptance but before local deletion can cause a replay. Use collector `Idempotency-Key` support where available. Multiple tabs/queue instances should be coordinated by the application; this initial queue serializes flushes per instance only. Enqueue only consented, minimized observations.

## Observability and performance lab

See [docs/observability-and-lab.md](docs/observability-and-lab.md) for authenticated collector metrics, the dashboard, benchmark runner, and local fault-injection proxy.

## Deployment and integration

A non-root Docker image and hardened Compose stack are provided at the repository root. See [collector/README.md](collector/README.md) for liveness/readiness, persistent storage, multi-tenant bearer-token quotas, and the OTLP JSON Logs adapter. Deploy behind a TLS-terminating ingress; the Compose port is loopback-only by default.

## Policy publishing and distribution

See [docs/policy-publishing.md](docs/policy-publishing.md) for the Ed25519 signing CLI, immutable version artifacts, monotonic publication, static hosting, and key rotation.

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
3. Phase 2: durable collector storage, policy publishing service, and collector operations hardening.
4. Phase 3: network lab, fault injection, and dashboard.
5. Phase 4: Android and iOS SDKs.

See [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md).
