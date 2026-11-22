# syntax=docker/dockerfile:1
FROM rust:1.88-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake clang pkg-config \
    && rm -rf /var/lib/apt/lists/*
ENV CXXFLAGS="-include cstdint" CARGO_TARGET_DIR=/app/target
WORKDIR /app
COPY collector/Cargo.toml ./collector/Cargo.toml
COPY collector/src ./collector/src
RUN cargo build --release --manifest-path collector/Cargo.toml

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home collector \
    && mkdir -p /data \
    && chown collector:collector /data
COPY --from=builder /app/target/release/resilient-delivery-collector /usr/local/bin/collector
COPY --from=builder /app/target/release/compact /usr/local/bin/compact
USER 10001:10001
ENV COLLECTOR_BIND=0.0.0.0:8080 \
    COLLECTOR_DATABASE_PATH=/data/collector.duckdb \
    COLLECTOR_PARQUET_PATH=/data/telemetry.parquet
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/collector"]
