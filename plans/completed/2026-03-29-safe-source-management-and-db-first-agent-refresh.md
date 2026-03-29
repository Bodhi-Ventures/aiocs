# Safe source management and DB-first agent refresh

Created: 2026-03-29

## Objective

Make source management agent-safe by default without removing admin flexibility:
- add a first-class user-managed source directory under `~/.aiocs/sources`
- add per-source due-aware refresh so agents can refresh only what they need without forcing global or repeated fetches
- update Codex-facing guidance so agents check the local catalog first, only add missing sources when they are worth curating, and avoid automatic `fetch all`

## Current State

- Bundled sources are managed from the repo and optional external source-spec dirs can be injected through daemon env config.
- Agents can discover sources and freshness through `source_list`, including `nextDueAt`, but the safe refresh path is only global via `refresh_due`.
- Per-source fetch exists, but it always forces a fetch instead of respecting freshness.
- Agent-facing docs and skills still advertise forceful fetch/bootstrap patterns as normal operations.

## Constraints

- Keep the current full admin capabilities available; do not break explicit maintenance flows.
- Preserve the Docker daemon as the primary background freshness mechanism.
- Avoid source-code edits in the `mandex` parent repo; keep work scoped to `aiocs` plus agent-facing docs.
- Maintain a single source of truth for source-spec discovery and freshness policy.

## Non-Goals

- Do not build automatic source generation from arbitrary URLs in this change.
- Do not remove `fetch all` or other admin/ops commands entirely.
- Do not introduce a second persistence layer for source management outside the existing `aiocs` paths and catalog.

## Acceptance Checks

- `~/.aiocs/sources` is created/discoverable as a default managed source-spec directory.
- `source_list` plus agent docs make it obvious how to detect whether a source exists and whether it is due.
- CLI and MCP support a per-source due-aware refresh path that skips non-due sources instead of forcing a fetch.
- Existing global `refresh_due` behavior remains available.
- Agent-facing docs/skills/subagent guidance say: check DB first, add missing reusable sources, avoid blind refetch, avoid automatic `fetch all`.
- Tests cover paths, daemon/source-dir defaults, CLI/MCP refresh behavior, and release/docs asset expectations.

## Evidence To Collect

- `pnpm lint`
- targeted and/or full `pnpm test`
- `pnpm build`
- concrete command evidence for new due-aware refresh and user source-dir defaults

## Review Gates

- `reviewer`
- `verifier`

## Open Risks

- Guidance changes can drift from actual command behavior if the implementation only updates docs.
- Adding a new default managed source dir can affect doctor/daemon expectations and tests.
- Naming/API shape for due-aware refresh must be clear enough that agents choose it instead of force fetch.

## Next Handoff Step

Implement runtime/source-dir support, add per-source due-aware refresh in services/CLI/MCP, update agent-facing docs, then verify and run finish-with-review.
