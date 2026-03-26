# Release hardening for aiocs agents

Created: 2026-03-26

## Objective

Make `aiocs` release-ready for AI agents as a publishable npm CLI plus MCP server. The release-hardening scope includes: a first-class version surface, a publishable package model with license metadata, a doctor/health command, one-command bootstrap for built-in sources, a dedicated JSON contract document, a repo skill for agents, and a first-class MCP server that exposes the local docs store without shell parsing.

## Current State

- `aiocs` already ships a working local CLI, Docker daemon, shared catalog, built-in source specs, and clipboard-first fetch flows.
- The package is still `"private": true`, has no `LICENSE`, no repository metadata, and no explicit publishability story.
- The CLI has no `doctor`/`health` command and no one-command machine bootstrap path.
- There is no dedicated JSON contract document for agents beyond examples in `README.md`.
- There is no MCP server and no repo-local skill teaching agents how to use `aiocs`.

## Constraints

- Keep the existing CLI contract stable; add capabilities without breaking the current commands.
- Reuse the same canonical business logic across CLI and MCP; do not fork behavior into parallel implementations.
- Preserve `~/.aiocs` as the default local state root unless explicitly overridden.
- Prefer exact, machine-readable outputs for agent-facing interfaces.
- Ship production-grade packaging and documentation; avoid “internal-only for now” placeholders.

## Non-Goals

- No hosted service or remote registry.
- No authentication or multi-user access control.
- No daemon scheduling beyond the existing local/Docker model.
- No broad source-spec schema redesign beyond what is needed for doctor/bootstrap/MCP integration.

## Acceptance Checks

- `docs --version` returns the package version in both dev and built runtimes.
- Package metadata supports publication: not private, includes license/repository/files/bin metadata, and produces a valid packed artifact.
- `docs doctor` (or `docs health`) validates catalog access, Playwright/browser readiness, daemon config, source-spec directory state, and Docker readiness with machine-readable output.
- `docs init` (or equivalent canonical bootstrap command) registers built-in sources and supports machine-readable output; if fetching is part of init, that path is tested.
- A dedicated JSON contract doc exists and matches the implemented CLI/MCP behavior.
- A repo-local `SKILL.md` exists for agents and documents the canonical `aiocs` usage path.
- An MCP server binary exists, starts successfully, and exposes a minimal useful toolset over stdio using the official TypeScript SDK.
- CLI and MCP use the same underlying operations for listing/searching/showing/bootstrapping rather than duplicating business rules.

## Evidence To Collect

- Targeted failing and passing tests for version, doctor, bootstrap, and MCP behavior.
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `npm pack --dry-run`
- `./dist/cli.js --version`
- `./dist/cli.js --json doctor`
- `./dist/cli.js --json init --no-fetch` (or canonical bootstrap equivalent)
- MCP smoke evidence, ideally with a client integration test and/or a real stdio startup check.

## Review Gates

- Mandatory `reviewer`
- Conditional `refactor_auditor` via classifier
- Conditional `verifier` via classifier with `test`, `build`, `command`, `automation`, and `explicit_request` signals

## Open Risks

- MCP SDK integration may force a small architectural refactor if the current CLI logic is too embedded in `src/cli.ts`.
- Doctor checks that shell out to Docker can become flaky if treated as hard failures instead of warnings.
- Bootstrap semantics must be chosen carefully so “ready for agents” does not imply an unexpectedly heavy first-run fetch unless that is explicitly desired.

## Next Handoff Step

Write failing tests for the new CLI surfaces and design the shared service layer that both the CLI and the MCP server will call.
