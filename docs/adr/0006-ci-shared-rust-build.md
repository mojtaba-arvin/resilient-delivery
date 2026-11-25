# ADR 0006: Reuse the validated collector build in CI

- Status: accepted
- Date: 2026-11-25

## Context

The push workflow previously compiled the bundled DuckDB-backed Rust collector independently in the Rust validation, network fault-lab, and security-hardening jobs. These jobs run on separate GitHub-hosted runners, so a Cargo cache in one job does not eliminate the initial dependency build in the others. The duplicate release build in the network lab is particularly wasteful because it exercises the same source revision and target as the Rust validation job.

## Decision

- Keep one authoritative `rust-collector` job responsible for formatting, Clippy, serialized Rust tests, and the release build.
- Upload the resulting release executable as a short-lived workflow artifact for push runs and focused network/deployment PRs.
- Make `network-resilience-lab` depend on `rust-collector`, download that exact executable, restore its executable bit, and run fault injection against it. Do not compile a second copy in the network job.
- Make `security-hardening` depend on `rust-collector`; retain dependency audit, security regression tests, and backup/restore integration checks there, but do not repeat Rust fmt, Clippy, or cargo test.
- Include the network and security workstreams in the authoritative Rust job's PR selector so their PRs still receive the full Rust gate.
- Bound long-running Rust and integration jobs with explicit job timeouts.

## Consequences

This reduces redundant bundled-DuckDB compilation and prevents the network lab from silently testing a separately built binary. The artifact is scoped to the same workflow run and commit; it is not a release artifact and is retained for one day only. The Rust validation remains the single source of truth for compiler/test status. Network and security suites still execute independently after the Rust gate completes.

No application protocol, storage schema, delivery semantic, or runtime behavior changes. At-least-once delivery remains the default; idempotency remains opt-in and bounded by retention.
