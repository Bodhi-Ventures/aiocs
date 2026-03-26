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
    "message": "Chunk 42 not found"
  }
}
```

Envelope fields:

- `ok`: `true` when the command executed and returned data, `false` when command execution failed
- `command`: stable command identifier such as `source.list`, `refresh.due`, `doctor`, or `init`
- `data`: command-specific payload on success
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
- `refresh due`
- `snapshot list`
- `project link`
- `project unlink`
- `search`
- `show`

## Command payloads

This section documents the stable top-level `data` payload per command.

### `version`

```json
{
  "name": "aiocs",
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
    "checkCount": 5,
    "passCount": 5,
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
      "lastCheckedAt": "2026-03-26T10:00:00.000Z",
      "lastSuccessfulSnapshotId": "snp_..."
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

### `search`

```json
{
  "query": "maker flow",
  "results": [
    {
      "chunkId": 42,
      "sourceId": "hyperliquid",
      "snapshotId": "snp_...",
      "pageUrl": "https://example.dev/docs/maker-flow",
      "pageTitle": "Maker flow",
      "sectionTitle": "Order lifecycle",
      "markdown": "# Order lifecycle\n..."
    }
  ]
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
{"type":"daemon.cycle.completed","reason":"startup","result":{"startedAt":"2026-03-26T00:00:00.000Z","finishedAt":"2026-03-26T00:00:10.000Z","dueSourceIds":[],"bootstrapped":{"processedSpecCount":5,"removedSourceIds":[],"sources":[]},"refreshed":[],"failed":[]}}
{"type":"daemon.stopped"}
```

## MCP relationship

The `aiocs-mcp` server does not reuse the CLI envelope. MCP tool calls return structured MCP tool results, but the underlying payloads are intentionally aligned with the same data shapes documented above.
