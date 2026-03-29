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

## How Codex should use aiocs

1. Prefer `aiocs` before live browsing when the requested docs may already exist locally.
2. Prefer MCP through `aiocs-mcp` when Codex can use it.
3. Fall back to `docs --json ...` only when MCP is unavailable.
4. Check `source_list` before assuming a source is missing or stale.
5. Default to `search mode=auto`.
6. Use `mode=lexical` for exact identifiers, endpoint names, headings, and error strings.
7. Prefer `refresh due <source-id>` over force `fetch <source-id>` when the source already exists.
8. Use MCP `batch` when multiple list/search/show or search/diff/coverage steps are needed.
9. Cite `sourceId`, `snapshotId`, and `pageUrl` when they materially improve traceability.

## Automatic use in Codex

Codex does not automatically invoke a custom subagent just because one exists. The primary automatic-use mechanism is the `aiocs` skill itself.

To make Codex discover `aiocs` automatically on this machine, expose the skill in the global Codex skill directory:

```bash
AIOCS_REPO=/absolute/path/to/your/aiocs/checkout
mkdir -p ~/.codex/skills
ln -sfn "$AIOCS_REPO/skills/aiocs" ~/.codex/skills/aiocs
```

Once that symlink exists, Codex can load the `aiocs` skill directly from the global skills catalog and prefer local docs without you explicitly calling a subagent.

## Subagent options

There are two supported subagent patterns:

- Repo-managed agent definition:
  [`agents/aiocs-docs-specialist.toml`](../agents/aiocs-docs-specialist.toml)
- Install-ready global agent definition:
  `ai-skills/agents/aiocs-docs-specialist.toml` from your local `ai-skills` checkout

The repo-managed agent definition and the install-ready global agent both point at the globally installed `aiocs-mcp` binary so Codex uses the published package by default.

To expose the install-ready global agent to Codex on this machine:

```bash
AI_SKILLS_REPO=/absolute/path/to/your/ai-skills/checkout
mkdir -p ~/.codex/agents
ln -sfn "$AI_SKILLS_REPO/agents/aiocs-docs-specialist.toml" ~/.codex/agents/aiocs-docs-specialist.toml
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
- `source_upsert`
- `search`
- `show`
- `canary`
- `refresh_due`
- `diff_snapshots`
- `verify_coverage`
- `embeddings_status`
- `batch`

The CLI remains the fallback and should always be invoked with `--json` for agent use. For normal answering flows, avoid `fetch all`; use targeted due refresh or explicit user-approved force fetches.
