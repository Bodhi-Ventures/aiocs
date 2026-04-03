# aiocs

Local-only documentation fetch, versioning, and search CLI for AI agents.

## What it does

- fetches docs from websites with Playwright
- snapshots curated external git repositories as shared local reference sources
- supports authenticated sources via environment-backed headers and cookies
- runs lightweight canaries to detect source drift before full refreshes
- normalizes them into Markdown
- stores immutable local snapshots in a shared catalog
- diffs snapshots to show what changed between fetches
- indexes heading-aware chunks in SQLite FTS5
- adds optional hybrid retrieval with local Ollama embeddings and a dedicated Qdrant vector index
- compiles derived research workspaces into Markdown wiki artifacts with LM Studio
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
npm install -g @bodhi-ventures/aiocs
docs --version
docs --help
command -v aiocs-mcp
```

Zero-install fallback:

```bash
npx -y -p @bodhi-ventures/aiocs docs --version
npx -y -p @bodhi-ventures/aiocs aiocs-mcp
```

For repository development only:

```bash
pnpm install
pnpm build
pnpm dev -- --help
pnpm dev:mcp
```

For AI agents, prefer the root-level `--json` flag for one-shot commands:

```bash
docs --json version
docs --json doctor
docs --json init --no-fetch
docs --json source list
docs --json search "maker flow" --source hyperliquid
docs --json show 42
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

## Release

Stable releases are tag-driven. Bump `package.json.version`, commit the change, then create and push a matching stable tag:

```bash
git add package.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

GitHub Actions publishes `@bodhi-ventures/aiocs` publicly to npm and creates the GitHub release only from pushed tags matching `vX.Y.Z`. The workflow validates that the tag exactly matches `package.json.version` and is safe to rerun after partial success.

## Codex integration

For Codex-first setup, automatic-use guidance, MCP recommendations, and agent definitions, see [docs/codex-integration.md](./docs/codex-integration.md).

Canonical Codex setup:

- register `aiocs-mcp` in `~/.codex/config.toml`
- link `skills/aiocs` into `~/.codex/skills/aiocs`
- link `skills/aiocs-curation` into `~/.codex/skills/aiocs-curation`
- keep the optional specialist subagent linked only as a fallback for heavier docs workflows

## Managed sources

The open-source repo bundles both web and git sources in `sources/`:

- `hyperliquid` for the public docs site
- `nktkas-hyperliquid` for the `nktkas/hyperliquid` GitHub repository

Additional machine-local source specs belong in `~/.aiocs/sources`.

`docs init` bootstraps both managed locations, so source behavior is the same regardless of
whether a spec lives in the repo or in `~/.aiocs/sources`.

Bootstrap managed sources in one command:

```bash
docs init --no-fetch
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
mkdir -p ~/.aiocs/sources
cp /path/to/source.yaml ~/.aiocs/sources/my-source.yaml
docs source upsert ~/.aiocs/sources/my-source.yaml
docs source upsert /path/to/source.yaml
docs source list
```

Fetch and snapshot docs:

```bash
docs refresh due hyperliquid
docs snapshot list hyperliquid
docs refresh due
```

Force fetch remains available for explicit maintenance:

```bash
docs fetch hyperliquid
docs fetch all
```

Link docs to a local project:

```bash
docs project link /absolute/path/to/project hyperliquid lighter
docs project unlink /absolute/path/to/project lighter
```

Search and inspect results:

```bash
docs search "maker flow" --source hyperliquid
docs search "WebSocketTransport" --source nktkas-hyperliquid --path "src/**" --language typescript
docs search "maker flow" --source hyperliquid --mode lexical
docs search "maker flow" --source hyperliquid --mode hybrid
docs search "maker flow" --source hyperliquid --mode semantic
docs search "maker flow" --all
docs search "maker flow" --source hyperliquid --limit 5 --offset 0
docs show 42
docs canary hyperliquid
docs diff hyperliquid
docs embeddings status
docs embeddings backfill all
docs embeddings run
docs backup export /absolute/path/to/backup
docs verify coverage hyperliquid /absolute/path/to/reference.md
```

When `docs search` runs inside a linked project, it automatically scopes to that project's linked sources unless `--source` or `--all` is provided.

### Research workspaces

`aiocs` can compile a derived workspace wiki on top of canonical source snapshots. Workspace artifacts are stored separately from fetched sources under `~/.aiocs/data/workspaces/<workspace-id>/` and keep provenance links back to source chunks.

LM Studio is the v1 compiler runtime. Load `google/gemma-4-26b-a4b` in LM Studio, start the local API server, and make sure `doctor` can see it:

```bash
docs --json doctor
```

If LM Studio is running on a non-default host or model, override:

```bash
export AIOCS_LMSTUDIO_BASE_URL=ws://127.0.0.1:1234
export AIOCS_LMSTUDIO_MODEL=google/gemma-4-26b-a4b
```

These environment overrides apply at runtime, including for already-created workspaces.

Create, bind, compile, and search a workspace:

```bash
docs workspace create market-structure --label "Market Structure" --auto-compile
docs workspace bind market-structure hyperliquid nktkas-hyperliquid
docs workspace compile market-structure
docs workspace status market-structure
docs workspace queue-run
docs workspace search market-structure "transport and websocket design" --scope mixed
docs workspace artifact list market-structure
docs workspace artifact show market-structure derived/index.md
docs workspace lint market-structure
docs workspace output market-structure report --name weekly-brief
docs workspace output market-structure slides --name weekly-brief
docs workspace answer market-structure note "What changed in websocket transport?" --name websocket-note
```

Workspace compile and maintenance are incremental:

- canonical source snapshots remain the source of truth
- unchanged sources are skipped on later compiles
- changed sources regenerate only their derived summaries/concepts plus the shared index
- changed raw inputs regenerate only their derived summaries/concepts plus the shared index
- generated reports/slides keep provenance to the bound source snapshots
- generated notes/reports/slides are marked stale when their inputs change

Opt-in automatic recompilation:

- set `--auto-compile` when creating the workspace, or later with `docs workspace configure <workspace-id> --auto-compile true`
- the daemon queues recompiles after bound source refreshes
- run `docs workspace queue-run` to process queued jobs outside the daemon

Workspace-scoped raw ingest:

```bash
docs workspace ingest add market-structure markdown-dir /absolute/path/to/notes --label "Research notes"
docs workspace ingest add market-structure pdf /absolute/path/to/paper.pdf --label "Paper PDF"
docs workspace ingest add market-structure image /absolute/path/to/diagram.png --label "Market diagram"
docs workspace ingest list market-structure
docs workspace ingest search market-structure "fee tier" --kind markdown-dir
docs workspace ingest show market-structure markdown-dir-notes-<hash>
```

Obsidian sync:

```bash
docs workspace sync obsidian market-structure /absolute/path/to/obsidian-vault
```

The workspace is synced under `aiocs/<workspace-id>/` by default so the raw, derived, and output trees stay grouped inside the vault.

If any bound source snapshot changes, rerun `docs workspace compile <workspace-id>` before `docs workspace output ...`. Output generation fails closed when required derived artifacts are stale.

For agents, the intended decision order is:

1. check `source list` or scoped `search` first
2. if the source exists and is due, run `refresh due <source-id>`
3. if the source is missing but worth reusing, add a spec under `~/.aiocs/sources`, then upsert and refresh only that source
4. avoid `fetch all` unless the user explicitly asks or the daemon is doing maintenance

### Git repo sources

`aiocs` supports first-class `kind: git` sources for curated external repositories that should be
reused across multiple local projects.

Example:

```yaml
kind: git
id: nktkas-hyperliquid
label: nktkas/hyperliquid Repo
repo:
  url: https://github.com/nktkas/hyperliquid.git
  ref: main
  include:
    - README.md
    - docs/**
    - src/**
  exclude:
    - .github/**
    - dist/**
schedule:
  everyHours: 24
```

Git source snapshots are commit-based, stored under the shared local catalog, and searchable with
the same project linking, diffing, canary, and hybrid search flows as website docs.

### Hybrid search

`aiocs` keeps SQLite FTS5/BM25 as the canonical lexical index and adds an optional hybrid layer:

- `--mode lexical`: lexical search only
- `--mode hybrid`: BM25 plus vector recall fused with reciprocal-rank fusion
- `--mode semantic`: vector-only recall over the latest indexed snapshots
- `--mode auto`: default; uses hybrid only when the vector layer is healthy and current for the requested scope

Vector state is derived from the catalog, not a second source of truth. If Ollama or Qdrant is unavailable, `auto` degrades back to lexical search.

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

Backups intentionally include only the canonical `~/.aiocs` data/config state. The Qdrant vector index is treated as derived state and is rebuilt from the restored catalog after `backup import`.

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
- `embeddings status`
- `embeddings backfill`
- `embeddings clear`
- `embeddings run`
- `search`
- `verify coverage`
- `show`

Representative examples:

```bash
docs --json doctor
docs --json init --no-fetch
docs --json source list
docs --json source upsert sources/hyperliquid.yaml
docs --json refresh due hyperliquid
docs --json canary hyperliquid
docs --json refresh due
docs --json diff hyperliquid
docs --json embeddings status
docs --json embeddings backfill all
docs --json embeddings clear hyperliquid
docs --json embeddings run
docs --json project link /absolute/path/to/project hyperliquid lighter
docs --json snapshot list hyperliquid
docs --json backup export /absolute/path/to/backup
docs --json verify coverage hyperliquid /absolute/path/to/reference.md
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
    "modeRequested": "auto",
    "modeUsed": "hybrid",
    "results": []
  }
}
```

## Daemon

`aiocs` ships a first-class long-running refresh process:

```bash
docs daemon
```

The daemon bootstraps source specs from the configured directories, refreshes due sources, sleeps for the configured interval, and repeats.
Configured source spec directories are treated as the daemon’s source of truth:

- if a managed source spec changes, the source is made due immediately in the same daemon cycle
- if a managed source spec is removed from disk, the source is removed from the catalog on the next bootstrap
- if `AIOCS_SOURCE_SPEC_DIRS` is explicitly set but resolves to missing or empty directories, the daemon fails fast instead of silently idling
- due canaries run independently from full fetch schedules so drift is caught earlier than the next full snapshot refresh
- daemon heartbeat state is persisted in the local catalog and surfaced through `docs doctor`
- queued embedding jobs are processed in the same daemon cycle after fetches complete

Environment variables:

- `AIOCS_DAEMON_INTERVAL_MINUTES`
  - positive integer, defaults to `60`
- `AIOCS_DAEMON_FETCH_ON_START`
  - `true` by default
  - accepted values: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`
- `AIOCS_SOURCE_SPEC_DIRS`
  - comma-separated list of source spec directories
  - defaults to `~/.aiocs/sources`, the bundled `sources/` path, plus `/app/sources` inside Docker when present

For local agents, the daemon keeps the shared catalog under `~/.aiocs` warm while agents continue to use the normal CLI with `--json`.

### Daemon JSON mode

`docs daemon --json` is intentionally different from one-shot commands. Because it is long-running, it emits one JSON event per line:

```bash
docs --json daemon
```

Example event stream:

```json
{"type":"daemon.started","intervalMinutes":60,"fetchOnStart":true,"sourceSpecDirs":["/app/sources"]}
{"type":"daemon.cycle.started","reason":"startup","startedAt":"2026-03-26T00:00:00.000Z"}
{"type":"daemon.cycle.completed","reason":"startup","result":{"canaryDueSourceIds":[],"dueSourceIds":[],"bootstrapped":{"processedSpecCount":5,"sources":[]},"canaried":[],"canaryFailed":[],"refreshed":[],"failed":[],"embedded":[],"embeddingFailed":[]}}
```

## MCP server

`aiocs` also ships an MCP server binary for tool-native agent integrations:

```bash
command -v aiocs-mcp
aiocs-mcp
```

For repository development only:

```bash
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

## Release automation

The repo ships two GitHub Actions workflows:

- [ci.yml](./.github/workflows/ci.yml): validation for lint, tests, build, pack, and Docker smoke coverage
- [release.yml](./.github/workflows/release.yml): tag-driven stable release flow that validates the tagged package state, publishes to npm, and creates a GitHub release

The release workflow is triggered only by pushed stable tags matching `vX.Y.Z` and expects an npm publish token in GitHub repository secrets. The release job is retryable: if `@bodhi-ventures/aiocs@X.Y.Z` already exists on npm or the GitHub release already exists for `vX.Y.Z`, the workflow skips the completed publication step and finishes the remaining one.

Successful MCP results use an envelope:

```json
{
  "ok": true,
  "data": {
    "name": "@bodhi-ventures/aiocs",
    "version": "0.1.1"
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
- runs a dedicated `aiocs-qdrant` container for vector search
- points the daemon at host Ollama with `AIOCS_OLLAMA_BASE_URL` (defaults to `http://host.docker.internal:11434` in Compose)

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
