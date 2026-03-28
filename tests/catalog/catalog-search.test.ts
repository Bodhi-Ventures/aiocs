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

    const search = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader/apps/mm',
    });

    expect(search.total).toBe(1);
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.chunkId).toBeDefined();
    expect(search.results[0]?.sourceId).toBe('hyperliquid');
    expect(search.results[0]?.snapshotId).toBe(success.snapshotId);

    const chunk = catalog.getChunkById(search.results[0]!.chunkId);
    expect(chunk?.markdown).toContain('maker flow');
  });

  it('supports paginated search with total counts', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'lighter',
      label: 'Lighter Docs',
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
    catalog.linkProject('/workspace/trader', ['lighter']);
    catalog.recordSuccessfulSnapshot({
      sourceId: 'lighter',
      pages: [
        {
          url: 'https://example.com/docs/one',
          title: 'Orders One',
          markdown: '# Orders One\n\nMaker flow alpha.',
        },
        {
          url: 'https://example.com/docs/two',
          title: 'Orders Two',
          markdown: '# Orders Two\n\nMaker flow beta.',
        },
        {
          url: 'https://example.com/docs/three',
          title: 'Orders Three',
          markdown: '# Orders Three\n\nMaker flow gamma.',
        },
      ],
    });

    const firstPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 0,
    });
    const secondPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 1,
    });
    const repeatedFirstPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 0,
    });

    expect(firstPage.total).toBe(3);
    expect(firstPage.limit).toBe(1);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.results).toHaveLength(1);

    expect(secondPage.total).toBe(3);
    expect(secondPage.limit).toBe(1);
    expect(secondPage.offset).toBe(1);
    expect(secondPage.results).toHaveLength(1);
    expect(secondPage.results[0]?.chunkId).not.toBe(firstPage.results[0]?.chunkId);
    expect(repeatedFirstPage.results[0]?.chunkId).toBe(firstPage.results[0]?.chunkId);
  });
});
