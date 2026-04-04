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
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import { compileWorkspace } from '../../src/workspace/compile.js';
import { lintWorkspace } from '../../src/workspace/lint.js';
import { analyzeWorkspaceStatus } from '../../src/workspace/status.js';

describe('workspace linting', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-lint-'));
    compileWithLmStudioMock.mockReset();
    compileWithLmStudioMock.mockResolvedValue({
      model: 'google/gemma-4-26b-a4b',
      content: '# Generated\n\nArtifact body.',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags stale artifacts after upstream snapshot changes and missing provenance artifacts', async () => {
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
            markdown: '# Orders\n\nInitial content.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'linted',
        label: 'Linted Workspace',
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
      catalog.bindWorkspaceSources('linted', [spec.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'linted',
      });

      catalog.upsertWorkspaceArtifact({
        workspaceId: 'linted',
        path: 'derived/notes/missing-provenance.md',
        kind: 'note',
        contentHash: 'manual-note',
        compilerMetadata: { provider: 'manual' },
        stale: false,
        chunks: [
          {
            sectionTitle: 'Missing provenance',
            markdown: '# Missing provenance\n\nThis note has no provenance rows.',
          },
        ],
        provenance: [],
        links: [
          {
            fromPath: 'derived/notes/missing-provenance.md',
            toPath: 'derived/notes/missing-target.md',
            relationKind: 'explicit_link',
            anchorText: 'derived/notes/missing-target.md',
          },
        ],
      });

      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Orders',
            markdown: '# Orders\n\nUpdated content.',
          },
        ],
      });

      const report = await lintWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'linted',
      });

      expect(report.summary.status).toBe('warn');
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'stale-artifact',
          artifactPath: 'derived/sources/hyperliquid/summary.md',
        }),
        expect.objectContaining({
          kind: 'missing-provenance',
          artifactPath: 'derived/notes/missing-provenance.md',
        }),
        expect.objectContaining({
          kind: 'broken-artifact-link',
          artifactPath: 'derived/notes/missing-provenance.md',
        }),
      ]));
      expect(report.summary.brokenLinkCount).toBeGreaterThan(0);
      expect(catalog.getWorkspaceArtifact('linted', 'derived/sources/hyperliquid/summary.md')).toEqual(
        expect.objectContaining({
          stale: true,
        }),
      );
    } finally {
      catalog.close();
    }
  });

  it('persists deterministic suggestion artifacts for duplicate concepts, missing articles, and follow-up questions', async () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'orders',
      label: 'Orders Docs',
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
            markdown: '# Orders\n\nOrder lifecycle and caveats.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'suggestions',
        label: 'Suggestions Workspace',
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
      catalog.bindWorkspaceSources('suggestions', [spec.id]);
      catalog.upsertWorkspaceRawInput({
        id: 'orders-notes',
        workspaceId: 'suggestions',
        kind: 'markdown-dir',
        label: 'Orders',
        sourcePath: join(root, 'orders-notes'),
        storagePath: 'raw/orders-notes',
        contentHash: 'orders-notes-hash',
        metadata: {
          absolutePath: join(root, 'orders-notes'),
        },
        chunks: [
          {
            sectionTitle: 'Orders Notes',
            markdown: '# Orders Notes\n\nOperational notes for orders.',
            filePath: 'orders.md',
          },
        ],
      });

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'suggestions',
      });

      const report = await lintWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'suggestions',
      });

      expect(report.summary.status).toBe('warn');
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-concept-candidate',
        }),
        expect.objectContaining({
          kind: 'missing-article-candidate',
        }),
        expect.objectContaining({
          kind: 'follow-up-question-suggestion',
        }),
      ]));
      expect(report.summary).toEqual(expect.objectContaining({
        duplicateConceptCandidateCount: expect.any(Number),
        missingArticleCandidateCount: expect.any(Number),
        followUpQuestionCount: expect.any(Number),
      }));
      expect(report.suggestionsArtifactPath).toBe('outputs/suggestions/lint.md');
      expect(catalog.getWorkspaceArtifact('suggestions', 'outputs/suggestions/lint.md')).toEqual(
        expect.objectContaining({
          kind: 'note',
        }),
      );

      const status = analyzeWorkspaceStatus({
        catalog,
        workspaceId: 'suggestions',
      });

      expect(status.lintSummary.status).toBe('warn');
      expect(status.health.status).toBe('healthy');
      expect(status.health).toEqual(expect.objectContaining({
        duplicateConceptCandidateCount: expect.any(Number),
        missingArticleCandidateCount: expect.any(Number),
        followUpQuestionCount: expect.any(Number),
      }));
    } finally {
      catalog.close();
    }
  });
});
