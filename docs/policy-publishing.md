# Signed policy publishing

The SDK verifies Ed25519 policy bundles but does not fetch them. This repository includes a dependency-free Node.js publisher that creates immutable, signed policy artifacts for static hosting/CDN distribution.

## Prepare an unsigned policy

```json
{
  "schema_version": 1,
  "policy_version": 2,
  "issued_at": 1795382400,
  "expires_at": 1797974400,
  "origins": ["https://api.example.com", "https://api-backup.example.com"],
  "max_attempts": 2
}
```

The publisher validates the schema's security-relevant constraints, signs canonical JSON with Ed25519, and writes:
- `v1/<policy_version>.json`: immutable versioned bundle.
- `latest.json`: atomically replaced pointer-by-content to the newest bundle.

The output directory is suitable for static hosting. The SDK/application remains responsible for fetching over HTTPS, verifying the signature with a pinned public-key ring, checking expiry and monotonic version, and applying only a narrowed origin allowlist.

## Publish

Keep the private key in a secret manager or protected CI secret. Never commit it or put it in browser code.

```sh
export POLICY_SIGNING_PRIVATE_KEY="$(cat /secure/path/policy-ed25519-private.pem)"
export POLICY_SIGNING_KEY_ID="policy-2026-01"
node scripts/policy-publisher.mjs policy.json ./public/policies
```

The publisher uses an exclusive lock to serialize publishers, rejects non-increasing versions, creates immutable version files without overwriting existing versions, and fsyncs files/directories around publication. If a publisher is killed while holding the lock, inspect the output directory before removing the stale `.publish.lock`; do not blindly delete it while another publisher is active.

## Key rotation

Add the new public key to the application's trusted key ring before publishing a bundle signed with its key ID. Keep the old public key available until all bundles signed by it have expired. Key revocation and remote key discovery are deliberately not automatic.

This is a static artifact publisher, not a hosted control plane: authentication, CDN access control, cache invalidation, and rollout monitoring are deployment responsibilities.
