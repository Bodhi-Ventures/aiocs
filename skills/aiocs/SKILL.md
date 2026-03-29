# aiocs

Use this skill when you need authoritative local documentation search, inspection, safe refresh, or bootstrap through the shared `aiocs` catalog under `~/.aiocs`.

## When to use it

- The user is asking about exchange or product docs that may already exist in the local `aiocs` catalog.
- You need authoritative local docs for an exchange, SDK, or product without browsing the live site every time.
- You want machine-readable search/show results for an AI agent.
- You need to detect source drift or compare snapshot changes over time.
- You want hybrid docs retrieval with lexical plus semantic/vector recall.
- You need to bootstrap or validate `aiocs` on a new machine.
- You want to keep the local docs catalog warm through the `aiocs` daemon or MCP server.
- You need to back up or restore the shared catalog.

## Trigger guidance for Codex

- Prefer `aiocs` before live web browsing when the requested docs may already be in the local catalog.
- Check `source_list` or scoped `search` before assuming a source is missing.
- Use `aiocs` first for the bundled `hyperliquid` source and for any repo or machine that already relies on `~/.aiocs`.
- If a source is missing, only add it when it is worth curating for future reuse.
- Prefer `refresh due <source-id>` over force `fetch <source-id>` whenever freshness is the real goal.
- Do not use `fetch all` as a normal answering path; reserve it for explicit user requests or maintenance flows.
- Only fall back to live browsing when:
  - the source is not present in `aiocs`
  - the user explicitly wants the live site
  - the local catalog is stale or broken and the answer cannot wait for refresh/canary remediation
- If you need multiple docs operations in MCP, use `batch` instead of many small round trips.

## Preferred interfaces

1. Prefer `aiocs-mcp` when an MCP client can use it directly.
2. Otherwise use the CLI with the root `--json` flag.
3. Avoid parsing human-formatted CLI output unless there is no alternative.
4. Assume `docs` and `aiocs-mcp` come from the globally installed `@bodhi-ventures/aiocs` package unless the user explicitly asks for a checkout-local development build.

## Search defaults for agents

- Default to `search` with `mode=auto`.
- Use `mode=lexical` for exact identifiers, section titles, endpoint names, and error strings.
- Use `mode=hybrid` for conceptual questions when embeddings are healthy.
- Use `mode=semantic` only when you explicitly want vector-only recall.
- When citing results, include `sourceId`, `snapshotId`, and `pageUrl` when they materially help traceability.

## First-run workflow

Validate the local runtime:

```bash
docs --json doctor
```

Bootstrap managed sources from the repo bundle and `~/.aiocs/sources`:

```bash
docs --json init --no-fetch
```

User-managed source specs live under:

```bash
~/.aiocs/sources
```

## Core commands

Search the shared catalog:

```bash
docs --json search "maker flow" --source hyperliquid
docs --json search "maker flow" --all
docs --json search "maker flow" --source hyperliquid --limit 5 --offset 0
docs --json search "maker flow" --source hyperliquid --mode hybrid
```

Inspect a specific chunk:

```bash
docs --json show 42
```

Refresh the catalog:

```bash
docs --json source list
docs --json refresh due hyperliquid
docs --json canary hyperliquid
docs --json embeddings status
docs --json embeddings backfill all
docs --json embeddings run
```

Force fetch is still available for explicit maintenance:

```bash
docs --json fetch hyperliquid
docs --json fetch all
```

Inspect what changed between snapshots:

```bash
docs --json diff hyperliquid
```

Back up or restore the shared catalog:

```bash
docs --json backup export /absolute/path/to/backup
docs --json backup import /absolute/path/to/backup --replace-existing
```

Verify fetched coverage against reference markdown:

```bash
docs --json verify coverage hyperliquid /absolute/path/to/reference.md
```

Scope docs to a project path:

```bash
docs --json project link /absolute/path/to/project hyperliquid lighter
docs --json project unlink /absolute/path/to/project lighter
```

## MCP tools

The `aiocs-mcp` server exposes the same core operations without shell parsing:

- `version`
- `doctor`
- `init`
- `source_upsert`
- `source_list`
- `canary`
- `fetch`
- `refresh_due`
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

## Recommended Codex workflow

1. If runtime health or freshness is in doubt, run `doctor`.
2. Run `source_list` to see whether the source already exists and whether it is due.
3. If the source exists and is due, prefer `refresh due <source-id>` over force fetch.
4. If the source is missing but likely to be reused, add a spec under `~/.aiocs/sources`, upsert it, then refresh only that source.
5. Use `search` in `auto` mode first, then `show` for the selected chunk.
6. Use `canary`, `diff_snapshots`, or `verify_coverage` when the question is about drift, changes, or completeness.
7. Use `batch` when combining list/search/show or diff/coverage checks in one pass.

## Operational notes

- The catalog is local-only and shared across projects on the same machine.
- Default state root: `~/.aiocs/data`, `~/.aiocs/config`, and `~/.aiocs/sources`.
- Use `docs daemon` or the Docker daemon service when the catalog should stay fresh automatically.
- `docs search --mode auto` is the right default for agents; it uses hybrid retrieval only when embeddings are current and healthy for the requested scope.
- The Docker Compose stack includes a dedicated `aiocs-qdrant` container and expects Ollama to be reachable separately.
- Canaries are the first place to look when a docs site changed and fetches started degrading.
- Newly added or changed sources become due immediately, so `refresh due <source-id>` is the safe first refresh path after upsert.
- CLI failures expose machine-readable `error.code` fields in `--json` mode.
- MCP tool results use `{ ok, data?, error? }` envelopes, and `batch` can reduce multiple small MCP round trips.
- For exact CLI payloads, see `docs/json-contract.md`.
- For Codex setup and subagent examples, see `docs/codex-integration.md`.
