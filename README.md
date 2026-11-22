# Resilient Delivery

A privacy-first delivery SDK for applications that need reliable requests across explicitly configured origins.

**Status: early development.** The first milestone establishes a dependency-free TypeScript web SDK and deterministic unit tests. Collector, signed policy distribution, dashboard, and native SDKs are not implemented yet.

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

## Development

Requirements: Node.js 22+, pnpm 9+.

```sh
pnpm install
pnpm check
```

## Roadmap

1. Phase 0: contracts, privacy/security constraints, SDK API, CI.
2. Phase 1 (in progress): adaptive route selection, safe failover, bounded local telemetry, per-attempt deadlines, cancellation, and redirect containment.
3. Phase 2: Ed25519 policy verification/distribution and Rust collector.
4. Phase 3: network lab, fault injection, and dashboard.
5. Phase 4: Android and iOS SDKs.

See [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md).
