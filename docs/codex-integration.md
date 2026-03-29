# Codex Integration

Use `aiocs` as the local-first documentation system for Codex. The best results come from treating `aiocs` as the authoritative docs runtime and only falling back to live browsing when the catalog is missing, stale, or explicitly bypassed by the user.

## Recommended setup

Install the CLI and MCP binary globally:

```bash
npm install -g aiocs
docs --version
aiocs-mcp
```

The `aiocs-mcp` process is an MCP stdio server, so running it directly will wait for MCP clients instead of printing interactive help. The useful validation commands are:

```bash
docs --json doctor
docs --json init --fetch
```

## How Codex should use aiocs

1. Prefer `aiocs` before live browsing when the requested docs may already exist locally.
2. Prefer MCP through `aiocs-mcp` when Codex can use it.
3. Fall back to `docs --json ...` only when MCP is unavailable.
4. Default to `search mode=auto`.
5. Use `mode=lexical` for exact identifiers, endpoint names, headings, and error strings.
6. Use MCP `batch` when multiple list/search/show or search/diff/coverage steps are needed.
7. Cite `sourceId`, `snapshotId`, and `pageUrl` when they materially improve traceability.

## Automatic use in Codex

Codex does not automatically invoke a custom subagent just because one exists. The primary automatic-use mechanism is the `aiocs` skill itself.

To make Codex discover `aiocs` automatically on this machine, expose the skill in the global Codex skill directory:

```bash
mkdir -p ~/.codex/skills
ln -sfn /Users/jmucha/repos/mandex/aiocs/skills/aiocs ~/.codex/skills/aiocs
```

Once that symlink exists, Codex can load the `aiocs` skill directly from the global skills catalog and prefer local docs without you explicitly calling a subagent.

## Subagent options

There are two supported subagent patterns:

- Repo example for development and debugging:
  [`docs/examples/codex-agents/aiocs-docs-specialist.example.toml`](/Users/jmucha/repos/mandex/aiocs/docs/examples/codex-agents/aiocs-docs-specialist.example.toml)
- Install-ready global agent definition:
  [`/Users/jmucha/repos/ai-skills/agents/aiocs-docs-specialist.toml`](/Users/jmucha/repos/ai-skills/agents/aiocs-docs-specialist.toml)

The repo example is intentionally development-oriented and uses a checkout-local MCP command. The global agent points at the globally installed `aiocs-mcp` binary.

To expose the install-ready global agent to Codex on this machine:

```bash
mkdir -p ~/.codex/agents
ln -sfn /Users/jmucha/repos/ai-skills/agents/aiocs-docs-specialist.toml ~/.codex/agents/aiocs-docs-specialist.toml
```

## Suggested Codex flows

Health and bootstrap:

```bash
docs --json doctor
docs --json init --fetch
```

Local docs lookup:

```bash
docs --json search "maker flow" --source hyperliquid --mode auto
docs --json show 42
```

Drift, change, and completeness:

```bash
docs --json canary hyperliquid
docs --json diff hyperliquid
docs --json verify coverage hyperliquid /absolute/path/to/reference.md
```

Catalog maintenance:

```bash
docs --json refresh due
docs --json embeddings status
docs --json backup export /absolute/path/to/backup
```

## MCP-first guidance

If a Codex agent has access to the `aiocs-mcp` server, prefer these MCP tools over shelling out:

- `doctor`
- `init`
- `search`
- `show`
- `canary`
- `diff_snapshots`
- `verify_coverage`
- `embeddings_status`
- `batch`

The CLI remains the fallback and should always be invoked with `--json` for agent use.
