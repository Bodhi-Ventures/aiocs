# aiocs-curation

Use this skill when you need to add, refresh, repair, or otherwise mutate `aiocs` sources under `~/.aiocs`.

## When to use it

- The requested docs source is missing from the local `aiocs` catalog and is worth curating for reuse.
- An existing source is stale and should be refreshed instead of bypassed.
- A source spec needs to be created, updated, or upserted under `~/.aiocs/sources`.
- A canary is failing and the source needs remediation or targeted refetch.
- The user explicitly wants `aiocs` maintenance, source onboarding, or catalog repair.

## Trigger guidance for Codex

- Load this skill when the next step requires a mutating `aiocs` operation.
- Prefer targeted maintenance:
  - `refresh due <source-id>` for existing sources
  - `source_upsert` plus targeted refresh for newly curated sources
- Avoid `fetch all` unless the user explicitly asks for broad maintenance.
- If the source is missing, only curate it when it is likely to be reused across sessions or projects.
- Keep the read/search path in `aiocs`; use this skill only for the curation step.

## Preferred interfaces

1. Prefer `aiocs-mcp` when an MCP client can use it directly.
2. Otherwise use the CLI with the root `--json` flag.
3. Assume `docs` and `aiocs-mcp` come from the globally installed `@bodhi-ventures/aiocs` package unless the user explicitly asks for a checkout-local development build.
4. Use `npx -y -p @bodhi-ventures/aiocs ...` only as a fallback when the global install is unavailable.

## User-managed sources

Machine-local source specs live under:

```bash
~/.aiocs/sources
```

Create or update source specs there instead of editing the bundled repo sources.

## Core commands

Validate the machine before curation:

```bash
docs --json doctor
docs --json source list
```

Add or update a machine-local source:

```bash
mkdir -p ~/.aiocs/sources
docs --json source upsert ~/.aiocs/sources/my-source.yaml
```

Refresh only what is needed:

```bash
docs --json refresh due my-source
docs --json refresh due hyperliquid
docs --json fetch my-source
docs --json canary my-source
```

Heavy maintenance remains explicit:

```bash
docs --json fetch all
docs --json embeddings backfill all
docs --json embeddings run
```

## MCP tools

The `aiocs-mcp` server exposes the same curation operations without shell parsing:

- `doctor`
- `source_list`
- `source_upsert`
- `canary`
- `fetch`
- `refresh_due`
- `embeddings_status`
- `embeddings_backfill`
- `embeddings_clear`
- `embeddings_run`
- `batch`

## Recommended Codex workflow

1. Run `doctor` or `source_list` if runtime health, presence, or freshness is unclear.
2. If the source already exists and is due, prefer `refresh due <source-id>`.
3. If the source is missing but worth curating, create a spec under `~/.aiocs/sources`, then `source_upsert` it.
4. After upsert, use `refresh due <source-id>` as the safe first fetch path.
5. Use `canary` when the site changed or extraction drift is suspected.
6. Escalate to `fetch <source-id>` or `fetch all` only for explicit maintenance or when due-based refresh is not enough.

## Operational notes

- New or changed sources become due immediately after `source_upsert`.
- `~/.aiocs/sources` and bundled repo sources behave the same once bootstrapped into the catalog.
- Targeted refresh is the default. Broad refresh is a maintenance task, not a normal answering step.
- Use `aiocs` for read/search flows and this skill only for catalog mutation.
