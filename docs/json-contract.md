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
- `workspace create`
- `workspace configure`
- `workspace list`
- `workspace bind`
- `workspace unbind`
- `workspace compile`
- `workspace queue-run`
- `workspace status`
- `workspace search`
- `workspace ingest add`
- `workspace ingest list`
- `workspace ingest show`
- `workspace ingest search`
- `workspace ingest remove`
- `workspace artifact list`
- `workspace artifact show`
- `workspace lint`
- `workspace output`
- `workspace answer`
- `workspace sync obsidian`
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
  "version": "0.1.1"
}
```

### `init`

```json
{
  "sourceSpecDirs": [
    "/absolute/path/to/aiocs/sources",
    "<home>/.aiocs/sources"
  ],
  "userSourceDir": "<home>/.aiocs/sources",
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
    "checkCount": 11,
    "passCount": 11,
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
- `git`
- `playwright`
- `daemon-config`
- `source-spec-dirs`
- `freshness`
- `daemon-heartbeat`
- `lmstudio`
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
      "kind": "web",
      "specPath": "/absolute/path/to/spec.yaml",
      "label": "Hyperliquid",
      "nextDueAt": "2026-03-26T12:00:00.000Z",
      "isDue": false,
      "nextCanaryDueAt": "2026-03-26T06:00:00.000Z",
      "isCanaryDue": false,
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

### Workspace commands

Workspace commands manage derived wiki artifacts backed by canonical source snapshots and LM Studio compilation.

#### `workspace.create`

```json
{
  "workspace": {
    "id": "market-structure",
    "label": "Market Structure",
    "compilerProfile": {
      "provider": "lmstudio",
      "model": "google/gemma-4-26b-a4b",
      "temperature": 0.1,
      "topP": 0.9,
      "maxInputChars": 12000,
      "maxOutputTokens": 4096,
      "concurrency": 1
    },
    "defaultOutputFormats": ["report", "slides"]
  }
}
```

#### `workspace.list`

```json
{
  "workspaces": [
    {
      "id": "market-structure",
      "label": "Market Structure",
      "bindingCount": 2,
      "artifactCount": 5,
      "lastCompileStatus": "success"
    }
  ]
}
```

#### `workspace.bind` and `workspace.unbind`

```json
{
  "workspaceId": "market-structure",
  "sourceIds": ["hyperliquid", "nktkas-hyperliquid"]
}
```

#### `workspace.configure`

```json
{
  "workspace": {
    "id": "market-structure",
    "label": "Market Structure",
    "autoCompileEnabled": true
  }
}
```

#### `workspace.compile`

```json
{
  "workspaceId": "market-structure",
  "skipped": false,
  "sourceFingerprint": "sha256...",
  "changedSourceIds": ["hyperliquid"],
  "changedRawInputIds": [],
  "updatedArtifactPaths": [
    "derived/sources/hyperliquid/summary.md",
    "derived/concepts/hyperliquid.md",
    "derived/index.md"
  ],
  "artifactCount": 3,
  "compileRunId": "wrkcmp_..."
}
```

#### `workspace.queue-run`

```json
{
  "processedJobs": 1,
  "succeededJobs": [
    {
      "workspaceId": "market-structure",
      "sourceFingerprint": "sha256...",
      "changedSourceIds": ["hyperliquid"],
      "changedRawInputIds": []
    }
  ],
  "failedJobs": []
}
```

#### `workspace.status`

```json
{
  "workspace": {
    "id": "market-structure",
    "label": "Market Structure",
    "autoCompileEnabled": true
  },
  "bindings": [
    {
      "workspaceId": "market-structure",
      "sourceId": "hyperliquid",
      "createdAt": "2026-04-03T10:00:00.000Z"
    }
  ],
  "artifacts": [
    {
      "workspaceId": "market-structure",
      "path": "derived/index.md",
      "kind": "index",
      "stale": false,
      "chunkCount": 3
    }
  ],
  "compileJob": {
    "workspaceId": "market-structure",
    "status": "pending",
    "requestedSourceIds": ["hyperliquid"],
    "requestedRawInputIds": [],
    "requestedFingerprint": null
  },
  "rawInputs": [],
  "syncTargets": [],
  "questionRuns": [],
  "links": [],
  "graph": {
    "linkCount": 4,
    "brokenLinkCount": 0,
    "orphanArtifactCount": 0,
    "backlinkCount": 4,
    "relationCounts": {
      "explicit_link": 0,
      "derived_from": 1,
      "mentions": 1,
      "related_to": 2,
      "expands": 1,
      "index_entry": 2,
      "summary_of": 1,
      "concept_of": 1,
      "output_depends_on": 0
    },
    "mostLinkedArtifacts": [
      {
        "artifactPath": "derived/index.md",
        "incomingCount": 0,
        "outgoingCount": 2
      }
    ]
  },
  "lintSummary": {
    "status": "pass",
    "findingCount": 0,
    "staleArtifactCount": 0,
    "missingProvenanceCount": 0,
    "missingArtifactCount": 0,
    "brokenLinkCount": 0,
    "orphanArtifactCount": 0,
    "suggestedConceptCount": 0,
    "duplicateConceptCandidateCount": 0,
    "missingArticleCandidateCount": 0,
    "followUpQuestionCount": 0
  },
  "health": {
    "status": "healthy",
    "staleArtifactCount": 0,
    "pendingCompileJobs": 0,
    "failedCompileJobs": 0,
    "brokenLinkCount": 0,
    "orphanArtifactCount": 0,
    "rawInputCount": 0,
    "lintFindingCount": 0,
    "duplicateConceptCandidateCount": 0,
    "missingArticleCandidateCount": 0,
    "followUpQuestionCount": 0
  },
  "compileRuns": [
    {
      "id": "wrkcmp_...",
      "status": "success"
    }
  ]
}
```

#### `workspace.ingest.*`

```json
{
  "workspaceId": "market-structure",
  "rawInput": {
    "id": "csv-fills-abc123def0",
    "workspaceId": "market-structure",
    "kind": "csv",
    "label": "Fills CSV",
    "sourcePath": "/absolute/path/to/fills.csv",
    "storagePath": "raw/csv-fills-abc123def0/fills.csv",
    "extractedTextPath": "raw/csv-fills-abc123def0/fills.csv.txt",
    "contentHash": "sha256...",
    "chunkCount": 12
  }
}
```

Raw-input search returns:

```json
{
  "workspaceId": "market-structure",
  "query": "fee tier",
  "total": 1,
  "limit": 10,
  "offset": 0,
  "hasMore": false,
  "results": [
    {
      "rawInputId": "csv-fills-abc123def0",
      "kind": "csv",
      "label": "Fills CSV",
      "sectionTitle": "Fills CSV rows 1-2",
      "markdown": "...",
      "filePath": "fills.csv",
      "score": 0.42
    }
  ]
}
```

#### `workspace.search`

```json
{
  "workspaceId": "market-structure",
  "query": "transport design",
  "scope": "mixed",
  "limit": 10,
  "offset": 0,
  "hasMore": false,
  "modeRequested": "auto",
  "modeUsed": "hybrid",
  "total": 2,
  "results": [
    {
      "kind": "source",
      "scope": "source",
      "chunkId": 42,
      "sourceId": "nktkas-hyperliquid",
      "snapshotId": "snp_...",
      "pageUrl": "file://src/transports/websocket.ts",
      "pageTitle": "src/transports/websocket.ts",
      "sectionTitle": "WebSocketTransport",
      "markdown": "...",
      "pageKind": "file",
      "filePath": "src/transports/websocket.ts",
      "language": "typescript",
      "score": 0.91,
      "signals": ["lexical", "vector"]
    },
    {
      "kind": "derived",
      "scope": "derived",
      "artifactPath": "derived/concepts/nktkas-hyperliquid.md",
      "artifactKind": "concept",
      "sectionTitle": "Transport design",
      "markdown": "...",
      "stale": false,
      "score": 0.74
    }
  ]
}
```

#### `workspace.artifact.list`

```json
{
  "workspaceId": "market-structure",
  "artifacts": [
    {
      "workspaceId": "market-structure",
      "path": "derived/index.md",
      "kind": "index",
      "stale": false,
      "chunkCount": 3
    }
  ]
}
```

#### `workspace.artifact.show`

```json
{
  "workspaceId": "market-structure",
  "artifact": {
    "workspaceId": "market-structure",
    "path": "derived/index.md",
    "kind": "index",
    "stale": false
  },
  "content": "# Workspace Index\n...",
  "provenance": [
    {
      "workspaceId": "market-structure",
      "path": "derived/index.md",
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "chunkIds": [42, 43]
    }
  ],
  "rawInputProvenance": []
}
```

#### `workspace.lint`

```json
{
  "workspaceId": "market-structure",
  "summary": {
    "status": "warn",
    "findingCount": 1,
    "staleArtifactCount": 1,
    "missingProvenanceCount": 0,
    "missingArtifactCount": 0,
    "brokenLinkCount": 0,
    "orphanArtifactCount": 0,
    "suggestedConceptCount": 0,
    "duplicateConceptCandidateCount": 1,
    "missingArticleCandidateCount": 1,
    "followUpQuestionCount": 2
  },
  "findings": [
    {
      "kind": "stale-artifact",
      "severity": "warn",
      "summary": "Artifact provenance points at an older snapshot.",
      "artifactPath": "derived/sources/hyperliquid/summary.md"
    },
    {
      "kind": "follow-up-question-suggestion",
      "severity": "warn",
      "summary": "What important workflows, caveats, or open questions remain unresolved for derived/concepts/hyperliquid.md?",
      "artifactPath": "derived/concepts/hyperliquid.md"
    }
  ],
  "suggestionsArtifactPath": "outputs/suggestions/lint.md"
}
```

#### `workspace.output`

```json
{
  "workspaceId": "market-structure",
  "format": "report",
  "path": "outputs/reports/weekly-brief.md",
  "artifactCount": 8
}
```

#### `workspace.answer`

```json
{
  "workspaceId": "market-structure",
  "format": "note",
  "path": "derived/notes/websocket-note.md",
  "artifactCount": 9,
  "questionRun": {
    "id": "wrkq_...",
    "workspaceId": "market-structure",
    "question": "What changed in websocket transport?",
    "format": "note",
    "artifactPath": "derived/notes/websocket-note.md",
    "status": "success"
  }
}
```

#### `workspace.sync.obsidian`

```json
{
  "workspaceId": "market-structure",
  "vaultPath": "/absolute/path/to/vault",
  "targetPath": "/absolute/path/to/vault/aiocs/market-structure",
  "exportSubdir": "aiocs/market-structure"
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
      "title": "New page",
      "pageKind": "document",
      "filePath": null,
      "language": null
    }
  ],
  "removedPages": [],
  "changedPages": [
    {
      "url": "https://example.dev/docs/start",
      "beforeTitle": "Start",
      "afterTitle": "Start",
      "pageKind": "document",
      "filePath": null,
      "language": null,
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
      "pageKind": "document",
      "filePath": null,
      "language": null,
      "markdown": "# Order lifecycle\n...",
      "score": 0.036,
      "signals": ["lexical", "vector"]
    }
  ]
}
```

`limit` defaults to `20`. `offset` defaults to `0`.
`pathPatterns` and `languages` narrow results for git/file sources and are also honored by MCP.

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
    "packageVersion": "0.1.1",
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
  "dataDir": "<home>/.aiocs/data",
  "configDir": "<home>/.aiocs/config",
  "manifest": {
    "formatVersion": 1,
    "createdAt": "2026-03-26T10:00:00.000Z",
    "packageVersion": "0.1.1",
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
    "pageKind": "document",
    "filePath": null,
    "language": null,
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
- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_ARTIFACT_NOT_FOUND`
- `WORKSPACE_ARTIFACTS_STALE`
- `WORKSPACE_COMPILER_CONFIG_INVALID`
- `WORKSPACE_COMPILER_UNAVAILABLE`
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
    "version": "0.1.1"
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
