# AI Agent JSON And Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a machine-readable `--json` mode to every `aiocs` CLI command and ship a first-class long-running `docs daemon` command with Docker-based scheduled refresh automation.

**Architecture:** Extend the existing CLI with one canonical output layer and one canonical daemon path. Keep human-readable output as the default, but route all command results through a structured response emitter. Run scheduled refresh inside the same binary with env-validated config and a Docker image that starts `docs daemon`.

**Tech Stack:** TypeScript, Commander, better-sqlite3, Playwright, Vitest, tsup, Docker

---

### Task 1: Define Durable Interfaces

**Files:**
- Create: `docs/2026-03-26-agent-json-and-daemon-design.md`
- Modify: `plans/active/2026-03-26-agent-json-and-daemon.md`

- [ ] **Step 1: Confirm the approved design is written**

Check that `docs/2026-03-26-agent-json-and-daemon-design.md` exists and captures the JSON envelope, daemon behavior, and Docker contract.

- [ ] **Step 2: Keep this plan aligned with implementation**

Update this plan if file locations or command names change during implementation.

### Task 2: Add Failing CLI JSON Tests

**Files:**
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write failing tests for `--json` success paths**

Add tests for representative commands such as:
- `source upsert --json`
- `source list --json`
- `fetch <source> --json`
- `refresh due --json`
- `search --json`
- `show --json`

Verify they expect a stable envelope with `ok`, `command`, and `data`.

- [ ] **Step 2: Write failing tests for `--json` failure paths**

Add tests for:
- unscoped `search --json` outside a linked project
- `show --json` on a missing chunk id

Verify they expect exit code `1` and a JSON error envelope.

- [ ] **Step 3: Run the CLI tests and confirm failure**

Run: `pnpm --dir <repo-root> test tests/cli/commands.test.ts`

Expected: FAIL because `--json` is not implemented.

### Task 3: Add Failing Daemon Tests

**Files:**
- Create: `tests/runtime/daemon.test.ts`

- [ ] **Step 1: Write failing tests for daemon env parsing**

Cover:
- default interval behavior
- invalid interval rejection
- boolean parsing for fetch-on-start
- source spec dir parsing

- [ ] **Step 2: Write failing tests for one daemon cycle**

Cover:
- bootstrapping source specs from a directory
- refreshing due sources
- skipping when nothing is due

Use temp dirs and the local test docs server where needed.

- [ ] **Step 3: Run the daemon tests and confirm failure**

Run: `pnpm --dir <repo-root> test tests/runtime/daemon.test.ts`

Expected: FAIL because daemon code does not exist yet.

### Task 4: Implement Shared CLI Output

**Files:**
- Create: `src/cli-output.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement a typed output/emission module**

Add helpers for:
- human success output
- JSON success output
- human error output
- JSON error output

Make it the single source of truth for CLI responses.

- [ ] **Step 2: Thread root-level `--json` through Commander**

Add a global option and make every command action emit through the new output helpers.

- [ ] **Step 3: Ensure one-shot commands emit one JSON document**

Return arrays for multi-result commands instead of line-by-line output in JSON mode.

- [ ] **Step 4: Run CLI tests**

Run: `pnpm --dir <repo-root> test tests/cli/commands.test.ts`

Expected: PASS for the JSON cases.

### Task 5: Implement Daemon Runtime

**Files:**
- Create: `src/daemon.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement daemon config parsing**

Parse and validate:
- `AIOCS_DAEMON_INTERVAL_MINUTES`
- `AIOCS_DAEMON_FETCH_ON_START`
- `AIOCS_SOURCE_SPEC_DIRS`

- [ ] **Step 2: Implement source spec bootstrap**

Scan configured directories for `.yaml`, `.yml`, and `.json` source specs and upsert them into the catalog.

- [ ] **Step 3: Implement one refresh cycle**

Run bootstrap, list due sources, fetch due sources, and collect structured result events.

- [ ] **Step 4: Implement the long-running loop**

Add `docs daemon` that:
- optionally runs a startup cycle immediately
- sleeps for the configured interval
- repeats cycles forever

- [ ] **Step 5: Run daemon tests**

Run: `pnpm --dir <repo-root> test tests/runtime/daemon.test.ts`

Expected: PASS.

### Task 6: Ship Docker Automation

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Modify: `package.json` if image-facing build scripts are helpful

- [ ] **Step 1: Add Docker build assets**

Create a Dockerfile that builds the CLI and starts `./dist/cli.js daemon`.

- [ ] **Step 2: Add compose example**

Create a compose service with persistent data storage and environment-driven daemon cadence.

- [ ] **Step 3: Validate file paths and defaults**

Make sure the image includes bundled `sources/` and uses the expected local storage paths.

### Task 7: Document Agent Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document `--json` mode**

Include examples for representative commands and explain the stable envelope.

- [ ] **Step 2: Document `docs daemon`**

Explain daemon env vars, startup behavior, and the Docker/compose workflow.

- [ ] **Step 3: Document agent recommendations**

State explicitly that local agents should prefer `--json` and that Docker keeps the shared catalog warm.

### Task 8: Full Verification

**Files:**
- Modify: `README.md` if verification docs need updates

- [ ] **Step 1: Run targeted CLI tests**

Run: `pnpm --dir <repo-root> test tests/cli/commands.test.ts`

- [ ] **Step 2: Run targeted daemon tests**

Run: `pnpm --dir <repo-root> test tests/runtime/daemon.test.ts`

- [ ] **Step 3: Run full verification**

Run:
- `pnpm --dir <repo-root> lint`
- `pnpm --dir <repo-root> test`
- `pnpm --dir <repo-root> build`

- [ ] **Step 4: Review and verifier gates**

Run the repo completion workflow, including:
- `reviewer`
- `classify_diff.py`
- conditional `refactor_auditor`
- `classify_verifier_need.py`
- conditional `verifier`

- [ ] **Step 5: Archive the plan when complete**

Run the shared plan archiver against `<repo-root>`.
