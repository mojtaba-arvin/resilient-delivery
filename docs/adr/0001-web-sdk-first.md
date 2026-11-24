# ADR 0001: TypeScript-first browser SDK

- Status: Accepted
- Date: 2026-11-22

## Context

The browser SDK is the first integration and has the tightest bundle and main-thread constraints. A shared Rust/WASM core would add toolchain and interoperability costs before the decision contract stabilizes.

## Decision

Start with dependency-free TypeScript and the Fetch API. Keep policy and telemetry schemas language-neutral. Revisit Rust/WASM after browser behavior and cross-platform contracts have compatibility tests.

## Consequences

The browser integration is direct and has no runtime dependency graph. Native SDKs initially implement the same policy contract independently. Performance claims require benchmarks before publication.
