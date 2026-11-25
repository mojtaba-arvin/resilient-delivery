# Zero-infrastructure path to release readiness

This plan assumes the project owner currently has **no VPS, cloud account, domain, or independent backup destination**. It deliberately starts with work that can be completed on a developer workstation without purchasing services.

This plan does not redefine the release gates in [release-readiness.md](release-readiness.md). Local exercises reduce deployment risk and prepare the evidence package; they do not count as proof of real DNS, public TLS, independent backup, or target-host operations.

## Cost and authorization policy

- Keep the initial work at **zero additional infrastructure spend**.
- Do not create paid cloud resources, register a domain, enable a paid subscription, or incur usage charges without explicit approval from the owner.
- Never put credentials, private keys, access tokens, or unredacted environment files in Git, issue comments, or chat.
- Do not publish a stable tag or claim production readiness based on local-only evidence.

## Stage 0 — Establish the local baseline

Run from a clean checkout of the exact candidate commit:

1. Record the full commit SHA and the local toolchain versions.
2. Run the repository's documented install, typecheck, tests, build, Rust format/lint/test/release-build commands.
3. Run the required GitHub Actions workflows for the candidate SHA and retain links to the run and artifacts.
4. Build the container image locally and record its image ID/digest and source commit.
5. Record failures as actionable issues; do not silently waive skipped or missing required checks.

**Exit evidence:** a reproducible local build/test record and a green required CI run for the same SHA.

## Stage 1 — Local deployment rehearsal

Use the checked-in Docker/Compose deployment profile on the workstation:

1. Start one collector with a dedicated local data volume and a test-only bearer credential.
2. Verify health/readiness, authenticated ingestion, commit-before-202 behavior, metrics authentication, and graceful shutdown.
3. Exercise restart and abrupt-stop recovery using disposable test data.
4. Verify the collector's host port remains loopback-only and inspect the effective published ports.
5. Capture sanitized configuration and command output; redact credentials and local personal paths.

**Exit evidence:** a local deployment record tied to the candidate image digest. This is a rehearsal, not a target-environment deployment.

## Stage 2 — Local isolation and recovery rehearsal

1. Start two independent collector services, each with its own process, data volume, and test credential.
2. Prove credential A cannot access collector B and vice versa; verify stored observations remain separate.
3. Verify that configuring multiple tenant tokens in one collector fails closed.
4. Stop a collector cleanly, create a backup, verify its SHA-256, and restore into a fresh isolated volume with UID/GID `10001:10001`.
5. Verify readiness, expected records, idempotency replay, and conflicting-payload behavior after restore.
6. Keep the backup copy outside the source data directory. A second directory on the same workstation is only a rehearsal, not an independent backup destination.

**Exit evidence:** repeatable local isolation and restore results, with explicit limitations recorded.

## Stage 3 — Workstation performance baseline

Use the existing benchmark and fault-injection tooling:

1. Record hardware, OS/kernel, container digest, storage path, limits, configuration, warm-up, duration, concurrency, and request count.
2. Agree provisional expected-load and overload profiles before running; label them as engineering assumptions until the actual target capacity is known.
3. Run multiple trials and record p50/p95/p99, successfully committed events/sec, CPU, memory, queue pressure/rejections, database growth, and recovery behavior.
4. Include transport failures and 202/409/429/503 responses in the interpretation.
5. Do not market workstation results as production capacity or infer an SLO from a single run.

**Exit evidence:** repeatable baseline results and a documented target-capacity question list.

## Stage 4 — Prepare, but do not yet execute, the external deployment

Prepare these artifacts without provisioning anything:

- A minimal target topology: one service, volume, credential, and backup destination per tenant.
- A deployment runbook with ports, firewall rules, ingress, health checks, and rollback sequence.
- A secret-management and rotation procedure.
- A backup/restore and retention procedure.
- A benchmark plan and agreed SLO, RTO, and RPO.
- A security review checklist, on-call owner, alert thresholds, and incident contacts.
- A redacted evidence record based on [release-readiness.md](release-readiness.md).

**Exit evidence:** reviewed, executable runbooks with unresolved owner decisions clearly listed.

## Stage 5 — Smallest external pilot (requires owner approval)

Only after Stages 0–4 are complete, choose a low-cost provider and a real domain. Before any purchase, present the owner with the provider, exact resource sizes, region, expected monthly and one-time cost, renewal terms, and teardown procedure for approval.

Then:

1. Provision one small target host and a real DNS name.
2. Configure trusted TLS ingress and verify the certificate chain and renewal path.
3. Verify authenticated ingestion from a client outside the host.
4. Prove the single-tenant process/volume/credential boundary in the actual target topology.
5. Configure an encrypted backup destination independent of the host and perform a clean restore drill.
6. Run repeated expected-load and overload benchmarks on the target hardware.
7. Complete runtime security review and rollback rehearsal.
8. Attach evidence and record the release owner's decision in the release evidence record.

If no external resources are approved, stop at Stage 4 and keep the release status **blocked / early development**. Do not substitute local evidence for external gates.

## Owner inputs

No action is required from the owner to complete Stages 0–4 as repository/workstation work, except access to a workstation if commands must be run there. Before Stage 5, the owner must approve the proposed provider and budget. The owner must also provide or approve the production domain and name the operational/on-call owner.

## Current execution status

This document is a plan, not evidence that any stage has been executed. Track actual results, dates, commit SHAs, image digests, and artifact links in the release evidence record. Keep [production evidence issue #24](https://github.com/mojtaba-arvin/resilient-delivery/issues/24) open until every required target-environment gate is satisfied.
