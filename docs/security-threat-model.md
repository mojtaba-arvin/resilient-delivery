# Security Threat Model

## Scope and assets

Assets: bearer credentials, minimized delivery observations, signed policy bundles, durable DuckDB data, Parquet exports, and release artifacts.

Trust boundaries:
1. Browser application to configured API origins.
2. Browser SDK to the telemetry collector.
3. OTLP gateway to the JSON adapter and collector.
4. Collector process to local DuckDB and Parquet storage.
5. Operator to deployment secrets, backups, and policy-signing keys.

## Threats and controls

| Threat | Existing control | Remaining validation |
|---|---|---|
| Credential disclosure | Bearer values are hashed before collector storage; adapter does not log payloads | Secret scanning and deployment secret rotation |
| Replay / duplicate batches | Transactional receipts scoped by token digest and idempotency key | Concurrent replay and crash-window tests |
| Payload abuse | 64 KiB body limit, 100-event limit, strict schema | Sustained load and queue saturation tests |
| Queue exhaustion | Bounded Tokio queue and 503 backpressure | Fault-lab recovery test |
| Policy tampering | Ed25519 verification and monotonic version store | Key compromise and rotation drill |
| Container compromise | Non-root, read-only filesystem, dropped capabilities, no-new-privileges | Runtime image scan and host hardening |
| Network interception | Loopback-only Compose exposure; TLS expected at trusted ingress | Deploy and verify an actual TLS ingress |
| Cross-tenant data exposure | Distinct token digests and per-token quotas; idempotency namespace scoped per token | **Shared-storage multi-tenant mode disabled**: production startup rejects more than one token; use one collector/storage volume per tenant |

## Tenant-isolation boundary

The production binary now fails closed unless exactly one bearer token is configured. This deliberately prevents operators from mistaking independent rate-limit buckets and idempotency namespaces for data isolation. The library router can still be instantiated with multiple tokens for isolated tests, but the deployable service does not support shared-storage multi-tenancy. For untrusted tenants, deploy one collector process and storage volume per tenant. Tenant-scoped storage, authorization, and metrics remain future work before shared-storage multi-tenancy can be enabled.

## Operational requirements

- Supply secrets through the deployment secret manager; never commit `.env` files.
- Terminate TLS at a trusted ingress and restrict ingress to authenticated clients.
- Restrict DuckDB and Parquet volume permissions; encrypt backups at rest.
- Test restore into a clean environment and compare row counts and checksums.
- Rotate bearer tokens and policy signing keys on a documented schedule.
- Pin production container images by digest and review dependency advisories before release.

## Release-blocking findings

A Stable release must not claim tenant isolation, native OTLP protobuf/gRPC in the Rust collector, or verified TLS until the relevant deployment and security tests pass. The OTLP gateway is a separate component. The current multi-token feature is quota separation, not a complete tenant security boundary.
