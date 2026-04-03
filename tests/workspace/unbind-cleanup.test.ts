import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { searchWorkspaceCatalog, unbindWorkspaceSources } from '../../src/services.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import {
  getSourceArtifactBundle,
  getWorkspaceIndexPath,
  getWorkspaceOutputPath,
} from '../../src/workspace/artifacts.js';
import { writeWorkspaceArtifact } from '../../src/workspace/storage.js';

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

describe('workspace unbind cleanup', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-unbind-'));
    previousDataDir = process.env.AIOCS_DATA_DIR;
    previousConfigDir = process.env.AIOCS_CONFIG_DIR;
    process.env.AIOCS_DATA_DIR = join(root, 'data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'config');
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

  it('removes stale derived artifacts for unbound sources so they are no longer searchable', async () => {
    const dataDir = process.env.AIOCS_DATA_DIR as string;
    const catalog = openCatalog({ dataDir });
    const sourceA = buildSpec('hyperliquid');
    const sourceB = buildSpec('nado');
    const summaryA = getSourceArtifactBundle(sourceA.id).summaryPath;
    const conceptA = getSourceArtifactBundle(sourceA.id).conceptPath;
    const summaryB = getSourceArtifactBundle(sourceB.id).summaryPath;
    const conceptB = getSourceArtifactBundle(sourceB.id).conceptPath;
    const indexPath = getWorkspaceIndexPath();
    const reportPath = getWorkspaceOutputPath('report', 'brief');

    try {
      catalog.upsertSource(sourceA);
      catalog.upsertSource(sourceB);
      const snapshotA = catalog.recordSuccessfulSnapshot({
        sourceId: sourceA.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nAlpha maker flow.',
          },
        ],
      });
      const snapshotB = catalog.recordSuccessfulSnapshot({
        sourceId: sourceB.id,
        pages: [
          {
            url: 'https://example.com/docs/nado/orders',
            title: 'Orders',
            markdown: '# Orders\n\nBeta trigger flow.',
          },
        ],
      });

      catalog.createWorkspace({
        id: 'cleanup',
        label: 'Cleanup Workspace',
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
      catalog.bindWorkspaceSources('cleanup', [sourceA.id, sourceB.id]);

      for (const [path, content] of [
        [summaryA, '# Alpha Summary\n\nAlpha maker flow.'],
        [conceptA, '# Alpha Concepts\n\nAlpha concept.'],
        [summaryB, '# Beta Summary\n\nBeta trigger flow.'],
        [conceptB, '# Beta Concepts\n\nBeta concept.'],
        [indexPath, '# Workspace Index\n\nAlpha and Beta.'],
        [reportPath, '# Brief\n\nAlpha and Beta report.'],
      ] as Array<[string, string]>) {
        await writeWorkspaceArtifact({
          dataDir,
          workspaceId: 'cleanup',
          path,
          content,
        });
      }

      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: summaryA,
        kind: 'summary',
        contentHash: 'hash-a-summary',
        compilerMetadata: { provider: 'lmstudio' },
        stale: false,
        chunks: [{ sectionTitle: 'alpha', markdown: '# Alpha Summary\n\nAlpha maker flow.' }],
        provenance: [{ sourceId: sourceA.id, snapshotId: snapshotA.snapshotId, chunkIds: [1] }],
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: conceptA,
        kind: 'concept',
        contentHash: 'hash-a-concept',
        compilerMetadata: { provider: 'lmstudio' },
        stale: false,
        chunks: [{ sectionTitle: 'alpha', markdown: '# Alpha Concepts\n\nAlpha concept.' }],
        provenance: [{ sourceId: sourceA.id, snapshotId: snapshotA.snapshotId, chunkIds: [1] }],
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: summaryB,
        kind: 'summary',
        contentHash: 'hash-b-summary',
        compilerMetadata: { provider: 'lmstudio' },
        stale: false,
        chunks: [{ sectionTitle: 'beta', markdown: '# Beta Summary\n\nBeta trigger flow.' }],
        provenance: [{ sourceId: sourceB.id, snapshotId: snapshotB.snapshotId, chunkIds: [2] }],
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: conceptB,
        kind: 'concept',
        contentHash: 'hash-b-concept',
        compilerMetadata: { provider: 'lmstudio' },
        stale: false,
        chunks: [{ sectionTitle: 'beta', markdown: '# Beta Concepts\n\nBeta concept.' }],
        provenance: [{ sourceId: sourceB.id, snapshotId: snapshotB.snapshotId, chunkIds: [2] }],
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: indexPath,
        kind: 'index',
        contentHash: 'hash-index',
        compilerMetadata: { provider: 'deterministic' },
        stale: false,
        chunks: [{ sectionTitle: 'index', markdown: '# Workspace Index\n\nAlpha and Beta.' }],
        provenance: [
          { sourceId: sourceA.id, snapshotId: snapshotA.snapshotId, chunkIds: [] },
          { sourceId: sourceB.id, snapshotId: snapshotB.snapshotId, chunkIds: [] },
        ],
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'cleanup',
        path: reportPath,
        kind: 'report',
        contentHash: 'hash-report',
        compilerMetadata: { provider: 'lmstudio' },
        stale: false,
        chunks: [{ sectionTitle: 'report', markdown: '# Brief\n\nAlpha and Beta report.' }],
        provenance: [
          { sourceId: sourceA.id, snapshotId: snapshotA.snapshotId, chunkIds: [1] },
          { sourceId: sourceB.id, snapshotId: snapshotB.snapshotId, chunkIds: [2] },
        ],
      });
    } finally {
      catalog.close();
    }

    await unbindWorkspaceSources({
      workspaceId: 'cleanup',
      sourceIds: [sourceA.id],
    });

    const reopened = openCatalog({ dataDir });
    try {
      expect(reopened.getWorkspaceArtifact('cleanup', summaryA)).toBeNull();
      expect(reopened.getWorkspaceArtifact('cleanup', conceptA)).toBeNull();
      expect(reopened.getWorkspaceArtifact('cleanup', indexPath)).toBeNull();
      expect(reopened.getWorkspaceArtifact('cleanup', reportPath)).toBeNull();
      expect(reopened.getWorkspaceArtifact('cleanup', summaryB)).toEqual(
        expect.objectContaining({ path: summaryB }),
      );
      expect(reopened.getWorkspaceArtifact('cleanup', conceptB)).toEqual(
        expect.objectContaining({ path: conceptB }),
      );
    } finally {
      reopened.close();
    }

    expect(existsSync(join(dataDir, 'workspaces', 'cleanup', summaryA))).toBe(false);
    expect(existsSync(join(dataDir, 'workspaces', 'cleanup', conceptA))).toBe(false);
    expect(existsSync(join(dataDir, 'workspaces', 'cleanup', indexPath))).toBe(false);
    expect(existsSync(join(dataDir, 'workspaces', 'cleanup', reportPath))).toBe(false);

    const search = await searchWorkspaceCatalog('cleanup', 'Alpha', { scope: 'derived' });
    expect(search.results).toEqual([]);
  });
});
