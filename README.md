# aiocs

Local-only documentation fetch, versioning, and search CLI for AI agents.

## What it does

- fetches docs from websites with Playwright
- normalizes them into Markdown
- stores immutable local snapshots in a shared catalog
- indexes heading-aware chunks in SQLite FTS5
- links docs sources to local projects for scoped search

All state is local. By default, data lives under XDG-style paths:

- data: `$XDG_DATA_HOME/aiocs` or `~/.local/share/aiocs`
- config: `$XDG_CONFIG_HOME/aiocs` or `~/.config/aiocs`

For testing or local overrides, set:

- `AIOCS_DATA_DIR`
- `AIOCS_CONFIG_DIR`

## Install

```bash
pnpm install
pnpm build
```

Run the CLI during development with:

```bash
pnpm dev -- --help
```

Or after build:

```bash
./dist/cli.js --help
```

## Built-in sources

Initial source specs are shipped in `sources/`:

- `synthetix`
- `hyperliquid`
- `lighter`
- `nado`
- `ethereal`

Load them into the local catalog with:

```bash
pnpm dev -- source upsert sources/synthetix.yaml
pnpm dev -- source upsert sources/hyperliquid.yaml
pnpm dev -- source upsert sources/lighter.yaml
pnpm dev -- source upsert sources/nado.yaml
pnpm dev -- source upsert sources/ethereal.yaml
```

## Workflow

Register a source:

```bash
pnpm dev -- source upsert /path/to/source.yaml
pnpm dev -- source list
```

Fetch and snapshot docs:

```bash
pnpm dev -- fetch hyperliquid
pnpm dev -- snapshot list hyperliquid
pnpm dev -- refresh due
```

Link docs to a local project:

```bash
pnpm dev -- project link /absolute/path/to/project hyperliquid lighter
pnpm dev -- project unlink /absolute/path/to/project lighter
```

Search and inspect results:

```bash
pnpm dev -- search "maker flow" --source hyperliquid
pnpm dev -- search "maker flow" --all
pnpm dev -- show 42
```

When `docs search` runs inside a linked project, it automatically scopes to that project's linked sources unless `--source` or `--all` is provided.

## Source spec shape

Each source spec is YAML or JSON and must define:

- `id`
- `label`
- `startUrls`
- `allowedHosts`
- `discovery.include`
- `discovery.exclude`
- `discovery.maxPages`
- `extract`
- `normalize`
- `schedule.everyHours`

Supported extraction strategies:

- `clipboardButton`
- `selector`
- `readability`

## Verification

```bash
pnpm lint
pnpm test
pnpm build
```
