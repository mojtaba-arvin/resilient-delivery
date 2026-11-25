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

After all source-level gates pass, increment both package versions, update CHANGELOG, and create and push `vX.Y.Z`. The workflow validates the tagged source and creates a **draft GitHub Release**; it does not publish publicly. Before publishing the draft, the release owner must complete `docs/release-readiness.md`, attach target-environment evidence, and record an **approved** decision. The workflow intentionally does not auto-increment versions or create tags.

## Stable-release block

Do not publish Stable while tenant data isolation, production TLS ingress, backup/restore drills, or sustained production benchmarks remain unverified. The release workflow is a source-validation gate only. It creates a draft to prevent a tag push from silently becoming a public stable release; an operator must still complete and approve the target-environment evidence record before manually publishing the draft.

## Automated validation

Pull requests run the release-manifest syntax and unit checks. Tag publication remains a separate, gated workflow; a green PR check does not imply that production deployment gates have been completed.
