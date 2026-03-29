# CLI JSON Contract

`aiocs` exposes a single-document JSON envelope for every one-shot CLI command when the root `--json` flag is present.

## One-shot command envelope

Successful commands write exactly one JSON object to stdout:

```json
{
  "ok": true,
  "command": "search",
  "data": {
    "results": []
  }
}
```

Failed commands still write exactly one JSON object to stdout and exit with status `1`:

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

Envelope fields:

- `ok`: `true` when the command executed and returned data, `false` when command execution failed
- `command`: stable command identifier such as `source.list`, `refresh.due`, `doctor`, or `init`
- `data`: command-specific payload on success
- `error.code`: stable machine-readable failure code
- `error.message`: stable human-readable error summary on failure
- `error.details`: optional extra machine-readable error context

## Supported one-shot commands

All of these support the root-level `--json` flag:

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

## Command payloads

This section documents the stable top-level `data` payload per command.

### `version`

```json
{
  "name": "@bodhi-ventures/aiocs",
  "version": "0.1.0"
}
```

### `init`

```json
{
  "sourceSpecDir": "/absolute/path/to/aiocs/sources",
  "fetched": false,
  "initializedSources": [
    {
      "sourceId": "hyperliquid",
      "specPath": "/absolute/path/to/aiocs/sources/hyperliquid.yaml",
      "configHash": "sha256...",
      "configChanged": false
    }
  ],
  "removedSourceIds": [],
  "fetchResults": []
}
```

### `doctor`

```json
{
  "summary": {
    "status": "healthy",
    "checkCount": 10,
    "passCount": 10,
    "warnCount": 0,
    "failCount": 0
  },
  "checks": [
    {
      "id": "catalog",
      "status": "pass",
      "summary": "Catalog opened successfully at ~/.aiocs/data",
      "details": {}
    }
  ]
}
```

Check ids are currently:

- `catalog`
- `playwright`
- `daemon-config`
- `source-spec-dirs`
- `freshness`
- `daemon-heartbeat`
- `embedding-provider`
- `vector-store`
- `embeddings`
- `docker`

Summary status values:

- `healthy`: no warnings or failures
- `degraded`: warnings but no failures
- `unhealthy`: at least one failed check

### `source.upsert`

```json
{
  "sourceId": "hyperliquid",
  "configHash": "sha256...",
  "specPath": "/absolute/path/to/spec.yaml"
}
```

### `source.list`

```json
{
  "sources": [
    {
      "id": "hyperliquid",
      "label": "Hyperliquid",
      "nextDueAt": "2026-03-26T12:00:00.000Z",
      "nextCanaryDueAt": "2026-03-26T06:00:00.000Z",
      "lastCheckedAt": "2026-03-26T10:00:00.000Z",
      "lastSuccessfulSnapshotAt": "2026-03-26T10:00:00.000Z",
      "lastSuccessfulSnapshotId": "snp_...",
      "lastCanaryCheckedAt": "2026-03-26T08:00:00.000Z",
      "lastSuccessfulCanaryAt": "2026-03-26T08:00:00.000Z",
      "lastCanaryStatus": "pass"
    }
  ]
}
```

### `fetch` and `refresh.due`

```json
{
  "results": [
    {
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "pageCount": 139,
      "reused": false
    }
  ]
}
```

### `canary`

```json
{
  "results": [
    {
      "sourceId": "hyperliquid",
      "status": "pass",
      "checkedAt": "2026-03-26T10:00:00.000Z",
      "summary": {
        "checkCount": 1,
        "passCount": 1,
        "failCount": 0
      },
      "checks": [
        {
          "url": "https://example.dev/docs/start",
          "status": "pass",
          "title": "Docs Start",
          "markdownLength": 120
        }
      ]
    }
  ]
}
```

### `snapshot.list`

```json
{
  "sourceId": "hyperliquid",
  "snapshots": [
    {
      "snapshotId": "snp_...",
      "sourceId": "hyperliquid",
      "detectedVersion": null,
      "createdAt": "2026-03-26T10:00:00.000Z",
      "pageCount": 139
    }
  ]
}
```

### `project.link` and `project.unlink`

```json
{
  "projectPath": "/absolute/path/to/project",
  "sourceIds": ["hyperliquid", "lighter"]
}
```

### `diff`

```json
{
  "sourceId": "hyperliquid",
  "fromSnapshotId": "snp_old",
  "toSnapshotId": "snp_new",
  "summary": {
    "addedPageCount": 1,
    "removedPageCount": 1,
    "changedPageCount": 2,
    "unchangedPageCount": 98
  },
  "addedPages": [
    {
      "url": "https://example.dev/docs/new-page",
      "title": "New page"
    }
  ],
  "removedPages": [],
  "changedPages": [
    {
      "url": "https://example.dev/docs/start",
      "beforeTitle": "Start",
      "afterTitle": "Start",
      "lineSummary": {
        "addedLineCount": 3,
        "removedLineCount": 2
      }
    }
  ]
}
```

### `search`

```json
{
  "query": "maker flow",
  "total": 42,
  "limit": 20,
  "offset": 0,
  "hasMore": true,
  "modeRequested": "auto",
  "modeUsed": "hybrid",
  "results": [
    {
      "chunkId": 42,
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "pageUrl": "https://example.dev/docs/maker-flow",
      "pageTitle": "Maker flow",
      "sectionTitle": "Order lifecycle",
      "markdown": "# Order lifecycle\n...",
      "score": 0.036,
      "signals": ["lexical", "vector"]
    }
  ]
}
```

`limit` defaults to `20`. `offset` defaults to `0`.

`modeRequested` is the requested search mode (`auto`, `lexical`, `hybrid`, `semantic`).
`modeUsed` is the actual executed mode after fallbacks. In `auto`, `aiocs` can degrade back to lexical if the vector layer is unavailable or incomplete for the requested scope.

### `embeddings.status`

```json
{
  "queue": {
    "pendingJobs": 0,
    "runningJobs": 0,
    "failedJobs": 0
  },
  "sources": [
    {
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "totalChunks": 420,
      "indexedChunks": 420,
      "pendingChunks": 0,
      "failedChunks": 0,
      "staleChunks": 0,
      "coverageRatio": 1
    }
  ]
}
```

### `embeddings.backfill`

```json
{
  "queuedJobs": 5
}
```

### `embeddings.clear`

```json
{
  "clearedSources": ["hyperliquid", "lighter"]
}
```

### `embeddings.run`

```json
{
  "processedJobs": 2,
  "succeededJobs": [
    {
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "chunkCount": 420
    }
  ],
  "failedJobs": []
}
```

### `verify.coverage`

```json
{
  "sourceId": "hyperliquid",
  "snapshotId": "snp_...",
  "complete": false,
  "summary": {
    "fileCount": 1,
    "headingCount": 100,
    "matchedHeadingCount": 99,
    "missingHeadingCount": 1,
    "matchCounts": {
      "pageTitle": 80,
      "sectionTitle": 15,
      "body": 4
    }
  },
  "files": [
    {
      "referenceFile": "/absolute/path/to/reference.md",
      "headingCount": 100,
      "matchedHeadingCount": 99,
      "missingHeadingCount": 1,
      "missingHeadings": ["Missing Heading"],
      "matchCounts": {
        "pageTitle": 80,
        "sectionTitle": 15,
        "body": 4
      }
    }
  ]
}
```

### `backup.export`

```json
{
  "outputDir": "/absolute/path/to/backup",
  "manifestPath": "/absolute/path/to/backup/manifest.json",
  "manifest": {
    "formatVersion": 1,
    "createdAt": "2026-03-26T10:00:00.000Z",
    "packageVersion": "0.1.0",
    "entries": [
      {
        "relativePath": "data/catalog.sqlite",
        "type": "file",
        "size": 32768
      }
    ]
  }
}
```

### `backup.import`

```json
{
  "inputDir": "/absolute/path/to/backup",
  "dataDir": "/Users/example/.aiocs/data",
  "configDir": "/Users/example/.aiocs/config",
  "manifest": {
    "formatVersion": 1,
    "createdAt": "2026-03-26T10:00:00.000Z",
    "packageVersion": "0.1.0",
    "entries": []
  }
}
```

### `show`

```json
{
  "chunk": {
    "chunkId": 42,
    "sourceId": "hyperliquid",
    "snapshotId": "snp_...",
    "pageUrl": "https://example.dev/docs/maker-flow",
    "pageTitle": "Maker flow",
    "sectionTitle": "Order lifecycle",
    "markdown": "# Order lifecycle\n..."
  }
}
```

## Daemon event stream

`docs daemon --json` is intentionally different because the process is long-running. It emits newline-delimited JSON events to stdout rather than a single envelope.

Current event types:

- `daemon.started`
- `daemon.cycle.started`
- `daemon.cycle.completed`
- `daemon.stopped`

Example:

```json
{"type":"daemon.started","intervalMinutes":60,"fetchOnStart":true,"sourceSpecDirs":["/app/sources"]}
{"type":"daemon.cycle.started","reason":"startup","startedAt":"2026-03-26T00:00:00.000Z"}
{"type":"daemon.cycle.completed","reason":"startup","result":{"startedAt":"2026-03-26T00:00:00.000Z","finishedAt":"2026-03-26T00:00:10.000Z","dueSourceIds":[],"bootstrapped":{"processedSpecCount":5,"removedSourceIds":[],"sources":[]},"refreshed":[],"failed":[],"embedded":[],"embeddingFailed":[]}}
{"type":"daemon.stopped"}
```

## Error codes

Current stable CLI error codes include:

- `INVALID_ARGUMENT`
- `SOURCE_NOT_FOUND`
- `SNAPSHOT_NOT_FOUND`
- `NO_PAGES_FETCHED`
- `NO_PROJECT_SCOPE`
- `CHUNK_NOT_FOUND`
- `REFERENCE_FILE_NOT_FOUND`
- `INVALID_REFERENCE_FILE`
- `EMBEDDING_CONFIG_INVALID`
- `EMBEDDING_PROVIDER_UNAVAILABLE`
- `VECTOR_STORE_UNAVAILABLE`
- `EMBEDDING_JOB_NOT_FOUND`
- `INTERNAL_ERROR`

## MCP relationship

The `aiocs-mcp` server uses the same underlying payloads, but wraps them in a structured MCP envelope:

Successful MCP tool results:

```json
{
  "ok": true,
  "data": {
    "name": "@bodhi-ventures/aiocs",
    "version": "0.1.0"
  }
}
```

Failed MCP tool results:

```json
{
  "ok": false,
  "error": {
    "code": "CHUNK_NOT_FOUND",
    "message": "Chunk 42 not found"
  }
}
```

The MCP `search` tool supports the same `limit` and `offset` fields as the CLI. The MCP server also exposes:

- `embeddings_status`
- `embeddings_backfill`
- `embeddings_clear`
- `embeddings_run`
- `verify_coverage`
- `batch`

`batch` returns one result object per requested operation, each with its own `ok`, `data`, or `error` fields.
