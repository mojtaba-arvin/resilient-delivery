# Protocol and SDK Expansion

## OTLP Protobuf and gRPC

The optional OpenTelemetry Collector Contrib bridge is the protocol boundary:
- OTLP/gRPC is accepted on loopback port 4317.
- OTLP/HTTP (including protobuf payloads) is accepted on loopback port 4318.
- The collector normalizes and exports OTLP HTTP/JSON to the existing minimized adapter.
- The adapter forwards only the allowlisted `resilient.route_index`, `resilient.duration_ms`, `resilient.outcome`, and optional HTTP status attributes.

This avoids claiming that the Rust collector itself implements the OTLP protobuf wire protocol. It is an interoperable gateway deployment, with an explicit translation boundary.

Start with `docker compose --profile otlp up --build`. Configure an OTLP SDK exporter to `http://127.0.0.1:4317` (gRPC) or `http://127.0.0.1:4318` (HTTP). The adapter requires `COLLECTOR_BEARER_TOKEN`.

## Node.js SDK

`sdk-node/index.mjs` exports `createResilientClient`. It uses only Node's Fetch API, restricts requests to application-owner-configured HTTPS origins in production, blocks redirects, enforces deadlines, and retries only safe methods or requests carrying an Idempotency-Key. It intentionally does not persist credentials or infer additional origins.

## Compatibility contract

The browser and Node SDKs use the same finite origin allowlist and idempotency requirements. OTLP translation is deliberately minimized; arbitrary log bodies, resource attributes, and customer identifiers are not forwarded.
