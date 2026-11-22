# Changelog

All notable changes to Resilient Delivery are documented here.

## Unreleased

### Added
- Isolated network fault lab using Toxiproxy and Linux netem runbook.
- Optional OpenTelemetry Collector Contrib gateway for OTLP/gRPC and OTLP/HTTP.
- Node.js Fetch SDK with configured-origin failover and idempotency-aware retries.
- Security threat model and static regression checks.
- Release manifest and tag validation.

### Operational limitations
- Multiple bearer tokens provide separate quotas and idempotency namespaces, not tenant data isolation.
- TLS is terminated at a trusted ingress; the collector does not terminate TLS itself.
- DuckDB remains a single-process local-storage design.
- OTLP protobuf/gRPC is handled by the optional OpenTelemetry gateway, not natively by the Rust collector.
