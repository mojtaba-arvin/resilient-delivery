# ADR 0008: Verify tenant isolation at the container boundary

- Status: accepted
- Date: 2026-11-25

## Context

The supported deployment model is one collector process, one DuckDB volume, and one bearer credential per tenant. The Rust startup security test already rejects multiple credentials in one process, but the container integration workflow did not prove the deployed image keeps two independent tenant instances isolated from each other's credentials and persisted observations.

## Decision

Extend the container integration job to start two instances of the built collector image with distinct data directories, credentials, and loopback ports. The drill must prove:

- Each tenant accepts its own credential and commits its own event.
- Tenant A's credential is rejected by tenant B, and vice versa.
- Each process reports only its own committed event count.
- A single collector configured with multiple tenant tokens exits before serving traffic.

Use only disposable directories, containers, and clearly synthetic CI credentials. Always clean them up, including on failure.

## Consequences

The CI suite now tests the actual container entrypoint and process/storage boundary, not only library-level authorization or startup tests. This is regression evidence for the documented single-tenant deployment topology.

It does not prove host-level filesystem isolation, ingress policy, secret-manager controls, independent backup destinations, or production tenant separation on an operator-managed host. Those remain target-deployment release gates in issue #24 and docs/release-readiness.md. This ADR does not enable shared-process multi-tenancy or change the product's delivery semantics.
