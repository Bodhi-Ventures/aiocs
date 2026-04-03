# Git Repo Sources Design

## Summary

`aiocs` should support full external repository references as a first-class source type, not as a workaround layered on top of website docs fetching.

This feature adds a new `git` source kind that lets `aiocs`:

- mirror selected repositories into local managed storage
- snapshot them by commit SHA
- index curated subsets of files for lexical and hybrid retrieval
- link those repo sources to multiple local projects the same way docs sources are linked today

The goal is to give agents one shared local reference catalog for both documentation and curated external codebases, without copying those repos into every project or pretending repo code is website content.

The first real bundled test source for this feature should be:

- `https://github.com/nktkas/hyperliquid`

This repo is a good validation target because it is:

- public
- actively maintained
- TypeScript-only
- structured as a real SDK, not just markdown docs
- directly relevant to current `aiocs` users working with Hyperliquid

## Goals

- add a first-class `git` source kind to `aiocs`
- reuse the existing source, snapshot, project-link, search, diff, backup, and MCP surfaces where possible
- make external repo references reusable across many local projects from one shared catalog
- preserve `aiocs` as the canonical source-of-truth for acquisition, snapshotting, freshness, and ranking
- keep lexical SQLite FTS as the primary retrieval path, with hybrid/vector retrieval as an optional layer on top
- support curated full-repo references through include/exclude rules
- ship one bundled repo source for validation: `nktkas/hyperliquid`

## Non-Goals

- no replacement of SocratiCode for deep code intelligence, dependency graphs, or local codebase ownership analysis
- no repo dependency auto-detection or auto-sync from `package.json`, `Cargo.toml`, or other manifests
- no full local working tree checkout inside user projects
- no indexing of binary assets, vendored blobs, or generated build outputs
- no SSH-specific git auth in the first phase
- no attempt to treat arbitrary repos as markdown docs

## Current State

`aiocs` today is optimized for website-backed documentation sources:

- source specs describe discovery, extraction, normalization, auth, and canaries for websites
- successful fetches produce immutable snapshots
- snapshots are indexed into SQLite FTS5 and optional Qdrant vectors
- project links scope search to selected sources
- diffs, canaries, backups, and Docker refresh already exist

This architecture is already close to what repo references need. The missing pieces are:

- a repo acquisition model instead of browser crawling
- commit-based snapshot identity
- repo/file-aware metadata
- code-aware chunking
- repo-aware search filters

## Chosen Design

### 1. Add a first-class `git` source kind

Source specs gain an explicit discriminator:

```yaml
kind: git
id: nktkas-hyperliquid
label: nktkas/hyperliquid
repo:
  url: https://github.com/nktkas/hyperliquid.git
  branch: main
  include:
    - README.md
    - docs/**
    - src/**
    - tests/**
    - package.json
    - deno.json
  exclude:
    - .git/**
    - node_modules/**
    - dist/**
    - coverage/**
    - .github/**
schedule:
  everyHours: 24
```

The `kind` field becomes required for new specs. Existing bundled and local docs specs default to `kind: web` during migration so current sources remain valid.

### 2. Use local bare mirrors as acquisition caches

For each `git` source, `aiocs` stores a local mirror under `~/.aiocs/data/git-mirrors/<source-id>.git`.

This mirror is:

- not the canonical source of truth
- not linked into user repos
- only a fetch cache used to materialize snapshots

`refresh due <source-id>` for a `git` source performs:

1. clone mirror if missing
2. fetch the configured branch/tags into the mirror
3. resolve the target commit SHA
4. if commit SHA is unchanged from the latest successful snapshot and config hash is unchanged, reuse the existing snapshot
5. otherwise materialize and index a new snapshot

This preserves the same “immutable snapshot” model `aiocs` already uses for websites.

### 3. Snapshot identity is commit-based

For `git` sources, a successful snapshot should record:

- `sourceId`
- `snapshotId`
- `repoUrl`
- `branch`
- `commitSha`
- `commitTimestamp`
- optional `commitMessage`

Snapshot reuse logic should include:

- commit SHA
- source config hash
- include/exclude rules
- chunking config

That means a new snapshot is created when:

- the tracked commit changes
- or the source definition changes in a way that affects indexed content

### 4. File selection must be curated

Repo indexing quality depends heavily on filtering.

For `git` sources, curated `include` and `exclude` globs are mandatory design inputs, even if the schema allows reasonable defaults.

Default exclusions should always include:

- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- `coverage/**`
- `vendor/**`
- `*.min.*`
- binary and large asset extensions

Default inclusions should not blindly mean “everything text-like.” The repo owner or curator should choose the reference surface intentionally.

For the first bundled source (`nktkas/hyperliquid`), the initial bundled spec should focus on:

- `README.md`
- `docs/**`
- `src/**`
- selective `tests/**` only if useful for behavior reference
- key manifest/config files

### 5. Treat repo files as first-class snapshot pages

The existing catalog model already stores pages and chunks. For `git` sources, each indexed file becomes a page.

Recommended page mapping:

- `pageUrl`: canonical blob URL for the commit, for example `https://github.com/nktkas/hyperliquid/blob/<sha>/src/...`
- `pageTitle`: repo-relative file path
- `sectionTitle`: symbol name, heading, or line-window label
- `markdown`: normalized text representation used for retrieval

This keeps the current retrieval and `show` surfaces mostly intact.

### 6. Chunking must be file-type aware

Do not use website-heading chunking for all repo files.

Recommended chunking policy:

- Markdown files:
  - reuse the current heading-aware markdown chunker
- TypeScript / JavaScript:
  - prefer symbol-aware chunking where possible
  - chunk around exported functions, classes, interfaces, types, constants, and methods
  - fall back to bounded line-window chunks if symbol extraction fails
- JSON / config files:
  - keep small files whole
  - split large files by top-level object/key boundaries where practical
- Other text files:
  - bounded line-window chunking with overlap

The first implementation does not need full language support for every ecosystem. It should be production-grade for the first bundled repo and have safe fallback chunking for unsupported text formats.

### 7. Keep lexical search primary and add repo-aware filters

The current search modes remain:

- `lexical`
- `hybrid`
- `semantic`
- `auto`

Repo sources should add new search filters:

- `path`
- `language`

These should be exposed through both CLI and MCP. Example:

```bash
docs --json search "order signing" --source nktkas-hyperliquid --path src --mode hybrid
docs --json search "WebSocketTransport" --source nktkas-hyperliquid --lang typescript --mode lexical
```

Search defaults remain unchanged:

- lexical is best for identifiers and exact symbols
- hybrid is best for conceptual queries
- auto uses hybrid when embeddings are healthy

### 8. Project linking should work unchanged

Repo sources should reuse the existing project link model:

```bash
docs project link /absolute/path/to/project nktkas-hyperliquid
```

That gives multiple local projects one shared external-code reference source without duplicated clones or duplicated indexing.

This is one of the main reasons to keep the feature inside `aiocs` rather than bolting it onto per-project tooling.

### 9. Diffs become more valuable for repo sources

The existing snapshot diff surface should work for `git` sources, but with repo-aware semantics:

- added files
- removed files
- changed files
- unchanged files

Where practical, changed-file entries should include:

- path
- before and after line change counts
- before and after page titles if they differ

This lets agents answer:

- “what changed in this shared reference repo since yesterday?”
- “did the SDK add a new order type helper?”

### 10. Backups should exclude mirror caches

The local git mirror is a fetch cache, not canonical state.

Backups should continue to preserve:

- catalog database
- snapshots
- chunk/index metadata
- project links
- source definitions

But they should not depend on backing up `git-mirrors/`. Mirrors can be rebuilt after restore.

### 11. Auth model

First-phase auth should support:

- public HTTPS repos
- private HTTPS repos using env-backed tokens in the source spec

Example:

```yaml
repo:
  url: https://github.com/acme/private-sdk.git
  branch: main
  auth:
    tokenFromEnv: GITHUB_TOKEN
```

SSH auth is explicitly deferred.

## First Validation Source

The first bundled `git` source should be:

- id: `nktkas-hyperliquid`
- repo: `https://github.com/nktkas/hyperliquid.git`

Why this repo:

- it is directly useful to existing Hyperliquid-related agent work
- it has a clean TypeScript SDK structure (`src`, `docs`, `tests`, `README`)
- it exercises repo-aware chunking in a realistic codebase
- it gives a concrete, shared external-code reference that multiple projects can link immediately

The bundled spec should live in:

- `sources/nktkas-hyperliquid.yaml`

It should coexist with the existing bundled `hyperliquid` website-docs source, not replace it.

That gives agents two complementary sources:

- official docs source
- community SDK code source

## Risks

- repo indexing can degrade result quality badly if include/exclude rules are too loose
- code-aware chunking is more complex than markdown heading chunking
- cloning and snapshotting repos introduces more disk usage than website docs
- private-repo auth needs careful secret handling even with env-backed tokens
- large repos can create embedding backlog pressure

## Acceptance Criteria

- `aiocs` supports a new `git` source kind
- a `git` source can be upserted, fetched, snapshotted, diffed, searched, and project-linked through the existing CLI/MCP surfaces
- commit-based snapshot reuse works when the tracked commit and config are unchanged
- repo results expose path-aware metadata and canonical blob URLs
- CLI and MCP search support `path` and `language` filters
- backups remain valid without depending on git mirror caches
- `sources/nktkas-hyperliquid.yaml` ships as the first bundled repo source
- the first real validation proves that multiple local projects can link and search the same external repo source without copying it into each repo

## Follow-Up

After the initial `git` source support lands and stabilizes:

- consider optional symbol-aware enrichment for more languages
- consider exposing latest `git` snapshots into SocratiCode for mixed code-plus-doc retrieval
- consider optional branch/tag pinning strategies for repos that should track releases instead of `main`
