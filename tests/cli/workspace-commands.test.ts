import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDocsServer } from '../helpers/docs-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = `${repoRoot}/src/cli.ts`;
const tsxPath = `${repoRoot}/node_modules/.bin/tsx`;

async function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const { execa } = await import('execa');
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
    };
  };
}

describe('workspace CLI commands', () => {
  let root: string;

  beforeAll(async () => {
    const { execa } = await import('execa');
    await execa('pnpm', ['build'], { cwd: repoRoot });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('supports workspace create, bind, status, search, and lint', async () => {
    const docsServer = await startDocsServer();
    const specPath = join(root, 'workspace-source.yaml');
    const env = {
      ...process.env,
      AIOCS_DATA_DIR: join(root, 'data'),
      AIOCS_CONFIG_DIR: join(root, 'config'),
    };

    writeFileSync(specPath, `
id: workspace-cli
label: Workspace CLI
startUrls:
  - ${docsServer.baseUrl}/selector/start
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${docsServer.baseUrl}/selector/**
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

    try {
      expect((await runCli(['source', 'upsert', specPath], { cwd: root, env })).exitCode).toBe(0);
      expect((await runCli(['refresh', 'due', 'workspace-cli'], { cwd: root, env })).exitCode).toBe(0);

      const create = await runCli(['--json', 'workspace', 'create', 'market-structure', '--label', 'Market Structure'], { cwd: root, env });
      expect(create.exitCode).toBe(0);
      expect(parseJsonEnvelope(create.stdout)).toMatchObject({
        ok: true,
        command: 'workspace.create',
      });

      const bind = await runCli(['--json', 'workspace', 'bind', 'market-structure', 'workspace-cli'], { cwd: root, env });
      expect(bind.exitCode).toBe(0);

      const status = await runCli(['--json', 'workspace', 'status', 'market-structure'], { cwd: root, env });
      expect(status.exitCode).toBe(0);
      expect(parseJsonEnvelope(status.stdout)).toMatchObject({
        ok: true,
        command: 'workspace.status',
        data: {
          workspace: expect.objectContaining({
            id: 'market-structure',
          }),
          bindings: [
            expect.objectContaining({
              sourceId: 'workspace-cli',
            }),
          ],
          artifacts: [],
        },
      });

      const search = await runCli(['--json', 'workspace', 'search', 'market-structure', 'maker flow', '--scope', 'source'], { cwd: root, env });
      expect(search.exitCode).toBe(0);
      expect(parseJsonEnvelope(search.stdout)).toMatchObject({
        ok: true,
        command: 'workspace.search',
        data: {
          workspaceId: 'market-structure',
          results: expect.arrayContaining([
            expect.objectContaining({
              scope: 'source',
            }),
          ]),
        },
      });

      const artifactList = await runCli(['--json', 'workspace', 'artifact', 'list', 'market-structure'], { cwd: root, env });
      expect(artifactList.exitCode).toBe(0);
      expect(parseJsonEnvelope(artifactList.stdout)).toMatchObject({
        ok: true,
        command: 'workspace.artifact.list',
        data: {
          artifacts: [],
        },
      });

      const lint = await runCli(['--json', 'workspace', 'lint', 'market-structure'], { cwd: root, env });
      expect(lint.exitCode).toBe(0);
      expect(parseJsonEnvelope(lint.stdout)).toMatchObject({
        ok: true,
        command: 'workspace.lint',
        data: {
          summary: expect.objectContaining({
            status: 'warn',
          }),
        },
      });
    } finally {
      await docsServer.close();
    }
  }, 30_000);
});
