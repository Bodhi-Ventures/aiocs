# Canaries, Diffs, Freshness, Backup, Auth, and Release Automation

Created: 2026-03-28

## Objective

Extend `aiocs` so it is operationally resilient and release-complete for long-lived AI-agent use. The scope covers six connected capabilities: lightweight source drift canaries, first-class snapshot diffing, freshness-aware health reporting, export/import backup flows for `~/.aiocs`, authenticated source fetches using environment-backed secrets, and GitHub/npm release automation.

## Current State

- `aiocs` already has a stable local CLI, MCP server, Docker daemon, immutable snapshots, shared service layer, source bootstrap, and clipboard-first fetch flows.
- Search, coverage verification, JSON output, and MCP batch operations are implemented and tested.
- The fetch runtime assumes public sources and has no secret resolution or authenticated browser context configuration.
- Drift from upstream docs sites is only detected indirectly during a full fetch; there is no canary path that exercises extraction before a full refresh.
- Snapshots are immutable and enumerable, but there is no first-class diff surface for agents to ask what changed between snapshots.
- `doctor` validates setup readiness, but it does not yet reason about source freshness or daemon recency.
- Backups are implicit file copies of `~/.aiocs`; there is no product-level export/import contract.
- CI validates code and packaging, but there is no automated publish/tag/release workflow.

## Constraints

- Keep one canonical implementation path: shared service logic must back both CLI and MCP.
- Preserve the current source snapshot model and avoid breaking the existing CLI/MCP contracts; additive evolution only.
- Keep secrets out of source YAMLs, snapshots, logs, and catalog tables. Source specs may reference environment variables only.
- Continue to default to local-only operation with data rooted at `~/.aiocs`.
- Use first-class runtime state rather than ad hoc shell scripts where the feature is part of the product surface.
- Prefer exact, machine-readable outputs for agent-facing features.

## Non-Goals

- No hosted remote registry or multi-user server mode.
- No UI/dashboard beyond the existing CLI, MCP, and daemon surfaces.
- No vector search or embedding-based retrieval in this workstream.
- No credential storage backend beyond environment-variable resolution.
- No deep semantic diffing beyond page/chunk/text-level snapshot comparisons.

## Acceptance Checks

- Source specs support optional authenticated fetch configuration via `valueFromEnv` references for headers and cookies, and authenticated fetches are covered by tests.
- `docs canary <source|all>` and matching MCP tooling run lightweight extraction checks against configured canary URLs without creating snapshots, and canary runs are persisted with pass/fail evidence.
- The daemon can run canary checks on demand or as part of freshness health evidence without duplicating fetch logic.
- `docs diff <source> [--from <snapshot>] [--to <snapshot>]` or `docs changes` exposes added/removed/changed pages and useful summary counts; the same capability is available through MCP.
- `docs doctor` reports freshness: stale sources, last successful refresh age, last canary age/status where available, and whether the daemon heartbeat is recent enough.
- `docs backup export` and `docs backup import` provide a first-class manifest-based backup and restore path for the local catalog and snapshot files.
- Backup/import flows avoid silently corrupting an existing catalog; validation is explicit and fails fast on invalid manifests or incompatible payloads.
- Release automation exists in GitHub Actions for version bump/tag/release/npm publish workflows and aligns with current package metadata.
- README, JSON contract docs, and the repo skill describe the new CLI/MCP surfaces and operational guidance.
- All new capabilities are covered by automated tests and shared service-layer logic, not duplicated command-specific implementations.

## Evidence To Collect

- Unit/integration tests for:
  - authenticated source resolution and secret handling
  - canary execution and persisted canary-run results
  - snapshot diff summaries
  - freshness-aware doctor output
  - backup export/import validation
  - release workflow/config validation where practical
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `npm pack --dry-run`
- CLI smoke evidence for `doctor`, `canary`, `diff`, and `backup` commands
- MCP smoke coverage for the new machine-facing tools
- Workflow validation evidence for the new release automation YAML

## Review Gates

- Mandatory `reviewer`
- Conditional `refactor_auditor` via classifier
- Conditional `verifier` via classifier with `test`, `build`, `command`, `automation`, `artifacts`, and `explicit_request` signals

## Open Risks

- Source-spec evolution could sprawl if canary/auth configuration is not kept tightly modeled.
- Persisting canary history and daemon heartbeat needs careful schema changes so migrations remain straightforward.
- Backup/import can become dangerous if restore semantics are ambiguous for an already-populated catalog.
- Release automation can fail closed if npm/GitHub token expectations are not documented and guarded properly.
- Some docs providers may behave differently under authenticated browser contexts than under anonymous browsing, which can expose brittle assumptions in the current fetch flow.

## Next Handoff Step

Implement the schema/runtime changes first: extend source specs for `auth` and `canary`, add catalog persistence for canary runs and daemon heartbeat, and build the shared diff/backup primitives before wiring the new CLI/MCP surfaces.
