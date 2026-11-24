# Spec 0001: Web SDK request routing

- Status: Initial implementation committed
- Contract version: 1

## Requirements

1. Configure one primary origin and zero or more fallback origins.
2. Require HTTPS except localhost HTTP for development.
3. Reject malformed or duplicate origins at construction.
4. Route relative requests only to configured origins.
5. Reject absolute requests outside the allowlist before network I/O.
6. Choose routes locally using Thompson sampling with bounded forgetting.
7. Retry retryable failures only on an untried configured origin.
8. Never retry a non-idempotent method without an Idempotency-Key.
9. Emit observations only after explicit telemetry consent.
10. Exclude origins, paths, IP, bodies, credentials, and stable identifiers from observations.

## Acceptance tests

See `sdk-web/test/client.test.ts` and `sdk-web/test/bandit.test.ts` for allowlist enforcement, failover, retry gating, bandit updates, and consent behavior.

## Known gaps

Jittered backoff, deadlines, Ed25519 verification, persistent state, offline queue, remote exporter, and browser performance budgets are not implemented in this milestone. No size or latency claim is made.
