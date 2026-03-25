# Local-Only Docs Store and Search CLI Plan

## Summary

Build a standalone TypeScript tool that owns the full local docs lifecycle: fetch docs from websites, normalize them into Markdown, version them as immutable snapshots, index them into a shared local search store, and expose a CLI for project-aware search. The system is local-only, reusable across projects from one central store, and designed so agents can rely on it without copying docs into each repo.

The implementation should replace the current `marketmaker/packages/docs-fetch` workflow immediately by porting those sources into the new tool. CLI is the first-class interface. MCP is explicitly deferred until the CLI/store contract is stable.

**Chosen defaults**
- Standalone local tool, not per-repo tooling
- Full pipeline in scope for v1
- Generic crawler first
- Snapshot-run versioning
- External scheduler only
- Replace current fetcher immediately
- No remote registry or upstream fallback in v1

## Key Changes

### 1. Core architecture

- Use Node 22 + TypeScript with `commander` for CLI, `zod` for config validation, `playwright` for crawling, `turndown` or equivalent for HTML-to-Markdown conversion, and `better-sqlite3` for the local catalog/search store.
- Store all state under XDG-style local paths:
  - data: `$XDG_DATA_HOME/<tool>` or `~/.local/share/<tool>`
  - config: `$XDG_CONFIG_HOME/<tool>` or `~/.config/<tool>`
- Make SQLite the single source of truth for metadata and search. Keep raw normalized Markdown files on disk for audit/debugging, but treat the SQLite catalog as canonical.
- Do not write repo-tracked files by default. Project-to-doc associations are stored centrally and keyed by absolute project path.

### 2. Data model and storage

- Define these first-class entities:
  - `Source`: stable source id, label, start URLs, host allowlist, crawl rules, extraction strategy, refresh cadence, optional version detection rules
  - `Snapshot`: immutable successful fetch result for one source, identified by timestamp + content hash, with optional detected upstream version and fetch stats
  - `Page`: canonical URL, title, normalized Markdown, content hash, fetch metadata
  - `Chunk`: heading-aware search unit derived from a page
  - `ProjectLink`: absolute project path mapped to one or more sources and snapshot selection rules
- Use one catalog DB with FTS5 tables for chunks and relational tables for sources, snapshots, pages, and project links.
- Only create a new snapshot when source content changed or source config changed. If a refresh finds no content change, update `last_checked_at` without promoting a new snapshot.
- Keep all snapshots by default. Add an explicit `gc` command later rather than implicit retention in v1.

### 3. Source spec and crawler design

- Define a declarative source spec file format in YAML or JSON.
- Required source spec fields:
  - `id`, `label`, `startUrls`, `allowedHosts`, `discovery`, `extract`, `normalize`, `schedule`
- `discovery` must support include/exclude URL patterns, canonicalization rules, max pages, and revisit/dedup behavior.
- `extract` must support a generic strategy system with these built-ins:
  - `clipboardButton`: for sites like the current GitBook-style flows
  - `selector`: extract a specific article container
  - `readability`: generic article extraction fallback
- `normalize` must preserve headings, code blocks, tables where possible, and source URL metadata.
- `schedule` is metadata only in v1; the tool does not run a daemon.
- Port the current Synthetix, Hyperliquid, Lighter, Nado, and Ethereal definitions into source specs inside the new tool and drop the bespoke site modules from the old package as the active path.

### 4. Fetch, snapshot, and indexing pipeline

- Implement the pipeline as: resolve source spec -> crawl/discover pages -> extract page content -> normalize Markdown -> hash pages -> compare against latest successful snapshot -> persist new snapshot if changed -> derive heading-aware chunks -> update FTS index.
- Chunking should mirror the useful parts of Mandex:
  - keep small pages whole
  - split large pages by headings
  - split oversized sections further by size boundary
- Each chunk must retain: source id, snapshot id, page URL, page title, section title, chunk order, and content.
- Failed fetch runs must never promote to `latest`. Persist failure metadata separately so operators can inspect what broke.
- Search must default to latest successful snapshots only.

### 5. CLI surface

- Define the stable v1 CLI as:
  - `docs source upsert <spec-file>`
  - `docs source list`
  - `docs fetch <source-id|all>`
  - `docs refresh due`
  - `docs snapshot list <source-id>`
  - `docs project link <project-path> <source-id>...`
  - `docs project unlink <project-path> [source-id...]`
  - `docs search <query> [--source <id>...] [--project <path>] [--snapshot <id>] [--all]`
  - `docs show <result-id>`
- `docs search` behavior:
  - if current working directory belongs to a linked project, search only that project’s linked sources at latest snapshot unless overridden
  - if not inside a linked project, require `--source` or `--all`; do not silently search the whole catalog
- `docs refresh due` must be idempotent so it can be called from cron/launchd/systemd on a schedule.
- MCP is not part of v1 acceptance. When added, it must call the same service layer as the CLI, not duplicate search or resolution logic.

## Public Interfaces

- **Source spec schema**: declarative config for discovery, extraction, normalization, and cadence
- **Catalog DB schema**: `sources`, `snapshots`, `pages`, `chunks`, `project_links`, plus FTS5 index on chunk content/title
- **CLI contract**: commands above are the public user-facing API and must be documented as stable
- **Project resolution rule**: project path links resolve docs scope centrally; no repo-local manifest in v1

## Test Plan

- Unit tests for source spec validation, URL canonicalization, snapshot change detection, chunking, and project path resolution.
- Fixture-based extraction tests for `clipboardButton`, `selector`, and `readability` strategies using saved HTML/pages.
- Integration tests for:
  - fetch -> snapshot -> search on one source
  - changed vs unchanged refresh behavior
  - failure run does not replace latest successful snapshot
  - project link scoping from inside and outside linked repos
  - search filters by source and snapshot correctly
- CLI smoke tests for every public command with expected exit codes and user-facing output.
- Migration acceptance:
  - the five current `docs-fetch` targets run successfully through the new tool
  - the resulting search output includes correct source URL attribution
  - no docs are written into working repos during normal operation

## Assumptions

- The new tool is a fresh standalone TypeScript project with its own package and release process.
- Local-only means no hosted registry, no sync to remote storage, and no cross-machine sharing in v1.
- Existing fetched Markdown is not treated as a compatibility surface; the new crawler/spec system becomes the single canonical path immediately.
- MCP is explicitly deferred until after CLI fetch/search behavior is stable.
