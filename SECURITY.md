# Security Policy

## Supported security posture

Resilient Delivery minimizes telemetry and accepts only application-owner-configured origins. It is not a VPN, proxy-discovery, traffic-obfuscation, or censorship-circumvention product.

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
