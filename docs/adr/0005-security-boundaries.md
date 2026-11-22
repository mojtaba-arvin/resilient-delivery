# ADR 0005: Explicit security boundaries

- Status: Accepted
- Decision: document token quota separation separately from tenant data isolation; require one isolated collector/storage volume per untrusted tenant until tenant-scoped storage and authorization exist.
- Decision: keep static security regression checks in the dedicated Security workflow, while retaining runtime and deployment verification as release gates.
- Rationale: a token identity and rate-limit bucket alone do not enforce row-level or metric-level authorization.
