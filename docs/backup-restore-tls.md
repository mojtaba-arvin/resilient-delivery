# Backup, Restore, and TLS Deployment

## Backup and restore

DuckDB is the durable recovery source of truth. Stop the collector cleanly before copying the database so no writer or WAL activity is in progress. The backup command copies to a temporary sibling, fsyncs, atomically renames, and writes a SHA-256 sidecar:

```sh
node scripts/backup-restore.mjs backup /data/collector.duckdb /backups/collector.duckdb
node scripts/backup-restore.mjs restore /backups/collector.duckdb /data/collector.duckdb
```

Restore verifies the sidecar digest before changing the destination. Always restore into an isolated path first and start the collector against that path for verification. These scripts intentionally do not copy a live database; do not run them while the collector is writing.

## Physical compaction

Retention deletes expired rows and checkpoints the WAL, but a checkpoint alone does not guarantee that the DuckDB file shrinks. To reclaim free pages, stop the collector and run the offline rebuild utility against the persistent volume:

```sh
docker compose stop collector
docker compose run --rm --no-deps --entrypoint /usr/local/bin/compact collector /data/collector.duckdb
docker compose start collector
```

The compaction command copies the complete DuckDB database into a fresh sibling file, fsyncs it, and atomically replaces the original. Never run it while the collector or another process has the database open. Take a verified backup first.

## TLS ingress

The optional Caddy profile terminates HTTPS and proxies to the collector over the private Compose network. Set `COLLECTOR_DOMAIN` to a DNS name pointing at the host, then run:

```sh
COLLECTOR_DOMAIN=telemetry.example.com COLLECTOR_BEARER_TOKEN=<secret> docker compose --profile tls up -d
```

Caddy obtains and renews certificates automatically. Keep ports 80/443 reachable for ACME validation. The collector's direct host port remains loopback-only; public traffic should enter through Caddy. For environments with an external ingress, do not enable the Caddy profile and configure the ingress to forward to the private collector service.

## Upgrade

Use immutable image tags, back up the database before upgrade, deploy the new image, verify `/healthz` and `/readyz`, and run a small authenticated test batch. Keep the previous image and verified backup available for rollback. DuckDB schema changes must be backward-compatible or accompanied by an offline migration and restore drill.
