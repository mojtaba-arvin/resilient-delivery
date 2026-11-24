# ADR 0004: OTLP protocol gateway

- Status: Accepted
- Decision: terminate OTLP/gRPC and OTLP/HTTP at the OpenTelemetry Collector Contrib gateway; translate to the project's minimized OTLP HTTP/JSON adapter.
- Rationale: keeps protobuf/gRPC protocol complexity outside the small Rust ingestion service while providing standard OpenTelemetry interoperability.
- Security: listener ports bind to host loopback; only the adapter forwards allowlisted delivery attributes; credentials remain in the adapter environment.
- Limitation: this is a gateway integration, not native OTLP protobuf support inside the Rust collector.
