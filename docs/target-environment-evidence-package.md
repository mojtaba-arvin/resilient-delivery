# Target-environment evidence package — Issue #24

**Repository:** `mojtaba-arvin/resilient-delivery`  
**Evidence record date:** 2026-11-28  
**Record status:** `BLOCKED — TARGET INPUTS AND EXECUTION UNAVAILABLE`  
**Release status:** `EARLY DEVELOPMENT`  
**Decision:** `NOT APPROVED`  
**Decision owner:** Not recorded for a target deployment  
**Approval timestamp:** Not applicable

This is the durable evidence index and execution protocol for one future target deployment. It deliberately records missing evidence as missing. It is not a production attestation, security certification, or authorization to provision infrastructure.

## 1. Candidate identity and provenance

| Field | Current record |
|---|---|
| Repository | `mojtaba-arvin/resilient-delivery` |
| Source baseline inspected | `cafd8d0c6d05d08a8dea70dc9e899784e994fce8` |
| Source baseline URL | https://github.com/mojtaba-arvin/resilient-delivery/commit/cafd8d0c6d05d08a8dea70dc9e899784e994fce8 |
| Exact-source CI | PASS — [CI run 45757108855](https://github.com/mojtaba-arvin/resilient-delivery/actions/runs/45757108855) |
| Workflow validation | PASS — [workflow syntax run 45757108869](https://github.com/mojtaba-arvin/resilient-delivery/actions/runs/45757108869) |
| CI completion | 2026-11-26; successful for the source baseline above |
| Immutable container image digest | NOT RECORDED — no target candidate image was built/published and pinned as `sha256:...` |
| Target deployment identity | NOT SELECTED |
| Configuration revision | NOT RECORDED |
| Release tag / Stable release | MUST NOT BE CREATED |

The CI links prove repository automation for the recorded source SHA only. They do not prove a target image was built, deployed, scanned, or operated. Before a target run, select one exact source SHA, build the release image from it, record the registry/repository and immutable digest, and bind every subsequent result to that pair. Do not use a mutable tag as the evidence identity.

## 2. Evidence register

Allowed states: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, `STALE`. A missing artifact is never a pass or N/A. Every PASS must link an immutable artifact and include the exact target, source SHA, image digest, configuration revision, operator, timestamp, procedure, observed result, and limitations.

| ID | Required claim | Current state | Required evidence before PASS |
|---|---|---|---|
| E-01 | Immutable image digest bound to exact source commit | BLOCKED | Registry image reference, `sha256` digest, build provenance, source SHA, build workflow and timestamp |
| E-02 | Real DNS, trusted TLS, renewal and external authenticated ingestion | BLOCKED | Public DNS resolution; externally collected certificate chain/SAN/expiry; successful renewal drill; ingress authorization; external client request and server-side commit receipt; health/readiness and authenticated metrics checks; redacted config |
| E-03 | One-process / one-volume / one-credential tenant isolation | BLOCKED | Target topology and host/service identities; separate volume IDs and credential IDs per tenant; bidirectional cross-credential denial; filesystem/host permission evidence; single-process multi-token fail-closed result; backup and admin-surface separation |
| E-04 | Independent encrypted backup and clean-volume restore | BLOCKED | Backup destination identity proving independence from source host/volume; encryption/key policy; stopped-writer backup record; SHA-256 sidecar; clean destination volume; restore as UID/GID `10001:10001`; readiness, row-count, receipt replay and conflict checks; measured RPO/RTO |
| E-05 | Repeated target-hardware performance trials | BLOCKED | Hardware/VM and OS/kernel details; immutable image digest; agreed expected/overload profiles and SLOs; at least three trials per profile; raw trial JSON; p50/p95/p99, committed events/sec, CPU, memory, queue pressure/rejections, DB growth and recovery observations |
| E-06 | Runtime security and operational ownership review | BLOCKED | Independent review of secret manager, rotation/revocation, image provenance and vulnerabilities, dependencies, host hardening, storage permissions, network exposure, log privacy, retention, alerting, incident response, named on-call owner and accepted residual-risk register |
| E-07 | Verified rollback with compatible prior image and backup | BLOCKED | Prior image digest and compatibility evidence for restored schema; verified backup ID/digest; isolated restore; controlled traffic drain; rollback operator; readiness and authenticated committed idempotent test batch; measured recovery point/duration; incident/drill record |

### E-02 — DNS, TLS and external ingestion protocol

1. Record the approved FQDN, DNS provider/zone owner, target IP and resolver observations from outside the target network.
2. Confirm only the trusted ingress is public. Verify the collector's direct host port is not publicly reachable and adapter, OTLP receiver and administrative ports are not exposed unintentionally.
3. Capture the certificate subject/SAN, issuer, full chain validation, validity interval, ingress configuration revision and external test timestamp. Redact private keys and secret values.
4. Exercise renewal using the actual ACME/CA path. Capture the renewal event and a fresh externally validated chain after renewal; a configured auto-renewal setting alone is not evidence.
5. From a client outside the host/network, send a minimized authenticated batch. Preserve request correlation/idempotency identifier, response status and independent server-side evidence that the batch committed before HTTP 202. Also verify unauthenticated ingestion and metrics are denied.
6. Record `/healthz`, `/readyz`, authenticated `/metrics`, DNS/TLS test commands, operator, UTC timestamps and artifact links.

### E-03 — Tenant isolation protocol

The supported production boundary is one collector process/service, one DuckDB volume, one bearer credential, one ingress authorization policy and one backup destination per tenant. Do not use shared-process token namespaces, per-token quotas, or idempotency namespaces as proof of tenant isolation.

For at least two separately provisioned tenant instances in the actual target:
- Record service/process identity, host or isolation boundary, volume ID/mount, credential-manager reference, ingress policy and backup destination for each.
- Prove tenant A's credential cannot read, write, inspect metrics, access backups or reach administrative surfaces for tenant B; repeat in the opposite direction.
- Prove host/storage permissions prevent cross-service volume access. Preserve sanitized command output and policy/config revision.
- Attempt multi-token configuration in a single collector and preserve the fail-closed startup result.
- Do not place bearer values, hashes usable as credentials, secret-manager exports or private configuration in this repository.

### E-04 — Independent backup and restore protocol

1. Stop the collector cleanly and verify no writer/WAL activity remains. Do not copy a live DuckDB database.
2. Back up using the documented `scripts/backup-restore.mjs` procedure. Record backup ID, source volume, destination provider/account/region, encryption method/key reference, object version, byte size and SHA-256.
3. Prove the destination is independent of the source host and source storage failure domain. A second directory, Docker volume, or disk on the same workstation/host is not independent.
4. Restore to a newly created isolated clean volume as UID/GID `10001:10001` (or explicitly correct ownership). Verify the sidecar before restore.
5. Start the candidate against the restored copy. Check readiness, expected row counts, a known idempotency receipt, replay behavior and conflicting-payload HTTP 409 without a duplicate observation.
6. Record elapsed backup/restore time, recovery point, data loss (if any), operator and evidence links.

### E-05 — Target-hardware performance protocol

Before measurement, the service owner must approve expected traffic, overload traffic, concurrency, request mix, trial duration, warm-up, rate-limit settings and numerical latency/throughput/error/recovery objectives. Do not infer SLOs from a workstation baseline.

Run at least three repeat trials at each agreed load profile on the actual target hardware, otherwise idle except for declared services. Bind each trial to the same image digest and configuration or explicitly version each variation. Preserve raw machine-readable output. Count only successfully committed HTTP 202 events as committed throughput; report 409, 429, 503 and transport failures separately. Capture p50/p95/p99, committed events/sec, CPU, memory, queue occupancy/availability/rejections, DuckDB growth and recovery after latency, partition and connection-reset faults.

### E-06 — Runtime security and ownership review

The review must identify reviewer and independence, date, exact target/config/image, findings, severity, disposition, evidence links and retest. Cover:
- Secret-manager injection, access scope, rotation, revocation and exposure checks.
- Image digest/provenance, image and OS package vulnerabilities, Rust/Node dependency advisories and documented exceptions.
- Host/kernel/container hardening, non-root UID/GID, read-only filesystem, dropped capabilities, no-new-privileges, network policy and exposed ports.
- Volume ownership/permissions, backup encryption/key custody, retention and restore access.
- Logs/metrics for absence of bearer tokens, request bodies, full URLs, IP addresses and stable device identifiers.
- Alert thresholds, dashboards, escalation, incident contacts, maintenance windows, service owner, on-call primary/backup and coverage acknowledgement.
- Residual risks with accountable acceptor and expiry/review date. No unowned or silently waived finding is accepted.

### E-07 — Rollback protocol

1. Select and record the previous known-good immutable image digest. Prove that binary supports the schema in the chosen verified backup; do not downgrade across an unsupported migration.
2. Stop or route away new ingestion. Preserve candidate data and logs; never overwrite the only copy.
3. Restore the selected backup to a separate clean volume and verify its checksum and ownership.
4. Deploy the prior image digest against the restored volume. Capture operator, exact commands, config revision and timestamps.
5. Verify health/readiness and send a small authenticated idempotent batch through the real ingress. Confirm it committed before accepting the response.
6. Re-enable traffic only after operator verification. Record recovery point, elapsed recovery time, data loss, deviations and follow-up actions.

## 3. Known evidence versus target evidence

The following repository evidence is useful regression coverage, but cannot be promoted to target-environment PASS:

- [CI for source baseline `cafd8d0...`](https://github.com/mojtaba-arvin/resilient-delivery/actions/runs/45757108855) and [workflow validation](https://github.com/mojtaba-arvin/resilient-delivery/actions/runs/45757108869).
- [Issue #24 history](https://github.com/mojtaba-arvin/resilient-delivery/issues/24) records CI container isolation and TLS/restore smoke results as regression-only.
- [Issue #31](https://github.com/mojtaba-arvin/resilient-delivery/issues/31) is the separate zero-infrastructure workstation rehearsal tracker. Its checklist remains distinct from this target evidence register.
- [Zero-infrastructure release path](zero-infrastructure-release-path.md) defines local rehearsals and the owner-approval boundary.
- [Backup, restore and TLS procedure](backup-restore-tls.md) defines the operational method; it does not demonstrate that an external destination or real domain exists.
- [Security threat model](security-threat-model.md) records current controls and remaining runtime validation.

At the time this record was prepared, Issue #31 remained open with no execution evidence comments. No workstation command output, target deployment artifact, target hardware trial, independent backup object, runtime review or rollback drill was available to attach. Do not infer completion from the existence of scripts or runbooks.

## 4. Exact external owner actions required

The latest explicit owner decision recorded in Issue #24 (2026-11-26) states that there is no VPS, cloud account, domain or independent backup destination, and forbids new spend without explicit approval. Reconfirm this state before scheduling external work. No infrastructure was provisioned by this change.

| Owner action | Required decision/input | Why it blocks |
|---|---|---|
| A-01 — Approve target infrastructure and budget | Choose provider, account, region and host/resource sizes; approve an explicit one-time/monthly budget, renewal terms and teardown plan | No target host exists to deploy or benchmark |
| A-02 — Supply/approve production domain | FQDN, DNS-zone control/owner and authority to configure records and ACME renewal | No real DNS name or certificate renewal path can be tested |
| A-03 — Establish credential administration | Approved secret manager, credential administrator, rotation/revocation policy and secure handoff channel | No target bearer credential or key custody evidence |
| A-04 — Provide independent backup destination | Separate failure domain/account/provider, encryption/key ownership, retention and restore permissions | Same-host/local copies do not meet independent-backup requirement |
| A-05 — Identify target hardware and access | Hardware/VM SKU, CPU/RAM/storage/IOPS, OS/kernel, network shape and authorized benchmark window | Workstation numbers cannot establish target capacity |
| A-06 — Name operational ownership | Accountable service/release owner, on-call primary and backup, escalation contacts, coverage hours and alert response acknowledgement | No operator can own incidents or authorize rollback |
| A-07 — Authorize independent security review | Reviewer/organization, scope, access window and residual-risk acceptance authority | Runtime security and operational review are not complete |

After A-01 through A-07 are supplied, prepare a minimal external pilot proposal with exact costs and teardown before provisioning. Execute E-01 through E-07 against one frozen candidate. The release owner must review every artifact and record a dated `approved` decision. Owner inputs do not themselves count as evidence; each drill must be executed and its result attached.

## 5. Release decision and guardrails

**Current decision: BLOCKED / EARLY DEVELOPMENT.**

- No stable tags, Stable GitHub releases, production-readiness claims or multi-tenant claims.
- Do not claim shared-process multi-tenancy. Preserve one process, one volume and one credential per tenant.
- Do not claim native OTLP protobuf/gRPC support in the Rust collector; the optional external OpenTelemetry Collector gateway provides that integration.
- Do not convert local Compose, CI, workstation benchmarks or same-host backup copies into target-environment evidence.
- Do not create paid infrastructure, register a domain, enable subscriptions or incur usage charges without explicit owner approval.
- Keep Issue #24 open until E-01 through E-07 are independently evidenced and the release owner records approval.

## 6. Per-run evidence receipt template

Copy once per executed drill; do not overwrite earlier receipts.

```yaml
evidence_id: "E-xx"
status: "NOT RUN"
requirement: ""
target_id: ""
source_commit: ""
image: ""
image_digest: ""
configuration_revision: ""
operator: ""
reviewer: ""
started_at_utc: ""
completed_at_utc: ""
procedure_and_commands: []
expected_result: ""
observed_result: ""
artifact_uris: []
artifact_sha256: []
limitations: []
findings: []
owner_approval: ""
```

All artifacts must be retrievable by reviewers. For artifacts stored outside Git, record immutable object/version identifiers, SHA-256, byte size, access owner and retrieval instructions. Redact secrets and personal host paths. A statement that a test ran, a local filesystem path, or a checksum without retrievable bytes is insufficient.
