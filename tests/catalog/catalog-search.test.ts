import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

describe('Catalog search flow', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-catalog-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('searches latest successful snapshot for the linked project and ignores failed runs', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'hyperliquid',
      label: 'Hyperliquid Docs',
      startUrls: ['https://example.com/docs'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 50,
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
    };

    catalog.upsertSource(spec);
    catalog.linkProject('/workspace/trader', ['hyperliquid']);

    const success = catalog.recordSuccessfulSnapshot({
      sourceId: 'hyperliquid',
      detectedVersion: '2026.03',
      pages: [
        {
          url: 'https://example.com/docs/orders',
          title: 'Orders',
          markdown: '# Orders\n\nUse post-only orders for maker flow.',
        },
      ],
    });

    catalog.recordFailedFetchRun({
      sourceId: 'hyperliquid',
      errorMessage: 'timed out',
    });

    const results = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader/apps/mm',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBeDefined();
    expect(results[0]?.sourceId).toBe('hyperliquid');
    expect(results[0]?.snapshotId).toBe(success.snapshotId);

    const chunk = catalog.getChunkById(results[0]!.chunkId);
    expect(chunk?.markdown).toContain('maker flow');
  });
});
