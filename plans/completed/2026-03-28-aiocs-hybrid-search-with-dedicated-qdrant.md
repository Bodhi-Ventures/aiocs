# aiocs Hybrid Search With Dedicated Qdrant

Date: 2026-03-28

## Objective

Implement hybrid search inside `aiocs` using:

- SQLite FTS5/BM25 as the primary lexical index
- a dedicated `aiocs-qdrant` container as the vector backend
- local Ollama embeddings
- RRF fusion for hybrid ranking

The feature must preserve `aiocs` as the source of truth for docs lifecycle and ranking policy.

## Current State

- `aiocs` search is lexical only in `src/catalog/catalog.ts`
- `docs daemon` handles fetch/canary work but has no embedding/index worker
- there is no Qdrant runtime, embedding config, or derived vector state
- CLI and MCP expose only lexical search
- backups cover SQLite/config only

## Scope

### In scope

- embedding config and runtime parsing
- dedicated `aiocs-qdrant` docker service
- Ollama embedding client via official HTTP API
- SQLite tracking for embedding models, state, and jobs
- daemon embedding worker
- latest-snapshot-only vector policy
- `lexical|hybrid|semantic|auto` search modes
- hybrid retrieval via BM25 + Qdrant + RRF
- doctor checks for Qdrant/Ollama/coverage/backlog
- CLI/MCP surfaces for search mode and embedding operations
- restore path that rebuilds vectors from SQLite state
- tests/docs for the full feature

### Out of scope

- reusing SocratiCode Qdrant collections
- vector backup/restore
- cross-code/docs unified retrieval
- remote embeddings or hosted vector infra

## Design Constraints

- Keep SQLite as the canonical store for sources, snapshots, pages, chunks, and operational metadata
- Treat vectors as derived state only
- Do not weaken exact source/project/snapshot scoping
- Search must fall back cleanly to lexical mode when vector infra is unavailable
- Keep the current CLI/MCP JSON contract style

## Implementation Plan

### 1. Catalog and config model

- Extend the catalog schema with:
  - `embedding_models`
  - `embedding_state`
  - `embedding_jobs`
- Add runtime config parsing for:
  - Qdrant URL / collection
  - Ollama base URL / model
  - default search mode
  - embedding batch size
  - embedding jobs per daemon cycle
- Add doctor-facing typed status accessors

### 2. Embedding runtime

- Add a Qdrant client module using `@qdrant/js-client-rest`
- Add an Ollama embedding module using `POST /api/embed`
- Add deterministic vector id generation
- Add helpers for:
  - collection bootstrap
  - chunk embedding/upsert
  - snapshot cleanup of stale latest vectors

### 3. Snapshot lifecycle integration

- When a successful snapshot is recorded:
  - mark old latest vectors stale for that source
  - enqueue embedding work for the new latest snapshot
- When sources or snapshots are removed:
  - queue vector cleanup
- When backups are imported:
  - mark embeddings stale
  - enqueue rebuild for latest snapshots

### 4. Daemon worker

- Extend the daemon cycle to process a bounded number of embedding jobs
- Keep fetch/canary behavior intact
- Persist failures/backoff through SQLite job state
- Reflect degraded/failure status in heartbeat if embedding work breaks when hybrid is expected

### 5. Search path

- Extend search options with `mode`
- Keep current lexical query path intact
- Add semantic query path via Qdrant constrained by authoritative SQLite scope
- Add hybrid path:
  - lexical candidate set
  - vector candidate set
  - RRF fusion
- Return search metadata indicating the effective mode and whether fallback occurred

### 6. CLI and MCP

- Extend `docs search` with `--mode`
- Add:
  - `docs embeddings status`
  - `docs embeddings backfill <source-id|all>`
  - `docs embeddings clear <source-id|all>`
- Extend MCP with equivalent tools

### 7. Docker and docs

- Add `aiocs-qdrant` to `docker-compose.yml`
- Add daemon env wiring for Qdrant/Ollama
- Document:
  - hybrid modes
  - vector lifecycle
  - health behavior
  - restore/rebuild behavior

## Acceptance Checks

- `docs search --mode lexical` preserves current behavior
- `docs search --mode auto` uses hybrid when vectors are ready and lexical fallback when not
- hybrid search respects source/project/snapshot scoping
- daemon can build vectors for latest snapshots without blocking fetch success
- doctor reports Qdrant/Ollama/coverage/backlog health
- backup import does not require vector state and triggers rebuild behavior
- Docker compose includes a dedicated `aiocs-qdrant` service

## Verification

- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `npm pack --dry-run`
- `docker compose config`
- targeted CLI/MCP hybrid search smoke tests

## Risks To Watch

- BM25/vector fusion regressions
- embedding backlog growth
- vector/state drift after latest-snapshot changes
- accidental weakening of exact source/project filters
