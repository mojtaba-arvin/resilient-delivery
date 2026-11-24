# Security Policy

## Supported security posture

Resilient Delivery minimizes telemetry and accepts only application-owner-configured origins. It is not a VPN, proxy-discovery, traffic-obfuscation, or censorship-circumvention product.

## Security invariants

- The Web SDK validates every destination against the application-owner-configured origin allowlist and rejects redirects.
- Signed policy verification fails closed for malformed, unsigned, expired, or rolled-back policy versions; persistent version advancement is atomic.
- Non-idempotent requests are not replayed. Retries require a server-enforced `Idempotency-Key`, and streaming request bodies are not replayed.
- Telemetry is limited to minimized delivery observations. Do not include IP addresses, stable user/device identifiers, credentials, request or response bodies, or full URLs.
- The collector accepts bounded JSON batches (64 KiB request body and at most 100 events). Compressed request bodies are not supported; if compression is introduced, enforce both compressed and decompressed size limits.
- Bearer credentials are never persisted or logged in raw form; the collector stores a digest for scoping receipts and quotas.

## Reporting

Do not publish exploitable vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository. Include affected commit/tag, reproduction steps, impact, and a proposed mitigation where possible.

## Deployment requirements

- Use TLS at a trusted ingress.
- Keep collector and Toxiproxy administrative ports private.
- Provide bearer credentials through a secret manager.
- Restrict and encrypt storage and backups.
- Do not treat multiple bearer tokens as tenant data isolation; see [the threat model](docs/security-threat-model.md).

## Verification

Run `node scripts/security-check.mjs` and the Rust test suite before release. Static checks are regression guards, not a substitute for a penetration test or runtime configuration review.
