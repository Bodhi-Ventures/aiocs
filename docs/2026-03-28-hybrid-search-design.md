# aiocs Hybrid Search Design

Date: 2026-03-28

## Goal

Add hybrid retrieval to `aiocs` so agents get better docs results for fuzzy and conceptual queries without weakening the current source/snapshot semantics.

This design keeps `aiocs` as the canonical docs system:

- `aiocs` owns fetching, normalization, chunking, snapshots, canaries, diffs, and ranking policy
- SQLite FTS5 remains the primary lexical index and source of truth
- a dedicated `aiocs-qdrant` container stores only derived embedding vectors for `aiocs`
- local Ollama generates embeddings
- SocratiCode remains separate and may later consume selected `aiocs` snapshots, but it is not the runtime for `aiocs` hybrid search

## Non-Goals

- No replacement of SQLite FTS5 with vector-only search
- No reuse of SocratiCode's Qdrant collection or deployment
- No new hosted service or remote dependency
- No cross-repo code search in this phase
- No backup/restore of vector state; vectors are rebuildable

## Why This Shape

The current `aiocs` search path in [catalog.ts](../src/catalog/catalog.ts) is pure FTS5 BM25 over the latest successful snapshots. That is excellent for exact docs lookups, versioned terms, and API names. It is weaker for:

- synonym-heavy prompts
- conceptual questions
- vague agent prompts
- recall across wording shifts in docs

Hybrid retrieval is the right improvement, but the ranking policy must remain docs-aware. That is why `aiocs` itself should own the hybrid query plan instead of delegating search semantics to a generic vector layer.

## Recommended Architecture

### 1. Canonical storage remains SQLite

SQLite remains the system of record for:

- sources
- snapshots
- pages
- chunks
- project links
- fetch/canary/daemon metadata

Add embedding-specific metadata tables in the same catalog:

- `embedding_models`
- `embedding_jobs`
- `embedding_state`

These track derived vector work, not source content.

### 2. Dedicated `aiocs-qdrant`

Ship a separate Qdrant container in `aiocs/docker-compose.yml`:

- service name: `aiocs-qdrant`
- dedicated persistent volume
- default local URL from `aiocs` runtime

This container is strictly for `aiocs`. It must not share collections or lifecycle with SocratiCode.

### 3. Ollama as embedding provider

Use Ollama locally for embeddings, with explicit config:

- provider: `ollama`
- model: configurable
- default model chosen from the local setup you already use for embeddings

`aiocs` should own its own embedding config even if the model matches SocratiCode.

### 4. Hybrid retrieval strategy

Search modes:

- `lexical`
- `hybrid`
- `semantic`
- `auto`

Default: `auto`

Behavior:

- if vector infra is healthy and the target scope has embeddings, use hybrid
- otherwise fall back to lexical

Hybrid query plan:

1. Run FTS5 BM25 against SQLite
2. Run vector similarity search in Qdrant
3. Fuse result sets with Reciprocal Rank Fusion
4. Return the existing `aiocs` chunk shape plus hybrid metadata

RRF is preferred over weighted score mixing because:

- BM25 and cosine/dot-product scores are not directly comparable
- RRF is robust across model swaps
- RRF is simple and stable for agents

## Data Model

### SQLite additions

#### `embedding_models`

Tracks the embedding configuration currently in use.

Columns:

- `id`
- `provider`
- `model`
- `dimension`
- `distance_metric`
- `created_at`
- `active`

#### `embedding_state`

Tracks per-chunk embedding lifecycle.

Columns:

- `chunk_id`
- `source_id`
- `snapshot_id`
- `embedding_model_id`
- `content_hash`
- `vector_id`
- `status` (`pending`, `embedded`, `stale`, `failed`)
- `last_embedded_at`
- `last_error`

This avoids guessing whether a vector is current.

#### `embedding_jobs`

Persistent queue for background embedding work.

Columns:

- `id`
- `source_id`
- `snapshot_id`
- `job_type` (`snapshot_latest`, `snapshot_remove`, `reindex_model`)
- `status` (`pending`, `running`, `failed`, `completed`)
- `attempt_count`
- `last_error`
- `created_at`
- `started_at`
- `finished_at`

This queue is important because embedding is slower and more failure-prone than lexical indexing.

### Qdrant payload

Each vector point stores:

- `chunk_id`
- `source_id`
- `snapshot_id`
- `page_url`
- `page_title`
- `section_title`
- `embedding_model_id`
- `content_hash`
- `is_latest_snapshot`

The point id should be stable and deterministic per chunk/model, for example:

- `${embedding_model_id}:${chunk_id}:${content_hash}`

That makes reindexing idempotent.

## Indexing Lifecycle

### Snapshot write path

When `recordSuccessfulSnapshot()` writes chunks:

1. normal SQLite snapshot/page/chunk write happens first
2. `aiocs` marks the new latest snapshot as requiring embeddings
3. an embedding job is enqueued

The fetch path must not block on embedding completion. Search must continue working lexically even with zero vectors.

### Latest-only vector policy

For this phase, vectors should be generated only for the latest successful snapshot per source.

Rationale:

- minimizes vector volume
- aligns with how current `search()` already targets latest successful snapshots by default
- avoids wasting GPU/CPU on historical snapshots rarely used in normal retrieval

Historical snapshot diffs remain SQLite-only.

If a source gets a new latest snapshot:

- mark prior latest vectors as stale
- enqueue cleanup/remove for stale vectors
- enqueue embedding for the new latest snapshot

### Embedding worker

Add an embedding worker loop to the daemon process:

- fetch/canary cycle remains unchanged in purpose
- after refresh work, process a bounded number of embedding jobs
- retry failed jobs with capped attempts and backoff

The daemon becomes the single operational background process for both freshness and vector health.

## Query Path

### Lexical path

Keep the existing query path as-is for:

- `searchMode=lexical`
- `searchMode=auto` when vectors are unavailable

### Semantic path

For `searchMode=semantic`:

1. embed the query with Ollama
2. query Qdrant with the same scope constraints
3. fetch result chunk records from SQLite by `chunk_id`
4. return ordered results

### Hybrid path

For `searchMode=hybrid`:

1. run lexical query for top `N`
2. run semantic query for top `K`
3. fuse with RRF
4. fetch canonical chunk data from SQLite
5. return result rows with mode metadata

Initial defaults:

- BM25 candidate window: `40`
- vector candidate window: `40`
- final page size: existing `limit`
- RRF `k`: `60`

These should be configurable, but not user-tuned in the first release.

## Filtering and Invariants

All source/snapshot/project scoping remains authoritative in `aiocs`, not in Qdrant.

The runtime must:

- resolve project scope in SQLite first
- resolve latest snapshot ids in SQLite first
- constrain vector retrieval to those snapshot ids

This preserves the current guarantee that source/project/snapshot filters are exact.

Qdrant is a retrieval backend, not a source of truth.

## CLI and MCP Changes

### CLI

Extend `docs search` with:

- `--mode lexical|hybrid|semantic|auto`

Add operational commands:

- `docs embeddings status`
- `docs embeddings backfill [source-id|all]`
- `docs embeddings clear [source-id|all]`

Optional later:

- `docs embeddings doctor`

### MCP

Extend `search` input with `mode`.

Add tools:

- `embeddings_status`
- `embeddings_backfill`
- `embeddings_clear`

The existing JSON envelope remains unchanged.

## Docker and Runtime

### `docker-compose.yml`

Add:

- `aiocs-qdrant`
- volume for Qdrant storage
- daemon env vars for Qdrant/Ollama config

The daemon container should depend on Qdrant health, not just startup ordering.

### Config

Add environment variables:

- `AIOCS_SEARCH_MODE_DEFAULT`
- `AIOCS_QDRANT_URL`
- `AIOCS_QDRANT_COLLECTION`
- `AIOCS_EMBEDDING_PROVIDER`
- `AIOCS_OLLAMA_BASE_URL`
- `AIOCS_OLLAMA_EMBEDDING_MODEL`
- `AIOCS_EMBEDDING_BATCH_SIZE`
- `AIOCS_EMBEDDING_JOB_LIMIT_PER_CYCLE`

Defaults should make local Docker + local Ollama work without extra ceremony.

## Doctor and Health

Extend `doctor` with new checks:

- `qdrant`
- `embedding-provider`
- `embedding-coverage`
- `embedding-backlog`

Examples:

- pass: vectors are healthy and mostly current
- warn: lexical search works, but vectors are unavailable or backlog is growing
- fail: `searchMode=hybrid` default is configured but vector infra is broken

## Backups

Backups remain SQLite/config only.

Do not export Qdrant state in `backup export`.

After `backup import`:

- mark embeddings stale
- enqueue re-embedding for current latest snapshots

This keeps backup semantics simple and avoids trying to synchronize two storage engines.

## Testing Strategy

### Unit

- query mode parsing
- embedding config validation
- RRF fusion
- deterministic vector id generation
- embedding-state transitions

### Integration

- snapshot creation enqueues embedding work
- daemon processes embedding jobs
- hybrid search falls back cleanly when vector infra is absent
- hybrid search respects source/project/snapshot filters
- `backup import` triggers rebuild behavior

### Docker/runtime

- compose config includes dedicated Qdrant service
- doctor reports degraded state when Qdrant is unreachable

## Migration Strategy

1. add schema and config surfaces
2. add Qdrant/Ollama client integration
3. add embedding queue and daemon worker
4. add hybrid query mode
5. add doctor/docs/tests

This keeps lexical search live throughout the rollout.

## Risks

### 1. Ranking regressions

Mitigation:

- lexical remains available
- `auto` falls back safely
- RRF instead of fragile score blending

### 2. Embedding backlog growth

Mitigation:

- latest-only vector policy
- bounded jobs per cycle
- explicit backlog health checks

### 3. Vector/schema drift

Mitigation:

- embedding model registry in SQLite
- deterministic point ids
- explicit stale/rebuild lifecycle

## Recommended Next Step

Turn this design into an execution plan and implement it in phases, starting with:

1. embedding config + schema
2. dedicated Qdrant runtime
3. daemon embedding worker
4. hybrid search mode
