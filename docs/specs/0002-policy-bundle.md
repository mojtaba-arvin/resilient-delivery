# Spec 0002: Signed policy bundle

- Status: Implemented in the web SDK; persistent version-store adapter remains application supplied
- Version: 1

## Bundle contract

A policy contains a monotonically increasing `policy_version`, issue/expiry Unix timestamps, and a finite list of HTTPS origins. The signature envelope declares Ed25519, a key identifier, and a base64-encoded signature.

The signature is computed over the RFC 8785 JSON Canonicalization Scheme representation of the policy payload with the `signature` member omitted. The application embeds trusted public keys and maps each key identifier to one key. The verifier must reject unknown keys, invalid signatures, expired bundles, issue times too far in the future, and versions lower than the highest accepted version. Verification must fail closed.

The schema is a data contract only. Until a tested verifier and rollback store exist, the SDK must not treat remote policy as trusted or use it to expand the application's configured origin allowlist.

## Acceptance criteria for implementation

- Valid signatures verify against the configured Ed25519 public key.
- Any payload mutation invalidates the signature.
- Unknown key IDs, malformed base64, invalid signatures, expired bundles, and rollback are rejected.
- A policy can narrow the owner's configured origins but can never expand them.
- Verification is covered by positive, negative, fuzz, and cross-runtime test vectors.


## Current implementation

`sdk-web/src/policy.ts` verifies Ed25519 signatures using Web Crypto, validates expiry and issue time, rejects unknown signing keys and malformed signature bytes, and ensures a policy can only narrow the immutable application origin allowlist. The caller must supply a `PolicyVersionStore` whose `advanceIfNewer` operation is atomic. A persistent implementation (for example, an IndexedDB transaction) is required for rollback protection across page reloads; an in-memory implementation protects only the current runtime. Verification fails closed if crypto or the version store is unavailable.

Tests in `sdk-web/test/policy.test.ts` cover valid signatures, payload tampering, unknown keys, time validity, origin expansion, replay/rollback, malformed signature bytes, duplicate origins, and invalid attempt limits.
