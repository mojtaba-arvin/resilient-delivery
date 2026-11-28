# Agent Instructions

These instructions apply to automated agents and contributors working in this repository. Work only on a clearly scoped GitHub Issue and preserve existing repository policies.

## Repository policy guardrails

Before changing behavior or operational configuration, read [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md), and the relevant [architecture documentation](docs/architecture.md). Follow the release gates in [docs/release-readiness.md](docs/release-readiness.md) before making production-readiness or release claims.

Preserve the repository's existing engineering, security, branch-protection, review, CI, and release policies. Do not weaken or bypass checks or protections to make a change mergeable. Architecture and compatibility changes require an ADR in `docs/adr/`; contributions should use DCO sign-off (`git commit -s`). Never expose secrets or sensitive telemetry.

## GitHub Issue title convention

Every Issue title must use `<type>(<scope>): <short, clear description>`. Use one lowercase Conventional Commit type: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, or `revert`. Scope must be concise lowercase kebab-case and identify the affected domain/component. Keep priority, milestone, task/feature/command identifiers, phase, agent identity, dates, and run metadata in labels, milestones, or the Issue body—not the title. Do not use bracketed prefixes, standalone priority codes, `Recover:`, or agent/supervisor identity prefixes. Use `chore(roadmap): ...` for milestone bookkeeping and `chore(supervisor): ...` for run ledgers. Preserve all Issue metadata and relationships when renaming; change only the title. See the [shared canonical contract](https://github.com/mojtaba-arvin/commands/blob/main/_shared/issue-title-contract.md).
