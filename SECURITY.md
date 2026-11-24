# Security Policy

This project is pre-1.0; security fixes target the default branch.

Do not publish exploitable vulnerabilities in public issues. Use GitHub private vulnerability reporting and include reproduction steps, affected versions, impact, and mitigation if known.

Security invariants:
- Enforce the origin allowlist before every network attempt.
- Policy verification must fail closed for malformed, unsigned, expired, or rolled-back bundles.
- Policy version stores must atomically advance versions; in-memory stores do not prevent rollback across reloads.
- Non-idempotent retries require a server-enforced idempotency key.
- Telemetry must exclude IP addresses, stable user/device identifiers, credentials, bodies, and full URLs.
- Collector ingestion must bound compressed and decompressed payload sizes.
