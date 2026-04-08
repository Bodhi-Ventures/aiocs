---
name: aiocs
description: Use when authoritative local documentation lookup should come from the shared aiocs catalog under ~/.aiocs instead of live browsing.
---

# aiocs

Use this skill when you need authoritative local documentation lookup through the shared `aiocs` catalog under `~/.aiocs`.

## When to use it

- The user is asking about exchange or product docs that may already exist in the local `aiocs` catalog.
- You need authoritative local docs for an exchange, SDK, or product without browsing the live site every time.
- You need reusable reference search over a curated external git repository that already lives in `aiocs`.
- You want machine-readable search/show/diff/coverage results for an AI agent.
- You need hybrid docs retrieval with lexical plus semantic/vector recall.
- You need to validate runtime health before relying on the local docs catalog.

## Trigger guidance for Codex

- Prefer `aiocs` before live web browsing when the requested docs may already be in the local catalog.
- Check `source_list` or scoped `search` before assuming a source is missing.
- Use `aiocs` first for the bundled `hyperliquid` source and for any repo or machine that already relies on `~/.aiocs`.
- This skill is the default read/search path. If the task requires source creation, force fetch, targeted refresh, or canary remediation, also load `aiocs-curation`.
- Only fall back to live browsing when:
  - the source is not present in `aiocs`
  - the user explicitly wants the live site
  - the local catalog is stale or broken and the answer cannot wait for curation/remediation
- If you need multiple docs operations in MCP, use `batch` instead of many small round trips.

## Preferred interfaces

1. Prefer `aiocs-mcp` when an MCP client can use it directly.
2. Otherwise use the CLI with the root `--json` flag.
3. Avoid parsing human-formatted CLI output unless there is no alternative.
4. Assume `docs` and `aiocs-mcp` come from the globally installed `@bodhi-ventures/aiocs` package unless the user explicitly asks for a checkout-local development build.
5. Use `npx -y -p @bodhi-ventures/aiocs ...` only as a fallback when the global install is unavailable.

## Search defaults for agents

- Default to `search` with `mode=auto`.
- Use `mode=lexical` for exact identifiers, section titles, endpoint names, and error strings.
- Use `--path` / `pathPatterns` and `--language` / `languages` when searching repo/code sources.
- Use `mode=hybrid` for conceptual questions when embeddings are healthy.
- Use `mode=semantic` only when you explicitly want vector-only recall.
- When citing results, include `sourceId`, `snapshotId`, and `pageUrl` when they materially help traceability.

## First-run workflow

Validate the local runtime:

```bash
aiocs --json doctor
```

Bootstrap managed sources from the repo bundle and `~/.aiocs/sources`:

```bash
aiocs --json init --no-fetch
```

## Core commands

Search the shared catalog:

```bash
aiocs --json search "maker flow" --source hyperliquid
aiocs --json search "maker flow" --all
aiocs --json search "maker flow" --source hyperliquid --limit 5 --offset 0
aiocs --json search "maker flow" --source hyperliquid --mode hybrid
aiocs --json search "WebSocketTransport" --source nktkas-hyperliquid --path "src/**" --language typescript --mode lexical
```

Inspect a specific chunk:

```bash
aiocs --json show 42
```

Inspect source availability and health:

```bash
aiocs --json source list
aiocs --json canary hyperliquid
aiocs --json embeddings status
```

Inspect what changed between snapshots:

```bash
aiocs --json diff hyperliquid
```

Back up or restore the shared catalog:

```bash
aiocs --json backup export /absolute/path/to/backup
aiocs --json backup import /absolute/path/to/backup --replace-existing
```

Verify fetched coverage against reference markdown:

```bash
aiocs --json verify coverage hyperliquid /absolute/path/to/reference.md
```

Scope docs to a project path:

```bash
aiocs --json project link /absolute/path/to/project hyperliquid lighter
aiocs --json project unlink /absolute/path/to/project lighter
```

## MCP tools

The `aiocs-mcp` server exposes the same core operations without shell parsing:

- `version`
- `doctor`
- `init`
- `source_list`
- `canary`
- `snapshot_list`
- `diff_snapshots`
- `project_link`
- `project_unlink`
- `embeddings_status`
- `embeddings_backfill`
- `embeddings_clear`
- `embeddings_run`
- `backup_export`
- `backup_import`
- `search`
- `show`
- `verify_coverage`
- `batch`

Mutation-capable MCP tools such as `source_upsert`, `refresh_due`, and `fetch` belong to `aiocs-curation`.

## Recommended Codex workflow

1. If runtime health is in doubt, run `doctor`.
2. Run `source_list` to see whether the source already exists.
3. Use `search` in `auto` mode first, then `show` for the selected chunk.
4. Use `canary`, `diff_snapshots`, or `verify_coverage` when the question is about drift, changes, or completeness.
5. If the source is missing or stale and the next step is to mutate `aiocs`, load `aiocs-curation`.
6. Use `batch` when combining list/search/show or diff/coverage checks in one pass.

## Operational notes

- The catalog is local-only and shared across projects on the same machine.
- Default state root: `~/.aiocs/data`, `~/.aiocs/config`, and `~/.aiocs/sources`.
- Use `aiocs daemon` or the Docker daemon service when the catalog should stay fresh automatically.
- `aiocs search --mode auto` is the right default for agents; it uses hybrid retrieval only when embeddings are current and healthy for the requested scope.
- The Docker Compose stack includes a dedicated `aiocs-qdrant` container and expects Ollama to be reachable separately.
- Canaries are the first place to look when a docs site changed and fetches started degrading.
- Newly added or changed sources become due immediately, so `refresh due <source-id>` is the safe first refresh path after upsert.
- CLI failures expose machine-readable `error.code` fields in `--json` mode.
- MCP tool results use `{ ok, data?, error? }` envelopes, and `batch` can reduce multiple small MCP round trips.
- For exact CLI payloads, see `docs/json-contract.md`.
- For Codex setup and subagent examples, see `docs/codex-integration.md`.
