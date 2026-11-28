# CI packaging only: consume the exact release binaries built and tested by
# the Rust validation job. Production builds continue to use the root Dockerfile.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home collector \
    && mkdir -p /data \
    && chown collector:collector /data

COPY .ci/collector /usr/local/bin/collector
COPY .ci/compact /usr/local/bin/compact
RUN chmod 0755 /usr/local/bin/collector /usr/local/bin/compact

USER 10001:10001
ENV COLLECTOR_BIND=0.0.0.0:8080 \
    COLLECTOR_DATABASE_PATH=/data/collector.duckdb \
    COLLECTOR_PARQUET_PATH=/data/telemetry.parquet
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/collector"]
