import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDocsServer } from '../helpers/docs-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = `${repoRoot}/src/cli.ts`;
const tsxPath = `${repoRoot}/node_modules/.bin/tsx`;
const distCliPath = `${repoRoot}/dist/cli.js`;

function writeSourceSpec(specPath: string, id: string, label: string) {
  writeFileSync(specPath, `
id: ${id}
label: ${label}
startUrls:
  - https://example.test/${id}
allowedHosts:
  - example.test
discovery:
  include:
    - https://example.test/${id}/**
  exclude: []
  maxPages: 5
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
`);
}

function seedUserManagedSourceSpecs(userSourceDir: string) {
  mkdirSync(userSourceDir, { recursive: true });
  writeSourceSpec(join(userSourceDir, 'ethereal.yaml'), 'ethereal', 'Ethereal Docs');
  writeSourceSpec(join(userSourceDir, 'lighter.yaml'), 'lighter', 'Lighter Docs');
  writeSourceSpec(join(userSourceDir, 'nado.yaml'), 'nado', 'Nado Docs');
  writeSourceSpec(join(userSourceDir, 'synthetix.yaml'), 'synthetix', 'Synthetix Docs');
}

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

function parseJsonEnvelope(stdout: string) {
  return JSON.parse(stdout) as {
    ok: boolean;
    command: string;
    data?: unknown;
    error?: {
      code: string;
      message: string;
      details?: unknown;
    };
  };
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
    'reports the current package version with %s runtime',
    async (runtime) => {
      const env = {
        ...process.env,
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
      };

      const version = await runCli(runtime, ['--version'], { cwd: root, env });
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(packageJson.version);
      expect(version.stderr).toBe('');
    },
    30_000,
  );

  it.each(['tsx', 'dist'] as const)(
    'bootstraps built-in sources and emits doctor output with %s runtime',
    async (runtime) => {
      const userSourceDir = join(root, 'user-sources');
      seedUserManagedSourceSpecs(userSourceDir);
      const env = {
        ...process.env,
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
        AIOCS_SOURCES_DIR: userSourceDir,
      };

      const init = await runCli(runtime, ['--json', 'init', '--no-fetch'], { cwd: root, env });
      expect(init.exitCode).toBe(0);
      expect(parseJsonEnvelope(init.stdout)).toMatchObject({
        ok: true,
        command: 'init',
        data: {
          fetched: false,
          sourceSpecDirs: expect.arrayContaining([
            join(repoRoot, 'sources'),
            userSourceDir,
          ]),
          userSourceDir,
          initializedSources: expect.arrayContaining([
            expect.objectContaining({ sourceId: 'ethereal' }),
            expect.objectContaining({ sourceId: 'hyperliquid' }),
            expect.objectContaining({ sourceId: 'lighter' }),
            expect.objectContaining({ sourceId: 'nado' }),
            expect.objectContaining({ sourceId: 'synthetix' }),
          ]),
        },
      });

      const sourceList = await runCli(runtime, ['--json', 'source', 'list'], { cwd: root, env });
      expect(sourceList.exitCode).toBe(0);
      expect(parseJsonEnvelope(sourceList.stdout)).toMatchObject({
        ok: true,
        command: 'source.list',
        data: {
          sources: expect.arrayContaining([
            expect.objectContaining({ id: 'ethereal' }),
            expect.objectContaining({ id: 'hyperliquid' }),
            expect.objectContaining({ id: 'lighter' }),
            expect.objectContaining({ id: 'nado' }),
            expect.objectContaining({ id: 'synthetix' }),
          ]),
        },
      });

      const doctor = await runCli(runtime, ['--json', 'doctor'], { cwd: root, env });
      expect(doctor.exitCode).toBe(0);
      expect(parseJsonEnvelope(doctor.stdout)).toMatchObject({
        ok: true,
        command: 'doctor',
        data: {
          summary: expect.objectContaining({
            status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
          }),
          checks: expect.arrayContaining([
            expect.objectContaining({
              id: 'catalog',
              status: 'pass',
            }),
            expect.objectContaining({
              id: 'playwright',
              status: expect.stringMatching(/^(pass|warn|fail)$/),
            }),
            expect.objectContaining({
              id: 'daemon-config',
              status: expect.stringMatching(/^(pass|warn|fail)$/),
            }),
            expect.objectContaining({
              id: 'source-spec-dirs',
              status: expect.stringMatching(/^(pass|warn|fail)$/),
            }),
            expect.objectContaining({
              id: 'docker',
              status: expect.stringMatching(/^(pass|warn|fail)$/),
            }),
          ]),
        },
      });
    },
    30_000,
  );

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

  it.each(['tsx', 'dist'] as const)(
    'emits structured JSON envelopes for success paths with %s runtime',
    async (runtime) => {
      const server = await startDocsServer();
      const specPath = join(root, 'selector-source.yaml');
      const projectPath = join(root, 'workspace', 'trader');
      const nestedProjectCwd = join(projectPath, 'apps', 'worker');
      mkdirSync(nestedProjectCwd, { recursive: true });

      writeFileSync(specPath, `
id: selector-json
label: Selector JSON
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
        const upsert = await runCli(runtime, ['--json', 'source', 'upsert', specPath], { cwd: root, env });
        expect(upsert.exitCode).toBe(0);
        expect(parseJsonEnvelope(upsert.stdout)).toMatchObject({
          ok: true,
          command: 'source.upsert',
          data: {
            sourceId: 'selector-json',
          },
        });

        const sourceList = await runCli(runtime, ['--json', 'source', 'list'], { cwd: root, env });
        expect(sourceList.exitCode).toBe(0);
      expect(parseJsonEnvelope(sourceList.stdout)).toMatchObject({
        ok: true,
        command: 'source.list',
        data: {
          sources: [
            expect.objectContaining({
              id: 'selector-json',
              label: 'Selector JSON',
              specPath,
              isDue: true,
              isCanaryDue: true,
            }),
          ],
        },
      });

        const refreshDue = await runCli(runtime, ['--json', 'refresh', 'due', 'selector-json'], { cwd: root, env });
        expect(refreshDue.exitCode).toBe(0);
        expect(parseJsonEnvelope(refreshDue.stdout)).toMatchObject({
          ok: true,
          command: 'refresh.due',
          data: {
            results: [
              expect.objectContaining({
                sourceId: 'selector-json',
                pageCount: 2,
              }),
            ],
          },
        });

        const refresh = await runCli(runtime, ['--json', 'refresh', 'due', 'selector-json'], { cwd: root, env });
        expect(refresh.exitCode).toBe(0);
        expect(parseJsonEnvelope(refresh.stdout)).toMatchObject({
          ok: true,
          command: 'refresh.due',
          data: {
            results: [],
          },
        });

        const link = await runCli(runtime, ['--json', 'project', 'link', projectPath, 'selector-json'], { cwd: root, env });
        expect(link.exitCode).toBe(0);
        expect(parseJsonEnvelope(link.stdout)).toMatchObject({
          ok: true,
          command: 'project.link',
          data: {
            projectPath,
            sourceIds: ['selector-json'],
          },
        });

        const search = await runCli(runtime, ['--json', 'search', 'maker flow'], {
          cwd: nestedProjectCwd,
          env,
        });
        expect(search.exitCode).toBe(0);
        const searchEnvelope = parseJsonEnvelope(search.stdout);
        expect(searchEnvelope).toMatchObject({
          ok: true,
          command: 'search',
        });
        expect(searchEnvelope.data).toMatchObject({
          limit: 20,
          offset: 0,
          hasMore: false,
        });
        const searchData = searchEnvelope.data as {
          total: number;
          results: Array<{
            chunkId: number;
            sourceId: string;
            markdown: string;
          }>;
        };
        expect(searchData.total).toBeGreaterThanOrEqual(1);
        expect(searchData.results[0]).toMatchObject({
          sourceId: 'selector-json',
          markdown: expect.stringContaining('Maker flow documentation starts here.'),
        });

        const chunkId = searchData.results[0]?.chunkId;
        expect(chunkId).toBeTruthy();

        const show = await runCli(runtime, ['--json', 'show', String(chunkId)], { cwd: root, env });
        expect(show.exitCode).toBe(0);
        expect(parseJsonEnvelope(show.stdout)).toMatchObject({
          ok: true,
          command: 'show',
          data: {
            chunk: expect.objectContaining({
              chunkId,
              sourceId: 'selector-json',
              markdown: expect.stringContaining('Maker flow documentation starts here.'),
            }),
          },
        });
      } finally {
        await server.close();
      }
    },
    30_000,
  );

  it.each(['tsx', 'dist'] as const)(
    'supports paginated search and coverage verification with %s runtime',
    async (runtime) => {
      const server = await startDocsServer();
      const specPath = join(root, 'selector-verify.yaml');
      const referencePath = join(root, 'selector-reference.md');
      const projectPath = join(root, 'workspace', 'verifier');
      mkdirSync(projectPath, { recursive: true });

      writeFileSync(specPath, `
id: selector-verify
label: Selector Verify
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

      writeFileSync(referencePath, `
# Selector Start

Maker flow documentation starts here.

# Selector Next

Second page content for market making docs.

# Missing Heading
`);

      const env = {
        ...process.env,
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
      };

      try {
        const upsert = await runCli(runtime, ['--json', 'source', 'upsert', specPath], { cwd: root, env });
        expect(upsert.exitCode).toBe(0);

        const fetch = await runCli(runtime, ['--json', 'fetch', 'selector-verify'], { cwd: root, env });
        expect(fetch.exitCode).toBe(0);

        const link = await runCli(runtime, ['--json', 'project', 'link', projectPath, 'selector-verify'], { cwd: root, env });
        expect(link.exitCode).toBe(0);

        const search = await runCli(runtime, ['--json', 'search', 'selector', '--project', projectPath, '--limit', '1', '--offset', '1'], {
          cwd: root,
          env,
        });
        expect(search.exitCode).toBe(0);
        expect(parseJsonEnvelope(search.stdout)).toMatchObject({
          ok: true,
          command: 'search',
          data: {
            total: 2,
            limit: 1,
            offset: 1,
            hasMore: false,
            results: [
              expect.objectContaining({
                sourceId: 'selector-verify',
              }),
            ],
          },
        });

        const verifyCoverage = await runCli(runtime, ['--json', 'verify', 'coverage', 'selector-verify', referencePath], {
          cwd: root,
          env,
        });
        expect(verifyCoverage.exitCode).toBe(0);
        expect(parseJsonEnvelope(verifyCoverage.stdout)).toMatchObject({
          ok: true,
          command: 'verify.coverage',
          data: {
            sourceId: 'selector-verify',
            complete: false,
            summary: {
              headingCount: 3,
              matchedHeadingCount: 2,
              missingHeadingCount: 1,
            },
            files: [
              expect.objectContaining({
                referenceFile: referencePath,
                missingHeadings: ['Missing Heading'],
              }),
            ],
          },
        });
      } finally {
        await server.close();
      }
    },
    30_000,
  );

  it.each(['tsx', 'dist'] as const)(
    'emits structured JSON envelopes for failure paths with %s runtime',
    async (runtime) => {
      const env = {
        ...process.env,
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
      };
      const nestedProjectCwd = join(root, 'workspace', 'trader', 'apps', 'worker');
      mkdirSync(nestedProjectCwd, { recursive: true });

      const unscopedSearch = await runCli(runtime, ['--json', 'search', 'maker flow'], {
        cwd: nestedProjectCwd,
        env,
      });
      expect(unscopedSearch.exitCode).toBe(1);
      expect(unscopedSearch.stderr).toBe('');
      expect(parseJsonEnvelope(unscopedSearch.stdout)).toMatchObject({
        ok: false,
        command: 'search',
        error: {
          code: 'NO_PROJECT_SCOPE',
          message: 'No linked project scope found. Use --source or --all.',
        },
      });

      const show = await runCli(runtime, ['--json', 'show', '99999'], {
        cwd: root,
        env,
      });
      expect(show.exitCode).toBe(1);
      expect(show.stderr).toBe('');
      expect(parseJsonEnvelope(show.stdout)).toMatchObject({
        ok: false,
        command: 'show',
        error: {
          code: 'CHUNK_NOT_FOUND',
          message: 'Chunk 99999 not found',
        },
      });
    },
    30_000,
  );

  it.each(['tsx', 'dist'] as const)(
    'supports canary, diff, and backup commands with %s runtime',
    async (runtime) => {
      const server = await startDocsServer();
      const specPath = join(root, 'diff-source.yaml');
      const backupDir = join(root, 'backup-output');

      writeFileSync(specPath, `
id: diff-cli
label: Diff CLI
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
canary:
  everyHours: 6
  checks:
    - url: ${server.baseUrl}/selector/start
      expectedTitle: Selector Start
      expectedText: Maker flow documentation starts here.
      minMarkdownLength: 20
`);

      const env = {
        ...process.env,
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
      };

      try {
        await runCli(runtime, ['source', 'upsert', specPath], { cwd: root, env });
        await runCli(runtime, ['fetch', 'diff-cli'], { cwd: root, env });

        writeFileSync(specPath, `
id: diff-cli
label: Diff CLI
startUrls:
  - ${server.baseUrl}/selector-v2/start
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${server.baseUrl}/selector-v2/**
  exclude: []
  maxPages: 10
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
canary:
  everyHours: 6
  checks:
    - url: ${server.baseUrl}/selector-v2/start
      expectedTitle: Selector Start
      expectedText: Maker flow documentation starts here
      minMarkdownLength: 20
`);
        await runCli(runtime, ['source', 'upsert', specPath], { cwd: root, env });
        await runCli(runtime, ['fetch', 'diff-cli'], { cwd: root, env });

        const canary = await runCli(runtime, ['--json', 'canary', 'diff-cli'], { cwd: root, env });
        expect(canary.exitCode).toBe(0);
        expect(parseJsonEnvelope(canary.stdout)).toMatchObject({
          ok: true,
          command: 'canary',
          data: {
            results: [
              expect.objectContaining({
                sourceId: 'diff-cli',
                status: 'pass',
              }),
            ],
          },
        });

        const diff = await runCli(runtime, ['--json', 'diff', 'diff-cli'], { cwd: root, env });
        expect(diff.exitCode).toBe(0);
        expect(parseJsonEnvelope(diff.stdout)).toMatchObject({
          ok: true,
          command: 'diff',
          data: {
            sourceId: 'diff-cli',
            summary: expect.objectContaining({
              changedPageCount: expect.any(Number),
            }),
          },
        });

        const backup = await runCli(runtime, ['--json', 'backup', 'export', backupDir], { cwd: root, env });
        expect(backup.exitCode).toBe(0);
        expect(parseJsonEnvelope(backup.stdout)).toMatchObject({
          ok: true,
          command: 'backup.export',
          data: {
            outputDir: backupDir,
            manifestPath: `${backupDir}/manifest.json`,
          },
        });
      } finally {
        await server.close();
      }
    },
    45_000,
  );
});
