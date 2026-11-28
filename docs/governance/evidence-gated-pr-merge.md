# Evidence-gated PR review and merge

The implementer may self-review and merge a PR when the code-integration evidence is complete. Self-review must not be represented as independent peer review, and a PR author must not simulate a GitHub approval.

## Required exact-head evidence

- Intended base and merge-base freshness are recorded.
- The complete diff is reviewed, including SDK behavior, collector durability, privacy, cryptography, workflow permissions, dependencies, and deployment implications as applicable.
- Relevant unit, integration, fault-injection, and security regression tests pass.
- Every required GitHub status check passes on the exact head SHA.
- Material review threads are resolved or explicitly documented as accepted limitations.
- The PR is mergeable under the repository's actual GitHub rules.

The implementer may author the review record. Specialist review is risk-based supporting evidence, not a universal approval gate.

## Merge boundary

Merge only when GitHub permits it. Never bypass branch protection, rulesets, required checks, required reviews, or merge queues. If a GitHub ruleset still requires an independent approval solely due to reviewer identity, an authorized owner must change that administrative setting; do not fabricate an approval.

## External operational acceptance remains separate

A merged PR does not establish production readiness. Preserve target-environment evidence for TLS/DNS, external authenticated ingestion, process/volume/credential isolation, independent encrypted backup and clean restore, target-hardware load/overload benchmarks, runtime security/on-call review, and rollback rehearsal. Keep early-development status and stable-release restrictions until those real gates are satisfied. Do not incur spend, deploy production, or publish a stable release without the relevant authorization.
