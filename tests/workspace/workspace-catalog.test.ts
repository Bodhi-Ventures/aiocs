import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';

describe('workspace catalog', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-catalog-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates and lists workspaces with compiler metadata', () => {
    const catalog = openCatalog({ dataDir: root });

    try {
      catalog.createWorkspace({
        id: 'market-structure',
        label: 'Market Structure',
        purpose: 'Compile research notes about exchange microstructure.',
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

      expect(catalog.listWorkspaces()).toEqual([
        expect.objectContaining({
          id: 'market-structure',
          label: 'Market Structure',
          purpose: 'Compile research notes about exchange microstructure.',
          compilerProfile: expect.objectContaining({
            provider: 'lmstudio',
            model: 'google/gemma-4-26b-a4b',
          }),
          defaultOutputFormats: ['report', 'slides'],
          bindingCount: 0,
          artifactCount: 0,
        }),
      ]);
    } finally {
      catalog.close();
    }
  });

  it('binds sources and records compile runs, artifacts, and provenance', () => {
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
      const snapshot = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Orders',
            markdown: '# Orders\n\nPlace and cancel orders.',
          },
        ],
      });

      const chunk = catalog.search({
        query: 'cancel orders',
        sourceIds: [spec.id],
        all: true,
      }).results[0];

      expect(chunk).toBeDefined();

      catalog.createWorkspace({
        id: 'orders-research',
        label: 'Orders Research',
        purpose: 'Research order lifecycle flows.',
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

      catalog.bindWorkspaceSources('orders-research', [spec.id]);
      catalog.recordWorkspaceCompileRun({
        workspaceId: 'orders-research',
        status: 'success',
        sourceFingerprint: 'fingerprint-one',
        artifactCount: 1,
      });

      catalog.upsertWorkspaceArtifact({
        workspaceId: 'orders-research',
        path: 'derived/concepts/orders.md',
        kind: 'concept',
        contentHash: 'hash-orders',
        compilerMetadata: {
          model: 'google/gemma-4-26b-a4b',
          promptKind: 'concept',
        },
        stale: false,
        chunks: [
          {
            sectionTitle: 'Orders',
            markdown: '# Orders\n\nOrders are used to open and close positions.',
          },
        ],
        provenance: [
          {
            sourceId: spec.id,
            snapshotId: snapshot.snapshotId,
            chunkIds: [chunk!.chunkId],
          },
        ],
      });

      expect(catalog.getWorkspace('orders-research')).toEqual(
        expect.objectContaining({
          id: 'orders-research',
          bindingCount: 1,
          artifactCount: 1,
          lastCompileStatus: 'success',
        }),
      );

      expect(catalog.listWorkspaceSourceBindings('orders-research')).toEqual([
        expect.objectContaining({
          sourceId: 'hyperliquid',
        }),
      ]);

      expect(catalog.listWorkspaceCompileRuns('orders-research')).toEqual([
        expect.objectContaining({
          workspaceId: 'orders-research',
          status: 'success',
          sourceFingerprint: 'fingerprint-one',
          artifactCount: 1,
        }),
      ]);

      expect(catalog.listWorkspaceArtifacts('orders-research')).toEqual([
        expect.objectContaining({
          path: 'derived/concepts/orders.md',
          kind: 'concept',
          stale: false,
        }),
      ]);

      expect(catalog.getWorkspaceArtifact('orders-research', 'derived/concepts/orders.md')).toEqual(
        expect.objectContaining({
          path: 'derived/concepts/orders.md',
          kind: 'concept',
        }),
      );

      expect(catalog.listWorkspaceArtifactProvenance('orders-research', 'derived/concepts/orders.md')).toEqual([
        expect.objectContaining({
          sourceId: 'hyperliquid',
          snapshotId: snapshot.snapshotId,
          chunkIds: [chunk!.chunkId],
        }),
      ]);
    } finally {
      catalog.close();
    }
  });

  it('tracks auto-compile jobs, raw inputs, links, sync targets, and question runs', () => {
    const catalog = openCatalog({ dataDir: root });

    try {
      catalog.createWorkspace({
        id: 'research-desk',
        label: 'Research Desk',
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

      expect(catalog.getWorkspace('research-desk')).toEqual(
        expect.objectContaining({
          autoCompileEnabled: true,
        }),
      );

      catalog.updateWorkspaceAutoCompile({
        workspaceId: 'research-desk',
        autoCompileEnabled: false,
      });
      expect(catalog.getWorkspace('research-desk')).toEqual(
        expect.objectContaining({
          autoCompileEnabled: false,
        }),
      );

      writeFileSync(join(root, 'paper.md'), '# Paper\n\nInteresting raw notes.');
      const rawInput = catalog.upsertWorkspaceRawInput({
        id: 'markdown-paper',
        workspaceId: 'research-desk',
        kind: 'markdown-dir',
        label: 'Paper Notes',
        sourcePath: join(root, 'paper.md'),
        storagePath: 'raw/markdown-paper',
        contentHash: 'raw-hash',
        metadata: {
          absolutePath: join(root, 'paper.md'),
        },
        chunks: [
          {
            sectionTitle: 'Paper',
            markdown: '# Paper\n\nInteresting raw notes.',
            filePath: 'paper.md',
          },
        ],
      });
      expect(rawInput.chunkCount).toBe(1);
      expect(catalog.listWorkspaceRawInputs('research-desk')).toHaveLength(1);
      expect(catalog.searchWorkspaceRawInputs({
        workspaceId: 'research-desk',
        query: 'interesting raw notes',
      }).results).toEqual([
        expect.objectContaining({
          rawInputId: 'markdown-paper',
          label: 'Paper Notes',
        }),
      ]);

      catalog.upsertWorkspaceArtifact({
        workspaceId: 'research-desk',
        path: 'derived/raw/markdown-paper/summary.md',
        kind: 'summary',
        contentHash: 'artifact-hash',
        compilerMetadata: {
          provider: 'lmstudio',
          promptKind: 'summary',
        },
        stale: false,
        chunks: [
          {
            sectionTitle: 'Summary',
            markdown: '# Summary\n\nCompiled raw summary.',
          },
        ],
        provenance: [],
        rawInputProvenance: [
          {
            rawInputId: 'markdown-paper',
            chunkIds: [1],
          },
        ],
        links: [
          {
            fromPath: 'derived/raw/markdown-paper/summary.md',
            toPath: 'derived/index.md',
            relationKind: 'index_entry',
            anchorText: 'derived/index.md',
          },
        ],
      });

      expect(catalog.listWorkspaceArtifactRawInputProvenance('research-desk', 'derived/raw/markdown-paper/summary.md')).toEqual([
        expect.objectContaining({
          rawInputId: 'markdown-paper',
          chunkIds: [1],
        }),
      ]);
      expect(catalog.listWorkspaceArtifactLinks({
        workspaceId: 'research-desk',
        artifactPath: 'derived/raw/markdown-paper/summary.md',
        direction: 'outgoing',
      })).toEqual([
        expect.objectContaining({
          fromPath: 'derived/raw/markdown-paper/summary.md',
          toPath: 'derived/index.md',
          relationKind: 'index_entry',
        }),
      ]);

      const queued = catalog.enqueueWorkspaceCompile({
        workspaceId: 'research-desk',
        rawInputIds: ['markdown-paper'],
        requestedFingerprint: 'fp-1',
      });
      expect(queued).toEqual(
        expect.objectContaining({
          status: 'pending',
          requestedRawInputIds: ['markdown-paper'],
          requestedFingerprint: 'fp-1',
        }),
      );
      const claimed = catalog.claimNextWorkspaceCompileJob();
      expect(claimed).toEqual(
        expect.objectContaining({
          workspaceId: 'research-desk',
          status: 'running',
        }),
      );
      catalog.completeWorkspaceCompileJob({
        workspaceId: 'research-desk',
        completedFingerprint: 'fp-1',
      });
      expect(catalog.getWorkspaceCompileJob('research-desk')).toEqual(
        expect.objectContaining({
          status: 'succeeded',
          requestedFingerprint: 'fp-1',
        }),
      );

      catalog.upsertWorkspaceSyncTarget({
        workspaceId: 'research-desk',
        kind: 'obsidian',
        targetPath: '/vault',
        exportSubdir: 'aiocs/research-desk',
        lastSyncedAt: '2026-04-03T00:00:00.000Z',
        lastSyncStatus: 'success',
      });
      expect(catalog.listWorkspaceSyncTargets('research-desk')).toEqual([
        expect.objectContaining({
          kind: 'obsidian',
          targetPath: '/vault',
        }),
      ]);

      const questionRun = catalog.recordWorkspaceQuestionRun({
        workspaceId: 'research-desk',
        question: 'Summarize the raw notes',
        format: 'note',
        artifactPath: 'derived/notes/raw-notes.md',
        status: 'success',
      });
      expect(questionRun).toEqual(
        expect.objectContaining({
          workspaceId: 'research-desk',
          format: 'note',
        }),
      );
      expect(catalog.listWorkspaceQuestionRuns('research-desk')).toHaveLength(1);
    } finally {
      catalog.close();
    }
  });
});
