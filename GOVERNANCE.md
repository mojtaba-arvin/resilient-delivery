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
