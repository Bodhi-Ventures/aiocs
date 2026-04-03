# git repo sources for shared external code references

Created: 2026-04-03

## Objective

Add first-class `git` repository sources to `aiocs` so external codebases can be mirrored, snapshotted by commit, indexed, linked to multiple local projects, and searched through the same CLI/MCP surfaces as docs sources.

## Current State

- `aiocs` already supports website-backed sources with snapshots, canaries, diffs, project links, backup/import, SQLite lexical search, and optional hybrid retrieval.
- The existing source model assumes browser fetch plus markdown normalization.
- There is no first-class acquisition model for external repos, commit-based snapshots, file-aware metadata, or path/language search filters.
- The first real validation target is `https://github.com/nktkas/hyperliquid`, which should become a bundled repo source alongside the existing bundled Hyperliquid docs source.

## Constraints

- Keep `aiocs` as the canonical acquisition/snapshot/search system; do not introduce a second registry or parallel repo-index service.
- Use direct integrations in the primary codepath; no sidecar wrappers around git behavior.
- Preserve current docs-source behavior and compatibility for existing `web` sources.
- Keep lexical SQLite search primary and hybrid search optional on top.
- Store all state locally under `~/.aiocs`.
- Support the current agent-facing CLI/MCP surfaces instead of inventing new one-off entrypoints.

## Non-Goals

- No manifest/dependency auto-sync from consuming projects.
- No replacement of SocratiCode for deep code-intelligence features.
- No SSH auth in the first implementation.
- No indexing of binary assets, vendored trees, or generated outputs.
- No sharing of git mirrors between `aiocs` and SocratiCode.

## Acceptance Checks

- `source upsert` accepts `kind: git` specs and validates the new repo fields.
- `refresh due <source-id>` and `fetch <source-id>` work for `git` sources.
- Snapshot identity and reuse are commit-based.
- `snapshot list` and `diff` work against git-backed snapshots.
- `search` supports repo-aware `path` and `language` filters through CLI and MCP.
- `project link` works unchanged for repo sources.
- A bundled source spec for `nktkas/hyperliquid` exists and can be bootstrapped via `docs init`.
- End-to-end validation proves that at least two local projects can link the same bundled repo source and query it successfully.

## Evidence To Collect

- successful `source upsert`, `refresh due`, `snapshot list`, `diff`, and `search` outputs for `nktkas-hyperliquid`
- proof that unchanged commit + unchanged config reuses the latest snapshot
- proof that a changed commit produces a new snapshot
- CLI and MCP examples showing `path` and `language` filters
- backup export/import evidence showing repo sources restore without depending on git mirror cache copies
- test coverage for spec validation, mirror fetch/reuse, chunking, search filters, and project linking

## Review Gates

- `reviewer` on the implementation diff
- `refactor_auditor` if diff classification requests it
- `verifier` with integration/runtime signals because completion depends on real repo fetch/index/search behavior

## Open Risks

- code-aware chunking may underperform if the first implementation relies too heavily on fallback line windows
- large repos may create embedding backlog or slow refreshes without good include/exclude defaults
- auth handling for private repos can sprawl if the schema is not constrained tightly at the start
- backup/import semantics need to clearly distinguish canonical snapshot state from rebuildable git mirror cache state

## Execution Phases

1. Extend source-spec schema and validation for `kind: git`, repo settings, filters, and token-based auth.
2. Add local git mirror lifecycle and commit-based snapshot resolution.
3. Add repo file materialization plus code-aware chunking and metadata mapping into the existing catalog model.
4. Extend CLI/MCP search inputs and service layer for `path` and `language` filters.
5. Add bundled `sources/nktkas-hyperliquid.yaml` and use it as the first full end-to-end validation target.
6. Add tests and runtime evidence for fetch, diff, project-link, backup/import, and hybrid search over the repo source.

## Next Handoff Step

Implement the `git` source kind in `aiocs` using the design in `docs/superpowers/specs/2026-04-03-git-repo-sources-design.md`, then validate it end to end with the bundled `nktkas/hyperliquid` source.
