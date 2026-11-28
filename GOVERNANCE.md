# Governance

## Scope

Resilient Delivery measures and improves application delivery reliability across **application-owner-configured origins**. The application owner controls the allowlist and operating policy.

The project does not build or accept censorship-circumvention, VPN, traffic-concealment, covert-tunnelling, protocol-obfuscation, proxy-discovery, or network-control-evasion features. Such contributions will be declined.

## Technical enforcement

- Origins must be configured by the application owner or supplied by a valid owner-signed policy.
- The SDK must not discover, generate, rotate, or infer third-party origins.
- No stealth or obfuscation transport is permitted.
- Preserve browser security boundaries (TLS, CORS, CSP, same-origin rules).
- Never replay a request when side-effect safety is unknown.

## Contributions

Architecture and compatibility changes require an ADR in `docs/adr/`. Contributions must include tests and update versioned specifications. Contributors should sign off commits using DCO (`git commit -s`). Security issues belong in the private vulnerability reporting channel, not public issues.

## Pull-request review and merge

The implementer may review their own complete diff, record the security/privacy/compatibility assessment, and merge the PR when the exact head has all required CI checks passing, relevant tests and security regressions pass, review threads are resolved, the branch is up to date, and GitHub reports it mergeable. A formal GitHub approval from the PR author is unavailable and is not required by project policy; never fabricate one or describe self-review as independent peer review. Independent specialist review is risk-based and useful for high-impact changes, but is not a universal merge gate. Never bypass required reviews, status checks, branch protection, rulesets, or merge queues.

PR merge is separate from target deployment and stable-release approval. Keep the existing external evidence for real TLS/DNS, tenant isolation, independent backup/restore, target-hardware capacity, runtime security/on-call review, and rollback. A green PR or merged code does not satisfy those operational gates or authorize spending, production deployment, or a stable release.
