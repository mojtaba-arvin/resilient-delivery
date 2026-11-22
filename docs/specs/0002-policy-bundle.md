# Spec 0002: Signed policy bundle

- Status: Implemented in the web SDK, including a persistent IndexedDB version store
- Version: 1

## Bundle contract

A policy contains a monotonically increasing `policy_version`, issue/expiry Unix timestamps, and a finite list of HTTPS origins. The signature envelope declares Ed25519, a key identifier, and a base64-encoded signature.

The signature is computed over the RFC 8785 JSON Canonicalization Scheme representation of the policy payload with the `signature` member omitted. The application embeds trusted public keys and maps each key identifier to one key. The verifier must reject unknown keys, invalid signatures, expired bundles, issue times too far in the future, and versions lower than the highest accepted version. Verification must fail closed.

The schema is a data contract only. The verifier must never treat remote policy as trusted before signature verification or use it to expand the application's configured origin allowlist.

## Acceptance criteria

- Valid signatures verify against the configured Ed25519 public key.
- Any payload mutation invalidates the signature.
- Unknown key IDs, malformed base64, invalid signatures, expired bundles, and rollback are rejected.
- A policy can narrow the owner's configured origins but can never expand them.
- The persistent version store advances monotonically under concurrent callers.
- A version advance is acknowledged only after its IndexedDB transaction commits.
- Storage/open/transaction failures fail closed.
- Tests cover signature verification, tampering, version persistence, replay, rollback, and concurrent advances.

## Implementation

`sdk-web/src/policy.ts` verifies Ed25519 signatures using Web Crypto, validates time bounds, rejects unknown keys and malformed signature bytes, and ensures a policy can only narrow the immutable application origin allowlist.

`sdk-web/src/policy-indexeddb.ts` provides `IndexedDBPolicyVersionStore`. It reads and conditionally writes the highest accepted version in one `readwrite` transaction. IndexedDB serializes overlapping readwrite transactions on the same object store. The adapter resolves only from the transaction completion event, not from the individual put request's success event. Database open, blocked, and transaction errors reject; the policy verifier therefore fails closed.

The database name must remain stable between page loads. Browser storage can still be evicted or cleared by the user or browser; the SDK cannot promise rollback protection after such deletion. Applications must not clear or recreate the policy store as part of routine startup.
