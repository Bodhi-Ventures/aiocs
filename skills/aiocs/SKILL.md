# aiocs

Use this skill when you need local documentation search, inspection, refresh, or bootstrap through the shared `aiocs` catalog under `~/.aiocs`.

## When to use it

- You need authoritative local docs for an exchange, SDK, or product without browsing the live site every time.
- You want machine-readable search/show results for an AI agent.
- You need to detect source drift or compare snapshot changes over time.
- You need to bootstrap or validate `aiocs` on a new machine.
- You want to keep the local docs catalog warm through the `aiocs` daemon or MCP server.
- You need to back up or restore the shared catalog.

## Preferred interfaces

1. Prefer `aiocs-mcp` when an MCP client can use it directly.
2. Otherwise use the CLI with the root `--json` flag.
3. Avoid parsing human-formatted CLI output unless there is no alternative.

## First-run workflow

Validate the local runtime:

```bash
docs --json doctor
```

Bootstrap the bundled built-in sources:

```bash
docs --json init --no-fetch
```

If the machine should be fully warm immediately, fetch during bootstrap:

```bash
docs --json init --fetch
```

## Core commands

Search the shared catalog:

```bash
docs --json search "maker flow" --source hyperliquid
docs --json search "maker flow" --all
docs --json search "maker flow" --source hyperliquid --limit 5 --offset 0
```

Inspect a specific chunk:

```bash
docs --json show 42
```

Refresh the catalog:

```bash
docs --json refresh due
docs --json fetch hyperliquid
docs --json fetch all
docs --json canary hyperliquid
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
- `backup_export`
- `backup_import`
- `search`
- `show`
- `verify_coverage`
- `batch`

## Operational notes

- The catalog is local-only and shared across projects on the same machine.
- Default state root: `~/.aiocs/data` and `~/.aiocs/config`.
- Use `docs daemon` or the Docker daemon service when the catalog should stay fresh automatically.
- Canaries are the first place to look when a docs site changed and fetches started degrading.
- CLI failures expose machine-readable `error.code` fields in `--json` mode.
- MCP tool results use `{ ok, data?, error? }` envelopes, and `batch` can reduce multiple small MCP round trips.
- For exact CLI payloads, see `/Users/jmucha/repos/mandex/aiocs/docs/json-contract.md`.
