import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDocsServer } from '../helpers/docs-server.js';

const repoRoot = '/Users/jmucha/repos/mandex/aiocs';
const cliPath = `${repoRoot}/src/cli.ts`;
const tsxPath = `${repoRoot}/node_modules/.bin/tsx`;
const distCliPath = `${repoRoot}/dist/cli.js`;

async function runCli(
  runtime: 'tsx' | 'dist',
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const { execa } = await import('execa');

  if (runtime === 'dist') {
    return execa(distCliPath, args, {
      cwd: options.cwd,
      env: options.env,
      reject: false,
    });
  }

  return execa(tsxPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    reject: false,
  });
}

describe('CLI commands', () => {
  let root: string;

  beforeAll(async () => {
    const { execa } = await import('execa');
    await execa('pnpm', ['build'], {
      cwd: repoRoot,
    });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['tsx', 'dist'] as const)(
    'supports source upsert, fetch, project link, search, show, and snapshot listing with %s runtime',
    async (runtime) => {
    const server = await startDocsServer();
    const specPath = join(root, 'selector-source.yaml');
    const projectPath = join(root, 'workspace', 'trader');
    const nestedProjectCwd = join(projectPath, 'apps', 'worker');
    mkdirSync(nestedProjectCwd, { recursive: true });

    writeFileSync(specPath, `
id: selector-cli
label: Selector CLI
startUrls:
  - ${server.baseUrl}/selector/start
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${server.baseUrl}/selector/**
  exclude: []
  maxPages: 10
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
`);

    const env = {
      ...process.env,
      AIOCS_DATA_DIR: join(root, 'data'),
      AIOCS_CONFIG_DIR: join(root, 'config'),
    };

    try {
      const upsert = await runCli(runtime, ['source', 'upsert', specPath], { cwd: root, env });
      expect(upsert.exitCode).toBe(0);
      expect(upsert.stdout).toContain('selector-cli');

      const sourceList = await runCli(runtime, ['source', 'list'], { cwd: root, env });
      expect(sourceList.exitCode).toBe(0);
      expect(sourceList.stdout).toContain('selector-cli');

      const fetch = await runCli(runtime, ['fetch', 'selector-cli'], { cwd: root, env });
      expect(fetch.exitCode).toBe(0);
      expect(fetch.stdout).toContain('Fetched selector-cli');

      const refresh = await runCli(runtime, ['refresh', 'due'], { cwd: root, env });
      expect(refresh.exitCode).toBe(0);
      expect(refresh.stdout).toContain('No sources due');

      const link = await runCli(runtime, ['project', 'link', projectPath, 'selector-cli'], { cwd: root, env });
      expect(link.exitCode).toBe(0);

      const snapshots = await runCli(runtime, ['snapshot', 'list', 'selector-cli'], { cwd: root, env });
      expect(snapshots.exitCode).toBe(0);
      expect(snapshots.stdout).toContain('selector-cli');

      const search = await runCli(runtime, ['search', 'maker flow'], {
        cwd: nestedProjectCwd,
        env,
      });
      expect(search.exitCode).toBe(0);
      expect(search.stdout).toContain('selector-cli');

      const match = search.stdout.match(/Chunk ID:\s+(\d+)/);
      const chunkId = match?.[1];
      expect(chunkId).toBeTruthy();

      const show = await runCli(runtime, ['show', chunkId as string], { cwd: root, env });
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain('Maker flow documentation starts here.');

      const unlink = await runCli(runtime, ['project', 'unlink', projectPath, 'selector-cli'], { cwd: root, env });
      expect(unlink.exitCode).toBe(0);

      const unscopedSearch = await runCli(runtime, ['search', 'maker flow'], {
        cwd: nestedProjectCwd,
        env,
      });
      expect(unscopedSearch.exitCode).toBe(1);
      expect(unscopedSearch.stderr).toContain('No linked project scope found');
    } finally {
      await server.close();
    }
    },
    30_000,
  );
});
