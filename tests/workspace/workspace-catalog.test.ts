import { mkdtempSync, rmSync } from 'node:fs';
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
});
