# aiocs

Local-only documentation fetch, versioning, and search CLI for AI agents.

## What it does

- fetches docs from websites with Playwright
- supports authenticated sources via environment-backed headers and cookies
- runs lightweight canaries to detect source drift before full refreshes
- normalizes them into Markdown
- stores immutable local snapshots in a shared catalog
- diffs snapshots to show what changed between fetches
- indexes heading-aware chunks in SQLite FTS5
- links docs sources to local projects for scoped search
- exports and imports manifest-backed backups for `~/.aiocs`

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
    "total": 0,
    "limit": 20,
    "offset": 0,
    "hasMore": false,
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
    "code": "CHUNK_NOT_FOUND",
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
pnpm dev -- search "maker flow" --source hyperliquid --limit 5 --offset 0
pnpm dev -- show 42
pnpm dev -- canary hyperliquid
pnpm dev -- diff hyperliquid
pnpm dev -- backup export /absolute/path/to/backup
pnpm dev -- verify coverage hyperliquid /absolute/path/to/reference.md
```

When `docs search` runs inside a linked project, it automatically scopes to that project's linked sources unless `--source` or `--all` is provided.

### Authenticated sources

Source specs can reference secrets from the environment without storing raw values in YAML:

```yaml
auth:
  headers:
    - name: authorization
      valueFromEnv: AIOCS_DOCS_TOKEN
      hosts:
        - docs.example.com
      include:
        - https://docs.example.com/private/**
  cookies:
    - name: session
      valueFromEnv: AIOCS_DOCS_SESSION
      domain: docs.example.com
      path: /
```

Header secrets are scoped per entry. If `hosts` is omitted, the header applies to the source `allowedHosts`; `include` can further narrow it to specific URL patterns.

### Canary checks

Canaries execute the real extraction strategy without creating snapshots. They are intended to catch selector/copy-markdown drift before a full refresh degrades silently.

```yaml
canary:
  everyHours: 6
  checks:
    - url: https://docs.example.com/start
      expectedTitle: Private Docs Start
      expectedText: Secret market structure docs
      minMarkdownLength: 40
```

If `canary` is omitted, `aiocs` defaults to a lightweight canary against the first `startUrl`.

### Backups

`backup export` creates a manifest-backed directory snapshot. The catalog database is exported with SQLite's native backup mechanism so the backup stays consistent even if `aiocs` is reading or writing the catalog while the export runs.

## JSON command reference

All one-shot commands support `--json`:

- `version`
- `init`
- `doctor`
- `source upsert`
- `source list`
- `fetch`
- `canary`
- `refresh due`
- `snapshot list`
- `diff`
- `project link`
- `project unlink`
- `backup export`
- `backup import`
- `search`
- `verify coverage`
- `show`

Representative examples:

```bash
pnpm dev -- --json doctor
pnpm dev -- --json init --no-fetch
pnpm dev -- --json source upsert sources/hyperliquid.yaml
pnpm dev -- --json fetch hyperliquid
pnpm dev -- --json canary hyperliquid
pnpm dev -- --json refresh due
pnpm dev -- --json diff hyperliquid
pnpm dev -- --json project link /absolute/path/to/project hyperliquid lighter
pnpm dev -- --json snapshot list hyperliquid
pnpm dev -- --json backup export /absolute/path/to/backup
pnpm dev -- --json verify coverage hyperliquid /absolute/path/to/reference.md
```

For multi-result commands like `fetch`, `refresh due`, and `search`, `data` contains structured collections rather than line-by-line output:

```json
{
  "ok": true,
  "command": "search",
  "data": {
    "query": "maker flow",
    "total": 42,
    "limit": 20,
    "offset": 0,
    "hasMore": true,
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
- due canaries run independently from full fetch schedules so drift is caught earlier than the next full snapshot refresh
- daemon heartbeat state is persisted in the local catalog and surfaced through `docs doctor`

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
{"type":"daemon.cycle.completed","reason":"startup","result":{"canaryDueSourceIds":[],"dueSourceIds":[],"bootstrapped":{"processedSpecCount":5,"sources":[]},"canaried":[],"canaryFailed":[],"refreshed":[],"failed":[]}}
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

## Release automation

The repo ships two GitHub Actions workflows:

- [ci.yml](./.github/workflows/ci.yml): validation for lint, tests, build, pack, and Docker smoke coverage
- [release.yml](./.github/workflows/release.yml): manual release flow that validates the package, prepares or reuses the requested version and tag, publishes to npm, and creates a GitHub release

The release workflow is triggered through `workflow_dispatch` and expects:

- a `version` input
- an optional `npm_tag` input
- `NPM_TOKEN` in repository secrets

The release job is retryable: if a version/tag already exists in git or npm, the workflow reuses that state and skips the already-completed publish or GitHub release step instead of forcing manual cleanup.

Successful MCP results use an envelope:

```json
{
  "ok": true,
  "data": {
    "name": "aiocs",
    "version": "0.1.0"
  }
}
```

Failed MCP results use the same machine-readable error shape:

```json
{
  "ok": false,
  "error": {
    "code": "CHUNK_NOT_FOUND",
    "message": "Chunk 42 not found"
  }
}
```

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
