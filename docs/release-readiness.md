# Release readiness and operator evidence

This checklist is the release gate for the current early-development product. A green CI run is necessary but is not proof that a target deployment is safe. Do not create a stable tag or publish a production-readiness claim while any required gate below is unverified.

## Release decision

The release owner records one of: **blocked**, **candidate**, or **approved**.

- **Blocked**: any required check is missing, failed, stale, or lacks evidence from the target environment.
- **Candidate**: source and CI gates pass on the exact proposed commit, and deployment/restore/security evidence is being collected.
- **Approved**: every required gate is complete, reviewed, and attached to the release record.

The repository's current status remains early development until the release owner records an approved decision. Never infer approval from a merged PR, a successful build, or a green subset of CI jobs.

## Required gates

### 1. Source and CI integrity

- [ ] Record the full candidate commit SHA and verify the release branch/tag points to it.
- [ ] All required GitHub Actions jobs for that exact SHA completed successfully; no skipped required job, cancelled run, stale run, or missing artifact is treated as a pass.
- [ ] Web SDK typecheck, tests, and production build pass.
- [ ] Browser compatibility matrix passes on the supported browser versions.
- [ ] Node SDK and protocol integration tests pass.
- [ ] Rust formatting, Clippy with warnings denied, full serialized tests, and release build pass.
- [ ] Security regression checks and dependency audit pass. Any advisory exception must match the narrowly documented exception in the threat model; do not broaden it silently.
- [ ] Network fault, OTLP, container, TLS-profile, and backup/restore integration jobs pass.
- [ ] Container integration proves two isolated collector processes reject each other's credentials and retain separate committed observations; multi-token startup fails closed.
- [ ] Review the exact run and job logs, not just a status badge. Save links to the run and required artifacts.

### 2. Deployment and TLS

- [ ] Deploy the candidate image to a production-like target with a pinned immutable image digest.
- [ ] Confirm the collector's direct host port is not publicly reachable; public traffic enters only through a trusted TLS ingress.
- [ ] Verify the real DNS name, certificate chain, renewal path, ingress authorization, and authenticated ingestion from outside the host.
- [ ] Verify `/healthz`, `/readyz`, authenticated `/metrics`, and one minimized test batch. Confirm the batch is committed before treating HTTP 202 as success.
- [ ] Confirm collector, adapter, OTLP receiver, and administrative ports are not unintentionally exposed.
- [ ] Record the deployment configuration with secret values redacted.

The local Caddy Compose profile and CI TLS smoke test validate the configuration path; neither substitutes for a certificate and ingress check on the actual target domain.

### 3. Single-tenant isolation

The supported deployment boundary is one collector process, one bearer credential, and one local DuckDB volume per tenant. Shared-process multi-tenant storage is not supported.

- [ ] For every tenant, verify a distinct process/service, storage volume, bearer credential, ingress authorization policy, and backup destination.
- [ ] Verify tenant A credentials cannot read, write, or inspect tenant B data, metrics, backups, or administrative surfaces.
- [ ] Verify a second token configured in one collector causes startup to fail closed.
- [ ] Verify volume mounts and filesystem permissions prevent cross-service access.
- [ ] Do not describe per-token quotas or idempotency namespaces as tenant isolation.

If these checks cannot be demonstrated in the target topology, the deployment is not approved for multiple tenants.

### 4. Backup, restore, and recovery

Use the procedure in [Backup, Restore, and TLS Deployment](backup-restore-tls.md).

- [ ] Take a backup from a cleanly stopped collector; do not copy a live DuckDB database.
- [ ] Verify the SHA-256 sidecar and store the backup in the approved encrypted, access-controlled destination.
- [ ] Restore into a clean isolated path using UID/GID `10001:10001` (or explicitly correct ownership).
- [ ] Start the candidate collector against the restored copy; verify readiness, expected row counts, and a known idempotency receipt.
- [ ] Verify a conflicting payload under an existing idempotency key returns 409 and does not insert a second observation.
- [ ] Record elapsed recovery time and any data loss against the service's agreed recovery objectives.
- [ ] Confirm the backup is retained independently of the source volume and that restore instructions are available to the on-call operator.

A CI restore test is a regression check, not an operational restore drill. A release remains blocked until the target backup destination and restore procedure have been exercised.

### 5. Performance and capacity

Use [the benchmark and fault-injection lab](observability-and-lab.md).

- [ ] Agree on throughput, p95/p99 latency, error-rate, queue saturation, and recovery objectives before the run. Do not invent SLOs from a single benchmark.
- [ ] Record hardware/VM size, CPU and memory limits, OS/kernel, container digest, Rust build mode, DuckDB storage location, rate-limit configuration, request count, concurrency, warm-up, and trial duration.
- [ ] Run multiple trials on an otherwise idle production-like host at expected load and a documented overload level.
- [ ] Include 202, 409, 429, 503, and transport failures in the result interpretation; a high request rate that mostly measures rate limiting is not a throughput pass.
- [ ] Capture p50/p95/p99 latency, successful committed events/second, CPU, memory, queue availability/rejections, and database growth.
- [ ] Run latency, partition, connection-reset, and recovery scenarios; verify service recovers without acknowledging uncommitted batches.

The checked-in CI benchmark is a small repeatable regression sample, not a capacity certification.

### 6. Security and operations

- [ ] Complete a runtime configuration review and an independent security assessment appropriate to the deployment's exposure.
- [ ] Verify secret-manager delivery, token rotation, backup encryption, volume permissions, host hardening, image provenance, and dependency review.
- [ ] Confirm logs and metrics contain no bearer credentials, request bodies, full URLs, IP addresses, or stable device identifiers.
- [ ] Confirm retention and deduplication windows exceed the maximum supported retry horizon.
- [ ] Document on-call ownership, alert thresholds, incident contacts, maintenance windows, and escalation.
- [ ] Review the threat model and record any accepted residual risks with an owner and expiry/review date.

## Rollback and recovery

1. Stop new ingestion at the ingress or route it away from the candidate.
2. Preserve the candidate's database and logs for diagnosis; do not overwrite the only copy.
3. Restore the last verified backup into a separate volume and verify its checksum before use.
4. Roll back the image only if that binary supports the restored database schema. Never downgrade across an unsupported schema migration.
5. Start the previous known-good image against the verified restore, check readiness, then send a small authenticated idempotent test batch.
6. Re-enable traffic only after the operator confirms the test batch committed and the ingress/TLS path is healthy.
7. Record the incident, recovery point, recovery duration, and follow-up actions.

## Evidence record

Copy this section into the release record and fill every field. Use `not run` or `not applicable` explicitly; do not leave ambiguous blanks.

| Field | Evidence |
|---|---|
| Candidate version and tag | |
| Full source commit SHA | |
| CI run URL and completion time | |
| Required jobs and artifact links | |
| Container image digest | |
| Target environment and deployment time | |
| TLS certificate/ingress verification | |
| Tenant isolation topology and test evidence | |
| Backup identifier and SHA-256 | |
| Restore test time, result, and recovery point | |
| Benchmark configuration and result artifact | |
| Security review and accepted risks | |
| Rollback image, backup, and operator | |
| Decision: blocked / candidate / approved | |
| Decision owner and timestamp | |

## Target-environment evidence package

The per-deployment evidence register, target execution protocols, current blocked status, and exact external owner actions are maintained in [Target-environment evidence package](target-environment-evidence-package.md). Update that package with immutable artifact links and per-run receipts; do not treat local CI or workstation rehearsals as target-environment PASS.

## Current project boundary

Until the evidence record is complete and approved, describe Resilient Delivery as early development. The Rust collector is single-tenant per process/volume; OTLP protobuf/gRPC is provided by the optional external OpenTelemetry Collector gateway; local CI TLS and restore tests do not prove target-environment TLS or disaster recovery.
