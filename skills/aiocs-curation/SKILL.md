---
name: aiocs-curation
description: Use when aiocs sources or snapshots need mutation, such as source onboarding, targeted refresh, canary remediation, or catalog repair.
---

# aiocs-curation

Use this skill when you need to add, refresh, repair, or otherwise mutate `aiocs` sources under `~/.aiocs`.

## When to use it

- The requested source is missing from the local `aiocs` catalog and is worth curating for reuse.
- An existing source is stale and should be refreshed instead of bypassed.
- A source spec needs to be created, updated, or upserted under `~/.aiocs/sources`.
- A reusable external git repository should be added as a `kind: git` source under `~/.aiocs/sources`.
- A source should gain curated metadata such as purpose, topic hints, common locations, gotchas, or auth notes.
- A durable routing hint should be saved because a discovery or failed path will help future retrieval.
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
3. Assume `aiocs` and `aiocs-mcp` come from the globally installed `@bodhi-ventures/aiocs` package unless the user explicitly asks for a checkout-local development build.
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
aiocs --json doctor
aiocs --json source list
```

Add or update a machine-local source:

```bash
mkdir -p ~/.aiocs/sources
aiocs --json source upsert ~/.aiocs/sources/my-source.yaml
```

Add or update curated source context:

```bash
aiocs --json source context upsert my-source ~/.aiocs/source-context/my-source.yaml
```

Refresh only what is needed:

```bash
aiocs --json refresh due my-source
aiocs --json refresh due hyperliquid
aiocs --json refresh due nktkas-hyperliquid
aiocs --json fetch my-source
aiocs --json canary my-source
```

Persist durable routing learnings when they will help future retrieval:

```bash
aiocs --json learning save --source my-source --kind discovery --intent "where is auth documented" --page-url "https://..."
aiocs --json learning save --source my-source --kind negative --intent "where is auth documented" --page-url "https://..." --note "Overview page is not enough."
```

Heavy maintenance remains explicit:

```bash
aiocs --json fetch all
aiocs --json embeddings backfill all
aiocs --json embeddings run
```

## MCP tools

The `aiocs-mcp` server exposes the same curation operations without shell parsing:

- `doctor`
- `source_list`
- `source_upsert`
- `source_context_upsert`
- `canary`
- `fetch`
- `refresh_due`
- `learning_save`
- `embeddings_status`
- `embeddings_backfill`
- `embeddings_clear`
- `embeddings_run`
- `batch`

## Recommended Codex workflow

1. Run `doctor` or `source_list` if runtime health, presence, or freshness is unclear.
2. If the source already exists and is due, prefer `refresh due <source-id>`.
3. If the source is missing but worth curating, create a spec under `~/.aiocs/sources`, then `source_upsert` it.
4. If source-level context will help future retrieval, upsert a curated source-context file.
5. After upsert, use `refresh due <source-id>` as the safe first fetch path.
6. Use `canary` when the site changed or extraction drift is suspected.
7. Save routing learnings only when the discovery is durable enough to help future runs.
8. Escalate to `fetch <source-id>` or `fetch all` only for explicit maintenance or when due-based refresh is not enough.

## Operational notes

- New or changed sources become due immediately after `source_upsert`.
- `source context upsert` is the right place for durable source-level guidance; do not overload source specs with retrieval notes.
- `learning save` is for durable routing memory, not one-off scratch notes.
- `~/.aiocs/sources` and bundled repo sources behave the same once bootstrapped into the catalog.
- Targeted refresh is the default. Broad refresh is a maintenance task, not a normal answering step.
- Use `aiocs` for read/search flows and this skill only for catalog mutation.
