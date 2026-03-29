## Non-Negotiables
- Ship production-grade, scalable implementations. Avoid MVP shortcuts.
- Keep changes canonical in the primary codepath. Remove dead, duplicate, or legacy paths as part of delivery.
- Prefer direct, first-class integrations. Do not add shims, wrappers, or adapter layers.
- Keep a single source of truth for business rules, validation, enums, flags, constants, and config.
- Define clean API invariants: require inputs explicitly, validate up front, and fail fast.
- Use the latest stable libraries and documentation. If unsure, verify on the web.

## Codex Workflow
- Keep diffs scoped when parallel edits appear. Stop only for direct conflicts or breakage.
- Shared operating conventions live in `$CODEX_HOME/docs/OPERATING_GUIDE.md`.
- Shared skills live in `$CODEX_HOME/skills/`. Prefer task-specific skills over duplicating workflow detail here.

## Repo Continuity
- Treat repo artifacts as durable memory. Do not rely on hidden session context.
- Keep durable project documentation in `docs/`.
- Keep local reference material in `resources/` and out of version control.
- Keep active plans in `plans/active/`, completed plans in `plans/completed/`, and workflow debt in `plans/harness-debt.md`.
- Register durable non-code context in `.socraticodecontextartifacts.json` when it should be recoverable across sessions.
