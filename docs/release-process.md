# Release Process

## Versioning

The root package and Rust collector versions must match. Releases use annotated tags named `vMAJOR.MINOR.PATCH`. The release manifest records the tag, commit, and component versions.

## Pre-release checklist

1. All workstream PRs are reviewed and integrated.
2. Web SDK typecheck, unit tests, and build pass.
3. Rust format, Clippy, unit/integration tests, and release build pass.
4. Network-fault recovery scenarios pass in a disposable environment.
5. Security regression checks pass.
6. TLS ingress, secrets, storage permissions, and backup/restore are verified in the target environment.
7. OTLP gateway interoperability is tested with a real OTLP exporter.
8. Release notes and migration guidance are reviewed.

## Publish

After all gates pass, increment both package versions, update CHANGELOG, create and push `vX.Y.Z`, then inspect the Release workflow and published artifacts. The workflow intentionally does not auto-increment versions or create tags.

## Stable-release block

Do not publish Stable while tenant data isolation, production TLS ingress, backup/restore drills, or sustained production benchmarks remain unverified. The release workflow is a gate, not proof that an operator's production environment is configured safely.

## Automated validation

Pull requests run the release-manifest syntax and unit checks. Tag publication remains a separate, gated workflow; a green PR check does not imply that production deployment gates have been completed.
