# AI Agent JSON CLI And Daemon Design

## Summary

`aiocs` will add a machine-oriented JSON contract across the CLI and a first-class long-running daemon mode for scheduled refreshes. The CLI remains human-friendly by default, but every command will support a global `--json` flag so agents can consume one stable structured payload instead of parsing text. The daemon will live inside the same binary as `docs daemon`, and a Docker image will run that command in a loop with environment-configured cadence.

## Goals

- make every one-shot CLI command safe for direct agent use
- keep a single canonical implementation path inside the existing CLI
- avoid introducing a separate HTTP service or second control plane
- support a long-running local container that keeps the shared catalog warm

## Non-Goals

- MCP in this change
- remote registries or distributed scheduling
- a second machine API beyond the CLI

## JSON Output Contract

### Scope

`--json` is a root-level global flag that applies to every CLI command.

### One-shot commands

These commands emit exactly one JSON document to stdout:

- `source upsert`
- `source list`
- `fetch`
- `refresh due`
- `snapshot list`
- `project link`
- `project unlink`
- `search`
- `show`

### Envelope

Every command returns:

```json
{
  "ok": true,
  "command": "source.list",
  "data": {}
}
```

Failures also emit a single JSON document to stdout, with exit code `1`:

```json
{
  "ok": false,
  "command": "search",
  "error": {
    "message": "No linked project scope found. Use --source or --all."
  }
}
```

### Command payloads

- `source.upsert`: upserted source metadata
- `source.list`: array of sources with due/snapshot fields
- `fetch`: array of per-source fetch results, even for a single source
- `refresh.due`: array of per-source fetch results; empty array when nothing is due
- `snapshot.list`: array of snapshots
- `project.link`: canonical project path and linked source ids
- `project.unlink`: canonical project path and removed scope
- `search`: array of chunk results
- `show`: one chunk result

### Daemon exception

`docs daemon` is long-running, so a single final JSON document is the wrong shape. In JSON mode it will emit newline-delimited JSON event objects to stdout, one event per lifecycle action. This is the one intended exception to the single-document rule.

## Daemon Design

### Command

Add `docs daemon`.

### Responsibilities

- ensure config and data directories exist
- optionally bootstrap source specs from configured directories
- optionally run an immediate refresh cycle on startup
- loop forever:
  - upsert any source spec files from configured directories
  - run refresh for due sources
  - sleep until the next cycle

### Environment variables

- `AIOCS_DAEMON_INTERVAL_MINUTES`
  - required positive integer semantics, default `60`
- `AIOCS_DAEMON_FETCH_ON_START`
  - `true` by default
- `AIOCS_SOURCE_SPEC_DIRS`
  - comma-separated list of directories to scan for `.yaml`, `.yml`, and `.json` source specs
  - default points at the bundled `sources/` directory in the image and local repo

### Logging

- human mode: concise single-line operational logs
- JSON mode: one JSON event per line with `event`, `timestamp`, and event-specific fields

### Failure model

- invalid env config fails fast at startup
- invalid source spec files fail the cycle and are logged explicitly
- fetch failures for one source do not kill the daemon process unless startup config is invalid

## Docker Design

### Image

Ship a Dockerfile that builds `aiocs`, includes the bundled `sources/` directory, and runs:

```bash
./dist/cli.js daemon
```

### Runtime contract

- mount persistent data to `/root/.aiocs/data` or provide `AIOCS_DATA_DIR`
- optional config mount for `/root/.aiocs/config`
- source specs available from bundled `/app/sources` by default
- allow overriding `AIOCS_SOURCE_SPEC_DIRS` with mounted custom directories

### Compose

Ship a compose example that:

- builds the image locally
- mounts a persistent volume for the data directory
- sets `AIOCS_DAEMON_INTERVAL_MINUTES`
- optionally mounts a host directory of custom source specs

## Testing Strategy

- CLI tests for `--json` across representative commands and failure paths
- unit tests for daemon env parsing and cycle behavior
- integration tests for daemon bootstrap + due refresh behavior with a short injected interval
- existing CLI/fetch regression suite stays green in human mode

## Risks And Mitigations

- daemon JSON logs differ from one-shot JSON
  - mitigate by documenting daemon as the explicit streaming exception
- source spec drift inside long-running containers
  - mitigate by re-upserting source specs each cycle
- duplicated output logic across commands
  - mitigate by centralizing response/error emission in one CLI output path
