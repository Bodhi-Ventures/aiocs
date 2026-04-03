import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { AiocsError, AIOCS_ERROR_CODES } from '../../src/errors.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import { compileWorkspace } from '../../src/workspace/compile.js';
import { generateWorkspaceOutput } from '../../src/workspace/output.js';

describe('workspace outputs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-output-'));
    compileWithLmStudioMock.mockReset();
    compileWithLmStudioMock.mockImplementation(async ({ userPrompt }: { userPrompt: string }) => {
      if (userPrompt.includes('Marp slide deck')) {
        return {
          model: 'google/gemma-4-26b-a4b',
          content: '# Slide 1\n\n- Point A\n\n---\n\n# Slide 2\n\n- Point B',
        };
      }
      if (userPrompt.includes('research report')) {
        return {
          model: 'google/gemma-4-26b-a4b',
          content: '# Report\n\nDetailed research report.',
        };
      }

      return {
        model: 'google/gemma-4-26b-a4b',
        content: '# Generated\n\nCompiled workspace artifact.',
      };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('generates report and slides outputs from compiled workspace artifacts', async () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'hyperliquid',
      label: 'Hyperliquid Docs',
      startUrls: ['https://example.com/docs/start'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 25,
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

    try {
      catalog.upsertSource(spec);
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow details.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'outputs',
        label: 'Outputs Workspace',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report', 'slides'],
      });
      catalog.bindWorkspaceSources('outputs', [spec.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'outputs',
      });

      const report = await generateWorkspaceOutput({
        catalog,
        dataDir: root,
        workspaceId: 'outputs',
        format: 'report',
        name: 'market-brief',
      });
      const slides = await generateWorkspaceOutput({
        catalog,
        dataDir: root,
        workspaceId: 'outputs',
        format: 'slides',
        name: 'market-brief',
      });

      expect(report.path).toBe('outputs/reports/market-brief.md');
      expect(slides.path).toBe('outputs/slides/market-brief.md');
      expect(readFileSync(join(root, 'workspaces', 'outputs', report.path), 'utf8')).toContain('# Report');
      expect(readFileSync(join(root, 'workspaces', 'outputs', slides.path), 'utf8')).toContain('marp: true');
      expect(catalog.getWorkspaceArtifact('outputs', report.path)).toEqual(
        expect.objectContaining({
          kind: 'report',
        }),
      );
      expect(catalog.getWorkspaceArtifact('outputs', slides.path)).toEqual(
        expect.objectContaining({
          kind: 'slides',
        }),
      );
    } finally {
      catalog.close();
    }
  });

  it('fails closed when required workspace artifacts are stale relative to the latest snapshots', async () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'hyperliquid',
      label: 'Hyperliquid Docs',
      startUrls: ['https://example.com/docs/start'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 25,
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

    try {
      catalog.upsertSource(spec);
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow details.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'stale-output',
        label: 'Stale Output Workspace',
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
      });
      catalog.bindWorkspaceSources('stale-output', [spec.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'stale-output',
      });

      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Orders',
            markdown: '# Orders\n\nUpdated maker flow details.',
          },
        ],
      });

      await expect(generateWorkspaceOutput({
        catalog,
        dataDir: root,
        workspaceId: 'stale-output',
        format: 'report',
        name: 'should-fail',
      })).rejects.toThrowError(
        expect.objectContaining<Partial<AiocsError>>({
          code: AIOCS_ERROR_CODES.workspaceArtifactsStale,
        }),
      );

      expect(catalog.getWorkspaceArtifact('stale-output', 'derived/index.md')).toEqual(
        expect.objectContaining({
          stale: true,
        }),
      );
    } finally {
      catalog.close();
    }
  });
});
