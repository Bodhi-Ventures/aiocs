import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { compileWithLmStudioMock } = vi.hoisted(() => ({
  compileWithLmStudioMock: vi.fn(),
}));

vi.mock('../../src/workspace/lmstudio.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/workspace/lmstudio.js')>('../../src/workspace/lmstudio.js');
  return {
    ...actual,
    compileWithLmStudio: compileWithLmStudioMock,
  };
});

import { openCatalog } from '../../src/catalog/catalog.js';
import { fetchSources, refreshDueSources } from '../../src/services.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import { startDocsServer } from '../helpers/docs-server.js';

function buildSpec(baseUrl: string, id: string) {
  return parseSourceSpecObject({
    id,
    label: `${id} docs`,
    startUrls: [`${baseUrl}/selector/start`],
    allowedHosts: ['127.0.0.1'],
    discovery: {
      include: [`${baseUrl}/selector/**`],
      exclude: [],
      maxPages: 10,
    },
    extract: {
      strategy: 'selector',
      selector: 'article',
    },
    normalize: {
      prependSourceComment: true,
    },
    schedule: {
      everyHours: 24,
    },
  });
}

describe('manual source refresh auto-compiles workspaces', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-manual-refresh-'));
    previousDataDir = process.env.AIOCS_DATA_DIR;
    previousConfigDir = process.env.AIOCS_CONFIG_DIR;
    process.env.AIOCS_DATA_DIR = join(root, 'data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'config');
    compileWithLmStudioMock.mockReset();
    compileWithLmStudioMock.mockResolvedValue({
      model: 'google/gemma-4-26b-a4b',
      content: '# Generated\n\nCompiled workspace artifact.',
    });
  });

  afterEach(() => {
    if (typeof previousDataDir === 'undefined') {
      delete process.env.AIOCS_DATA_DIR;
    } else {
      process.env.AIOCS_DATA_DIR = previousDataDir;
    }

    if (typeof previousConfigDir === 'undefined') {
      delete process.env.AIOCS_CONFIG_DIR;
    } else {
      process.env.AIOCS_CONFIG_DIR = previousConfigDir;
    }

    rmSync(root, { recursive: true, force: true });
  });

  it('fetchSources compiles opted-in workspaces after a changed snapshot', async () => {
    const server = await startDocsServer();
    const dataDir = process.env.AIOCS_DATA_DIR as string;
    const source = buildSpec(server.baseUrl, 'manual-fetch');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.upsertSource(source);
      catalog.createWorkspace({
        id: 'manual-fetch-workspace',
        label: 'Manual Fetch Workspace',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
        autoCompileEnabled: true,
      });
      catalog.bindWorkspaceSources('manual-fetch-workspace', [source.id]);
    } finally {
      catalog.close();
    }

    try {
      const result = await fetchSources(source.id);
      expect(result.results).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          reused: false,
        }),
      ]);

      const reopened = openCatalog({ dataDir });
      try {
        expect(reopened.listWorkspaceArtifacts('manual-fetch-workspace').map((artifact) => artifact.path)).toEqual([
          'derived/concepts/manual-fetch.md',
          'derived/index.md',
          'derived/sources/manual-fetch/summary.md',
        ]);
        expect(reopened.getWorkspaceCompileJob('manual-fetch-workspace')).toEqual(
          expect.objectContaining({
            status: 'succeeded',
          }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      await server.close();
    }
  });

  it('refreshDueSources compiles opted-in workspaces after a due refresh', async () => {
    const server = await startDocsServer();
    const dataDir = process.env.AIOCS_DATA_DIR as string;
    const source = buildSpec(server.baseUrl, 'manual-refresh-due');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.upsertSource(source);
      catalog.createWorkspace({
        id: 'manual-refresh-workspace',
        label: 'Manual Refresh Workspace',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
        autoCompileEnabled: true,
      });
      catalog.bindWorkspaceSources('manual-refresh-workspace', [source.id]);
    } finally {
      catalog.close();
    }

    try {
      const result = await refreshDueSources(source.id);
      expect(result.results).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          reused: false,
        }),
      ]);

      const reopened = openCatalog({ dataDir });
      try {
        expect(reopened.listWorkspaceArtifacts('manual-refresh-workspace').map((artifact) => artifact.path)).toEqual([
          'derived/concepts/manual-refresh-due.md',
          'derived/index.md',
          'derived/sources/manual-refresh-due/summary.md',
        ]);
        expect(reopened.getWorkspaceCompileJob('manual-refresh-workspace')).toEqual(
          expect.objectContaining({
            status: 'succeeded',
          }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      await server.close();
    }
  });
});
