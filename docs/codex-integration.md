# Codex Integration

Use `aiocs` as the local-first documentation system for Codex. The best results come from treating `aiocs` as the authoritative docs runtime and only falling back to live browsing when the catalog is missing, stale, or explicitly bypassed by the user.

## Recommended setup

Install the CLI and MCP binary globally:

```bash
npm install -g @bodhi-ventures/aiocs
docs --version
command -v aiocs-mcp
```

If global install is unavailable, use `npx` only as a fallback:

```bash
npx -y -p @bodhi-ventures/aiocs docs --version
npx -y -p @bodhi-ventures/aiocs aiocs-mcp
```

The `aiocs-mcp` process is an MCP stdio server, so running it directly will wait for MCP clients instead of printing interactive help. The useful validation commands are:

```bash
docs --json doctor
docs --json init --no-fetch
```

Register `aiocs-mcp` as a global Codex MCP server so the main agent can use it directly without shell fallback:

```toml
[mcp_servers.aiocs]
command = "aiocs-mcp"
```

## How Codex should use aiocs

1. Prefer `aiocs` before live browsing when the requested docs may already exist locally.
2. Prefer MCP through `aiocs-mcp` when Codex can use it.
3. Fall back to `docs --json ...` only when MCP is unavailable.
4. Check `source_list` before assuming a source is missing or stale.
5. Default to `search mode=auto`.
6. Use `mode=lexical` for exact identifiers, endpoint names, headings, and error strings.
7. Use `pathPatterns` and `languages` filters when the source is a repo/code source and the question is file- or language-specific.
8. Use the `aiocs` skill for read/search flows and `aiocs-curation` only when the task requires source onboarding or refresh.
9. Prefer `refresh due <source-id>` over force `fetch <source-id>` when the source already exists.
10. Use MCP `batch` when multiple list/search/show or search/diff/coverage steps are needed.
11. Cite `sourceId`, `snapshotId`, and `pageUrl` when they materially improve traceability.
12. If the user is operating on a compiled research workspace, prefer `workspace_search` and `workspace_artifact_show` over raw source search.

## Automatic use in Codex

Codex does not automatically invoke a custom subagent just because one exists. The primary automatic-use mechanism is the `aiocs` MCP server plus the `aiocs` skill itself.

To make Codex discover the read/search path automatically, expose the skills in the global Codex skill directory:

```bash
AIOCS_REPO=/absolute/path/to/your/aiocs/checkout
mkdir -p ~/.codex/skills
ln -sfn "$AIOCS_REPO/skills/aiocs" ~/.codex/skills/aiocs
ln -sfn "$AIOCS_REPO/skills/aiocs-curation" ~/.codex/skills/aiocs-curation
```

Once those symlinks exist, Codex can load `aiocs` for normal local-doc lookup and `aiocs-curation` only when the task needs source mutation or refresh.

## Subagent options

The repo ships a ready-to-copy specialist definition at
[`agents/aiocs-docs-specialist.toml`](../agents/aiocs-docs-specialist.toml).

It points at the globally installed `aiocs-mcp` binary so Codex uses the published package by default.

To expose that agent to Codex:

```bash
AIOCS_REPO=/absolute/path/to/your/aiocs/checkout
mkdir -p ~/.codex/agents
ln -sfn "$AIOCS_REPO/agents/aiocs-docs-specialist.toml" ~/.codex/agents/aiocs-docs-specialist.toml
```

## Suggested Codex flows

Health and bootstrap:

```bash
docs --json doctor
docs --json init --no-fetch
```

Local docs lookup:

```bash
docs --json source list
docs --json search "maker flow" --source hyperliquid --mode auto
docs --json search "WebSocketTransport" --source nktkas-hyperliquid --path "src/**" --language typescript --mode lexical
docs --json show 42
```

Missing or stale sources:

```bash
# user-managed source specs live here
~/.aiocs/sources

docs --json source upsert ~/.aiocs/sources/my-source.yaml
docs --json refresh due my-source
```

Drift, change, and completeness:

```bash
docs --json canary hyperliquid
docs --json diff hyperliquid
docs --json verify coverage hyperliquid /absolute/path/to/reference.md
```

Research workspaces:

```bash
docs --json workspace create market-structure --label "Market Structure" --auto-compile
docs --json workspace bind market-structure hyperliquid nktkas-hyperliquid
docs --json workspace compile market-structure
docs --json workspace queue-run
docs --json workspace search market-structure "transport design" --scope mixed
docs --json workspace artifact show market-structure derived/index.md
docs --json workspace output market-structure report --name weekly-brief
docs --json workspace answer market-structure note "What changed in websocket transport?" --name websocket-note
docs --json workspace ingest add market-structure markdown-dir /absolute/path/to/notes --label "Research notes"
docs --json workspace sync obsidian market-structure /absolute/path/to/vault
```

If bound source snapshots have changed since the last compile, rerun `workspace compile` before `workspace output`. The output path now fails closed on stale derived artifacts instead of synthesizing reports from outdated summaries.

Catalog maintenance:

```bash
docs --json refresh due hyperliquid
docs --json embeddings status
docs --json backup export /absolute/path/to/backup
```

## MCP-first guidance

If a Codex agent has access to the `aiocs-mcp` server, prefer these MCP tools over shelling out:

- `doctor`
- `init`
- `source_list`
- `search`
- `show`
- `canary`
- `diff_snapshots`
- `verify_coverage`
- `embeddings_status`
- `workspace_list`
- `workspace_status`
- `workspace_search`
- `workspace_ingest_list`
- `workspace_ingest_search`
- `workspace_artifact_list`
- `workspace_artifact_show`
- `workspace_lint`
- `batch`

Use mutating tools such as `source_upsert`, `refresh_due`, `fetch`, `workspace_create`, `workspace_bind`, `workspace_compile`, and `workspace_output` only through the `aiocs-curation` workflow.

## LM Studio requirement for workspaces

Workspace compilation and output generation use LM Studio in v1. Codex should assume:

- provider: LM Studio
- model: `google/gemma-4-26b-a4b`
- default API endpoint: `ws://127.0.0.1:1234`

If `doctor` reports the `lmstudio` check as `warn` or `fail`, Codex should not claim workspace compilation is available until LM Studio is running and the configured model is loaded.

The CLI remains the fallback and should always be invoked with `--json` for agent use. For normal answering flows, avoid `fetch all`; use targeted due refresh or explicit user-approved force fetches.
