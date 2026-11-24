# Product Roadmap

This roadmap distinguishes supported implementations from planned SDKs. A planned item is not a release capability.

## Current implementation tracks

- Web SDK: TypeScript Fetch client, local route selection, optional minimized observations, durable IndexedDB offline queue, and signed policy verification.
- Collector: authenticated Rust/Axum ingestion, bounded queue, transactional DuckDB writes, idempotency receipts, retention, and Parquet snapshots.
- Node SDK: dependency-free Fetch client with configured-origin failover and idempotency-aware retry.
- Policy distribution: Ed25519-signed immutable artifacts with monotonic publication.
- OTLP: JSON adapter plus optional OpenTelemetry Collector Contrib gateway for gRPC and HTTP ingestion.
- Operations: Docker deployment, optional Caddy TLS ingress, metrics, dashboard, benchmark and fault-lab tooling.

## Native SDK sequence

1. **Node.js stabilization:** publish typed declarations, semantic-version compatibility tests, and package provenance.
2. **Python SDK:** use standard HTTP clients and explicit origin allowlists; do not introduce implicit proxy discovery.
3. **Go SDK:** context cancellation, request deadlines, replay-safe retry, and bounded telemetry queue.
4. **Mobile SDKs:** only after the shared protocol, consent model, offline semantics, and security review are stable. Android and iOS implementations should use native persistence and platform background scheduling; neither should persist bearer credentials in a shared worker.
5. **Cross-SDK conformance:** run the same versioned contract vectors against every SDK before declaring compatibility.

## Release principles

- Native SDKs are separate releases; their absence does not block the core web/collector release.
- Mobile SDKs must not be described as implemented until real-device offline, restart, and background-execution tests pass.
- Keep the public origin allowlist application-owner-controlled in every language.
