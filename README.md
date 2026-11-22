# Resilient Delivery

A privacy-first delivery SDK for applications that need reliable requests across explicitly configured origins.

**Status: early development.** The browser SDK includes request deadlines, safe failover, opt-in observations, Ed25519 policy verification, and a bounded offline delivery queue. The Rust collector provides authenticated, transactional telemetry ingestion with durable DuckDB storage.

## Web SDK

Install from the workspace:

```sh
pnpm --filter @resilient-delivery/web build
```

The SDK supports explicit origin allowlists, per-origin request deadlines, bounded retry/backoff, failover, and safe handling of non-idempotent requests. Offline queue payloads must be consented and minimized. The optional Service Worker is only a wake-up bridge; credentials and network delivery remain in the page.

## Offline browser delivery

The optional `IndexedDBOfflineQueue` stores bounded, age-limited application payloads in IndexedDB. It removes a payload only after the application's authenticated sender confirms success. The sender receives the stable queue item ID as its second argument; forward it as the collector's `Idempotency-Key` header so a crash after server commit but before local deletion does not create duplicate observations. The queue defaults to its own `resilient-delivery-offline` IndexedDB database (separate from the policy-version database); configure a stable database name, maximum item count, maximum age, and per-payload byte limit. The optional Service Worker asset (`sdk-web/public/resilient-delivery-sw.js`) uses Background Sync only as a wake-up signal; it never stores credentials or sends network requests itself. The page handles the message and flushes with the application's authenticated sender. If Background Sync is unavailable, `installOnlineFlushHandler(queue, sender)` flushes on page startup and the browser's `online` event. The Service Worker wake-up handler and online fallback share the queue's per-instance flush lock.

Queue delivery is at-least-once across process crashes: a crash after server acceptance but before local deletion can cause a replay. Use collector `Idempotency-Key` support where available. Multiple tabs/queue instances should be coordinated by the application; this initial queue serializes flushes per instance only. Enqueue only consented, minimized observations.

## Policy publishing and distribution

See [docs/policy-publishing.md](docs/policy-publishing.md) for the Ed25519 signing CLI, immutable version artifacts, monotonic publication, static hosting, and key rotation.

## Signed policy verification

The SDK exports `verifyPolicyBundle` for owner-signed Ed25519 bundles. Configure the public-key ring and the immutable application-owned origin allowlist. Use `IndexedDBPolicyVersionStore` to persist the highest accepted policy version across page reloads.

## Collector

See [collector documentation](collector/README.md) for the authenticated Rust service, transactional persistence, retention, and deployment constraints.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Browser API compatibility smoke tests are described in [docs/browser-compatibility.md](docs/browser-compatibility.md).
