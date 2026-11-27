# Agent Instructions

These instructions apply to automated agents and contributors working in this repository. Read the relevant architecture, security, and contribution documents before changing behavior. Work only on a clearly scoped GitHub Issue and preserve existing repository policies.

## GitHub Issue title convention

Every Issue title must use `<type>(<scope>): <short, clear description>`. Use one lowercase Conventional Commit type: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, or `revert`. Scope must be concise lowercase kebab-case and identify the affected domain/component. Keep priority, milestone, feature/command IDs, phase, agent identity, dates, and run metadata in labels, milestones, or the Issue body—not the title. Do not use bracketed prefixes, standalone priority codes, `Recover:`, or agent/supervisor identity prefixes. Use `chore(roadmap): ...` for milestone bookkeeping and `chore(supervisor): ...` for run ledgers. Preserve all Issue metadata and relationships when renaming; change only the title. See the [shared canonical contract](https://github.com/mojtaba-arvin/commands/blob/main/_shared/issue-title-contract.md).
