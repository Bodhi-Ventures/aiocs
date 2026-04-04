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
import { compileWorkspace } from '../../src/workspace/compile.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import { getWorkspaceOutputPath } from '../../src/workspace/artifacts.js';

function buildSpec(id: string) {
  return parseSourceSpecObject({
    id,
    label: `${id} docs`,
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
}

describe('workspace compile pipeline', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-compile-'));
    compileWithLmStudioMock.mockReset();
    compileWithLmStudioMock.mockImplementation(async ({ userPrompt }: { userPrompt: string }) => {
      if (userPrompt.includes('summary artifact')) {
        return {
          model: 'google/gemma-4-26b-a4b',
          content: '# Summary\n\nCompiled source summary.',
        };
      }

      return {
        model: 'google/gemma-4-26b-a4b',
        content: '# Concepts\n\nCompiled concept page.',
      };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('compiles workspace artifacts incrementally and only refreshes changed source scopes', async () => {
    const catalog = openCatalog({ dataDir: root });
    const sourceA = buildSpec('hyperliquid');
    const sourceB = buildSpec('nado');

    try {
      catalog.upsertSource(sourceA);
      catalog.upsertSource(sourceB);
      const snapshotA1 = catalog.recordSuccessfulSnapshot({
        sourceId: sourceA.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow for Hyperliquid.',
          },
        ],
      });
      const snapshotB1 = catalog.recordSuccessfulSnapshot({
        sourceId: sourceB.id,
        pages: [
          {
            url: 'https://example.com/docs/nado/triggers',
            title: 'Triggers',
            markdown: '# Triggers\n\nTrigger flow for Nado.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'market-structure',
        label: 'Market Structure',
        purpose: 'Compile a reusable local wiki.',
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
      catalog.bindWorkspaceSources('market-structure', [sourceA.id, sourceB.id]);

      const firstCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'market-structure',
      });

      expect(firstCompile.skipped).toBe(false);
      expect(firstCompile.updatedArtifactPaths).toEqual([
        'derived/concepts/hyperliquid.md',
        'derived/concepts/nado.md',
        'derived/index.md',
        'derived/sources/hyperliquid/summary.md',
        'derived/sources/nado/summary.md',
      ]);
      expect(compileWithLmStudioMock).toHaveBeenCalledTimes(4);
      expect(catalog.listWorkspaceArtifacts('market-structure')).toHaveLength(5);
      expect(readFileSync(join(root, 'workspaces', 'market-structure', 'derived', 'index.md'), 'utf8'))
        .toContain('Workspace Index');
      expect(readFileSync(join(root, 'workspaces', 'market-structure', 'derived', 'sources', 'hyperliquid', 'summary.md'), 'utf8'))
        .toContain('# Summary');
      expect(readFileSync(join(root, 'workspaces', 'market-structure', 'derived', 'concepts', 'hyperliquid.md'), 'utf8'))
        .toContain('# Concepts');

      const sourceBArtifactBefore = catalog.getWorkspaceArtifact('market-structure', 'derived/sources/nado/summary.md');
      expect(sourceBArtifactBefore?.stale).toBe(false);
      expect(catalog.listWorkspaceArtifactProvenance('market-structure', 'derived/sources/hyperliquid/summary.md')).toEqual([
        expect.objectContaining({
          sourceId: sourceA.id,
          snapshotId: snapshotA1.snapshotId,
        }),
      ]);
      expect(catalog.listWorkspaceArtifactProvenance('market-structure', 'derived/sources/nado/summary.md')).toEqual([
        expect.objectContaining({
          sourceId: sourceB.id,
          snapshotId: snapshotB1.snapshotId,
        }),
      ]);

      const secondCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'market-structure',
      });

      expect(secondCompile.skipped).toBe(true);
      expect(secondCompile.updatedArtifactPaths).toEqual([]);
      expect(compileWithLmStudioMock).toHaveBeenCalledTimes(4);

      const snapshotA2 = catalog.recordSuccessfulSnapshot({
        sourceId: sourceA.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nUpdated maker flow for Hyperliquid.',
          },
        ],
      });

      const thirdCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'market-structure',
      });

      expect(thirdCompile.skipped).toBe(false);
      expect(thirdCompile.changedSourceIds).toEqual([sourceA.id]);
      expect(thirdCompile.updatedArtifactPaths).toEqual([
        'derived/concepts/hyperliquid.md',
        'derived/index.md',
        'derived/sources/hyperliquid/summary.md',
      ]);
      expect(compileWithLmStudioMock).toHaveBeenCalledTimes(6);
      expect(catalog.getWorkspaceArtifact('market-structure', 'derived/sources/nado/summary.md')).toEqual(
        expect.objectContaining({
          updatedAt: sourceBArtifactBefore?.updatedAt,
          stale: false,
        }),
      );
      expect(catalog.listWorkspaceArtifactProvenance('market-structure', 'derived/sources/hyperliquid/summary.md')).toEqual([
        expect.objectContaining({
          sourceId: sourceA.id,
          snapshotId: snapshotA2.snapshotId,
        }),
      ]);
      expect(compileWithLmStudioMock.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          profile: expect.objectContaining({
            model: 'google/gemma-4-26b-a4b',
          }),
        }),
      );
    } finally {
      catalog.close();
    }
  });

  it('applies AIOCS_LMSTUDIO_MODEL as a runtime override for existing workspaces', async () => {
    const catalog = openCatalog({ dataDir: root });
    const source = buildSpec('hyperliquid');

    try {
      catalog.upsertSource(source);
      catalog.recordSuccessfulSnapshot({
        sourceId: source.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow for Hyperliquid.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'runtime-override',
        label: 'Runtime Override',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'stored-model',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
      });
      catalog.bindWorkspaceSources('runtime-override', [source.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'runtime-override',
        env: {
          AIOCS_LMSTUDIO_MODEL: 'env-model',
        },
      });

      expect(compileWithLmStudioMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          profile: expect.objectContaining({
            model: 'env-model',
          }),
        }),
      );

      compileWithLmStudioMock.mockClear();

      const secondCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'runtime-override',
        env: {
          AIOCS_LMSTUDIO_MODEL: 'env-model-2',
        },
      });

      expect(secondCompile.skipped).toBe(false);
      expect(compileWithLmStudioMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          profile: expect.objectContaining({
            model: 'env-model-2',
          }),
        }),
      );
    } finally {
      catalog.close();
    }
  });

  it('marks previously generated outputs stale when compile refreshes source-derived artifacts', async () => {
    const catalog = openCatalog({ dataDir: root });
    const source = buildSpec('hyperliquid');

    try {
      catalog.upsertSource(source);
      const snapshot1 = catalog.recordSuccessfulSnapshot({
        sourceId: source.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow for Hyperliquid.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'output-staleness',
        label: 'Output Staleness',
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
      catalog.bindWorkspaceSources('output-staleness', [source.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'output-staleness',
      });

      const reportPath = getWorkspaceOutputPath('report', 'market-brief');
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'output-staleness',
        path: reportPath,
        kind: 'report',
        contentHash: 'report-hash',
        compilerMetadata: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          promptKind: 'report',
        },
        stale: false,
        chunks: [
          {
            sectionTitle: 'report output',
            markdown: '# Report\n\nCurrent report.',
          },
        ],
        provenance: [
          {
            sourceId: source.id,
            snapshotId: snapshot1.snapshotId,
            chunkIds: [],
          },
        ],
      });

      catalog.recordSuccessfulSnapshot({
        sourceId: source.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nUpdated maker flow for Hyperliquid.',
          },
        ],
      });

      const result = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'output-staleness',
      });

      expect(result.skipped).toBe(false);
      expect(result.changedSourceIds).toEqual([source.id]);
      expect(catalog.getWorkspaceArtifact('output-staleness', reportPath)).toEqual(
        expect.objectContaining({
          stale: true,
        }),
      );
    } finally {
      catalog.close();
    }
  });

  it('compiles raw workspace inputs and reports changed raw input ids', async () => {
    const catalog = openCatalog({ dataDir: root });

    try {
      catalog.createWorkspace({
        id: 'raw-workspace',
        label: 'Raw Workspace',
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

      catalog.upsertWorkspaceRawInput({
        id: 'paper-notes',
        workspaceId: 'raw-workspace',
        kind: 'markdown-dir',
        label: 'Paper Notes',
        sourcePath: join(root, 'paper-notes'),
        storagePath: 'raw/paper-notes',
        contentHash: 'hash-one',
        metadata: {
          absolutePath: join(root, 'paper-notes'),
        },
        chunks: [
          {
            sectionTitle: 'Paper',
            markdown: '# Paper\n\nInteresting raw notes.',
            filePath: 'paper.md',
          },
        ],
      });

      const firstCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'raw-workspace',
      });

      expect(firstCompile.skipped).toBe(false);
      expect(firstCompile.changedSourceIds).toEqual([]);
      expect(firstCompile.changedRawInputIds).toEqual(['paper-notes']);
      expect(firstCompile.updatedArtifactPaths).toEqual([
        'derived/index.md',
        'derived/raw/paper-notes/concept.md',
        'derived/raw/paper-notes/summary.md',
      ]);
      expect(catalog.listWorkspaceArtifactRawInputProvenance('raw-workspace', 'derived/raw/paper-notes/summary.md')).toEqual([
        expect.objectContaining({
          rawInputId: 'paper-notes',
        }),
      ]);

      catalog.upsertWorkspaceRawInput({
        id: 'paper-notes',
        workspaceId: 'raw-workspace',
        kind: 'markdown-dir',
        label: 'Paper Notes',
        sourcePath: join(root, 'paper-notes'),
        storagePath: 'raw/paper-notes',
        contentHash: 'hash-two',
        metadata: {
          absolutePath: join(root, 'paper-notes'),
        },
        chunks: [
          {
            sectionTitle: 'Paper',
            markdown: '# Paper\n\nUpdated raw notes.',
            filePath: 'paper.md',
          },
        ],
      });

      const secondCompile = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'raw-workspace',
      });

      expect(secondCompile.skipped).toBe(false);
      expect(secondCompile.changedRawInputIds).toEqual(['paper-notes']);
      expect(secondCompile.updatedArtifactPaths).toEqual([
        'derived/index.md',
        'derived/raw/paper-notes/concept.md',
        'derived/raw/paper-notes/summary.md',
      ]);
    } finally {
      catalog.close();
    }
  });

  it('renders deterministic graph navigation and backlink sections for compiled artifacts', async () => {
    const catalog = openCatalog({ dataDir: root });
    const source = buildSpec('hyperliquid');

    try {
      catalog.upsertSource(source);
      catalog.recordSuccessfulSnapshot({
        sourceId: source.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow for Hyperliquid.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'graph-workspace',
        label: 'Graph Workspace',
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
      catalog.bindWorkspaceSources('graph-workspace', [source.id]);

      await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'graph-workspace',
      });

      const summaryPath = join(root, 'workspaces', 'graph-workspace', 'derived', 'sources', 'hyperliquid', 'summary.md');
      const conceptPath = join(root, 'workspaces', 'graph-workspace', 'derived', 'concepts', 'hyperliquid.md');
      const summaryContent = readFileSync(summaryPath, 'utf8');
      const conceptContent = readFileSync(conceptPath, 'utf8');

      expect(summaryContent).toContain('## Graph Navigation');
      expect(summaryContent).toContain('### Outgoing Relations');
      expect(summaryContent).toContain('mentions');
      expect(summaryContent).toContain('[derived/concepts/hyperliquid.md](derived/concepts/hyperliquid.md)');
      expect(summaryContent).toContain('### Backlinks');
      expect(summaryContent).toContain('index_entry from [derived/index.md](derived/index.md)');
      expect(summaryContent).toContain('expands from [derived/concepts/hyperliquid.md](derived/concepts/hyperliquid.md)');

      expect(conceptContent).toContain('## Graph Navigation');
      expect(conceptContent).toContain('expands');
      expect(conceptContent).toContain('[derived/sources/hyperliquid/summary.md](derived/sources/hyperliquid/summary.md)');

      expect(catalog.listWorkspaceArtifactLinks({
        workspaceId: 'graph-workspace',
        artifactPath: 'derived/sources/hyperliquid/summary.md',
        direction: 'outgoing',
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relationKind: 'related_to',
          toPath: 'derived/index.md',
        }),
        expect.objectContaining({
          relationKind: 'mentions',
          toPath: 'derived/concepts/hyperliquid.md',
        }),
      ]));

      expect(catalog.listWorkspaceArtifactLinks({
        workspaceId: 'graph-workspace',
        artifactPath: 'derived/concepts/hyperliquid.md',
        direction: 'outgoing',
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relationKind: 'expands',
          toPath: 'derived/sources/hyperliquid/summary.md',
        }),
      ]));
    } finally {
      catalog.close();
    }
  });

  it('compiles dataset raw inputs with raw-input provenance preserved on derived artifacts', async () => {
    const catalog = openCatalog({ dataDir: root });

    try {
      catalog.createWorkspace({
        id: 'dataset-workspace',
        label: 'Dataset Workspace',
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

      catalog.upsertWorkspaceRawInput({
        id: 'fills-csv',
        workspaceId: 'dataset-workspace',
        kind: 'csv',
        label: 'Fills CSV',
        sourcePath: join(root, 'fills.csv'),
        storagePath: 'raw/fills-csv/fills.csv',
        contentHash: 'fills-csv-hash',
        metadata: {
          absolutePath: join(root, 'fills.csv'),
          rowCount: 2,
          columnCount: 3,
          columns: ['symbol', 'venue', 'volume'],
        },
        chunks: [
          {
            sectionTitle: 'Dataset Overview',
            markdown: '# Fills CSV\n\n- symbol: BTC\n- venue: hyperliquid\n- volume: 123',
            filePath: 'fills.csv',
          },
        ],
      });

      const result = await compileWorkspace({
        catalog,
        dataDir: root,
        workspaceId: 'dataset-workspace',
      });

      expect(result.changedRawInputIds).toEqual(['fills-csv']);
      expect(catalog.listWorkspaceArtifactRawInputProvenance('dataset-workspace', 'derived/raw/fills-csv/summary.md')).toEqual([
        expect.objectContaining({
          rawInputId: 'fills-csv',
        }),
      ]);
      expect(catalog.listWorkspaceArtifactRawInputProvenance('dataset-workspace', 'derived/raw/fills-csv/concept.md')).toEqual([
        expect.objectContaining({
          rawInputId: 'fills-csv',
        }),
      ]);
    } finally {
      catalog.close();
    }
  });
});
