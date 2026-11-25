# Resilient Delivery

A privacy-first delivery SDK for applications that need reliable requests across explicitly configured origins.

**Status: early development; not a stable production release.** The repository now includes a TypeScript Web SDK, bounded IndexedDB offline queue, Ed25519 policy verification and publisher, a Rust/Axum collector with transactional DuckDB storage, read-only metrics dashboard, benchmark and network-fault tooling, a Node.js SDK, and an optional OpenTelemetry Collector gateway. OTLP protobuf/gRPC is gateway-based, not native Rust collector support. Production readiness still requires verified deployment TLS, backup/restore drills, single-tenant deployment boundaries, sustained benchmarks, and complete current-SHA CI gates.

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

**HTTP 202 is returned only after the complete batch commits in DuckDB.** The DuckDB file is the recovery source of truth. On graceful shutdown, the collector drains the queue and writes an fsynced Parquet snapshot using a temporary file and atomic rename. An abrupt stop can leave the Parquet snapshot stale, but committed DuckDB transactions are used for restart recovery. The protocol is at-least-once by default. When the client supplies `Idempotency-Key`, the collector stores the key and exact request-body digest in the same DuckDB transaction; replaying the same key and bytes returns 202 without a second insert, while reusing the key with different bytes returns 409. This deduplication is bounded by the configured retention window. Requests without the header can create duplicates after an ambiguous network outcome. See [collector/README.md](collector/README.md) for environment variables, delivery semantics, and operational boundaries.

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

The optional `IndexedDBOfflineQueue` stores bounded, age-limited application payloads in IndexedDB. It removes a payload only after the application's authenticated sender confirms success. The sender receives the stable queue item ID as its second argument; forward it as the collector's `Idempotency-Key` header so a crash after server commit but before local deletion does not create duplicate observations. The queue defaults to its own `resilient-delivery-offline` IndexedDB database (separate from the policy-version database); configure a stable database name, maximum item count, maximum age, and per-payload byte limit. The optional Service Worker asset (`sdk-web/public/resilient-delivery-sw.js`) uses Background Sync only as a best-effort wake-up signal; it never stores credentials or sends network requests itself. The page handles the message and flushes with the application's authenticated sender. If Background Sync is unavailable, `installOnlineFlushHandler(queue, sender)` flushes on page startup and the browser's `online` event. The Service Worker wake-up handler and online fallback share the queue's per-instance flush lock. **This is not guaranteed background delivery:** browser support and scheduling vary, browsers/operating systems may throttle or suppress background events, and a fully closed browser cannot be relied on to wake and upload queued data. Delivery resumes only when the browser runs the page or an eligible background event is actually dispatched. IndexedDB can also be evicted or cleared by the user/browser.

Queue delivery is at-least-once across process crashes: a crash after server acceptance but before local deletion can cause a replay. Use collector `Idempotency-Key` support where available. Multiple tabs/queue instances should be coordinated by the application; this initial queue serializes flushes per instance only. Enqueue only consented, minimized observations.

## Observability and performance lab

See [docs/observability-and-lab.md](docs/observability-and-lab.md) for authenticated collector metrics, the dashboard, benchmark runner, and local fault-injection proxy.

## Deployment and integration

A non-root Docker image and hardened Compose stack are provided at the repository root. Each collector process accepts exactly one bearer token for its local DuckDB volume; multiple tokens on shared storage fail startup and do not provide tenant isolation. See [collector/README.md](collector/README.md) for liveness/readiness, persistent storage, backup/restore, and the OTLP JSON Logs adapter. Deploy behind a trusted TLS-terminating ingress; the Compose port is loopback-only by default. An optional OpenTelemetry Collector Contrib gateway accepts OTLP/HTTP and OTLP/gRPC and translates minimized logs to the JSON adapter; the Rust collector itself does not natively accept protobuf/gRPC.

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
5. Phase 4: operational readiness and a verified stable release, including target deployment, TLS, tenant isolation, independent backup/restore, capacity validation, security review, and rollback evidence.
6. Android and iOS SDKs are deferred until the core service has completed its operational-readiness gate; they are not on the current critical path.

See [the release-readiness checklist](docs/release-readiness.md) before any production deployment or release. The [zero-infrastructure release path](docs/zero-infrastructure-release-path.md) describes the no-spend work that can be completed before provisioning a target environment. Also see [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md).


