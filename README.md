# aiocs

Local-only documentation fetch, versioning, and search CLI for AI agents.

## What it does

- fetches docs from websites with Playwright
- normalizes them into Markdown
- stores immutable local snapshots in a shared catalog
- indexes heading-aware chunks in SQLite FTS5
- links docs sources to local projects for scoped search

All state is local. By default, data lives under `~/.aiocs`:

- data: `~/.aiocs/data`
- config: `~/.aiocs/config`

For testing or local overrides, set:

- `AIOCS_DATA_DIR`
- `AIOCS_CONFIG_DIR`

## Install

```bash
npm install --global aiocs
docs --version
```

For repository development:

```bash
pnpm install
pnpm build
```

Run the CLI during development with:

```bash
pnpm dev -- --help
```

Or after build:

```bash
./dist/cli.js --help
```

For AI agents, prefer the root-level `--json` flag for one-shot commands:

```bash
docs --json version
docs --json doctor
docs --json init --no-fetch
pnpm dev -- --json source list
pnpm dev -- --json search "maker flow" --source hyperliquid
pnpm dev -- --json show 42
```

`--json` emits exactly one JSON document to stdout with this envelope:

```json
{
  "ok": true,
  "command": "search",
  "data": {
    "results": []
  }
}
```

Failures still exit with status `1`, but emit a JSON error document instead of human text:

```json
{
  "ok": false,
  "command": "show",
  "error": {
    "message": "Chunk 42 not found"
  }
}
```

The full stable JSON contract lives in [docs/json-contract.md](./docs/json-contract.md).

## Built-in sources

Initial source specs are shipped in `sources/`:

- `synthetix`
- `hyperliquid`
- `lighter`
- `nado`
- `ethereal`

Bootstrap them in one command:

```bash
docs init --no-fetch
docs init --fetch
docs --json init --no-fetch
```

Validate the machine before bootstrapping:

```bash
docs doctor
docs --json doctor
```

## Workflow

Register a source:

```bash
pnpm dev -- source upsert /path/to/source.yaml
pnpm dev -- source list
```

Fetch and snapshot docs:

```bash
pnpm dev -- fetch hyperliquid
pnpm dev -- snapshot list hyperliquid
pnpm dev -- refresh due
```

Link docs to a local project:

```bash
pnpm dev -- project link /absolute/path/to/project hyperliquid lighter
pnpm dev -- project unlink /absolute/path/to/project lighter
```

Search and inspect results:

```bash
pnpm dev -- search "maker flow" --source hyperliquid
pnpm dev -- search "maker flow" --all
pnpm dev -- show 42
```

When `docs search` runs inside a linked project, it automatically scopes to that project's linked sources unless `--source` or `--all` is provided.

## JSON command reference

All one-shot commands support `--json`:

- `version`
- `init`
- `doctor`
- `source upsert`
- `source list`
- `fetch`
- `refresh due`
- `snapshot list`
- `project link`
- `project unlink`
- `search`
- `show`

Representative examples:

```bash
pnpm dev -- --json doctor
pnpm dev -- --json init --no-fetch
pnpm dev -- --json source upsert sources/hyperliquid.yaml
pnpm dev -- --json fetch hyperliquid
pnpm dev -- --json refresh due
pnpm dev -- --json project link /absolute/path/to/project hyperliquid lighter
pnpm dev -- --json snapshot list hyperliquid
```

For multi-result commands like `fetch`, `refresh due`, and `search`, `data` contains arrays rather than line-by-line output:

```json
{
  "ok": true,
  "command": "refresh.due",
  "data": {
    "results": []
  }
}
```

## Daemon

`aiocs` ships a first-class long-running refresh process:

```bash
pnpm dev -- daemon
./dist/cli.js daemon
```

The daemon bootstraps source specs from the configured directories, refreshes due sources, sleeps for the configured interval, and repeats.
Configured source spec directories are treated as the daemon’s source of truth:

- if a managed source spec changes, the source is made due immediately in the same daemon cycle
- if a managed source spec is removed from disk, the source is removed from the catalog on the next bootstrap
- if `AIOCS_SOURCE_SPEC_DIRS` is explicitly set but resolves to missing or empty directories, the daemon fails fast instead of silently idling

Environment variables:

- `AIOCS_DAEMON_INTERVAL_MINUTES`
  - positive integer, defaults to `60`
- `AIOCS_DAEMON_FETCH_ON_START`
  - `true` by default
  - accepted values: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`
- `AIOCS_SOURCE_SPEC_DIRS`
  - comma-separated list of source spec directories
  - defaults to the bundled `sources/` path, plus `/app/sources` inside Docker when present

For local agents, the daemon keeps the shared catalog under `~/.aiocs` warm while agents continue to use the normal CLI with `--json`.

### Daemon JSON mode

`docs daemon --json` is intentionally different from one-shot commands. Because it is long-running, it emits one JSON event per line:

```bash
./dist/cli.js --json daemon
```

Example event stream:

```json
{"type":"daemon.started","intervalMinutes":60,"fetchOnStart":true,"sourceSpecDirs":["/app/sources"]}
{"type":"daemon.cycle.started","reason":"startup","startedAt":"2026-03-26T00:00:00.000Z"}
{"type":"daemon.cycle.completed","reason":"startup","result":{"dueSourceIds":[],"bootstrapped":{"processedSpecCount":5,"sources":[]}, "refreshed":[],"failed":[]}}
```

## MCP server

`aiocs` also ships an MCP server binary for tool-native agent integrations:

```bash
aiocs-mcp
pnpm dev:mcp
```

The MCP server exposes the same shared operations as the CLI without shell parsing:

- `version`
- `doctor`
- `init`
- `source_upsert`
- `source_list`
- `fetch`
- `refresh_due`
- `snapshot_list`
- `project_link`
- `project_unlink`
- `search`
- `show`

## Docker

The repo ships a long-running Docker service for scheduled refreshes.

Build and start it with:

```bash
docker compose up --build -d
```

The compose file:

- runs `docs daemon` as the container entrypoint
- bind-mounts `${HOME}/.aiocs` into `/root/.aiocs` so the container shares the same local catalog defaults as the host CLI
- bind-mounts `./sources` into `/app/sources` so source spec edits are picked up without rebuilding

Override cadence with environment variables when starting compose:

```bash
AIOCS_DAEMON_INTERVAL_MINUTES=15 docker compose up --build -d
```

## Source spec shape

Each source spec is YAML or JSON and must define:

- `id`
- `label`
- `startUrls`
- `allowedHosts`
- `discovery.include`
- `discovery.exclude`
- `discovery.maxPages`
- `extract`
- `normalize`
- `schedule.everyHours`

Supported extraction strategies:

- `clipboardButton`
- `selector`
- `readability`

## Verification

```bash
pnpm lint
pnpm test
pnpm build
npm pack --dry-run
```
