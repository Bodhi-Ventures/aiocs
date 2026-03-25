import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { fetchSource } from '../../src/fetch/fetch-source.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';
import { startDocsServer } from '../helpers/docs-server.js';

describe('fetchSource', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-fetch-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('crawls selector-based pages and indexes the latest snapshot', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'selector-source',
      label: 'Selector Source',
      startUrls: [`${server.baseUrl}/selector/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector/**`],
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
    };

    try {
      catalog.upsertSource(spec);
      const result = await fetchSource({ catalog, sourceId: spec.id, dataDir: root });

      expect(result.pageCount).toBe(2);
      expect(catalog.listSnapshots(spec.id)).toHaveLength(1);

      const searchResults = catalog.search({
        query: 'market making docs',
        sourceIds: [spec.id],
      });

      expect(searchResults).toHaveLength(1);
      expect(searchResults[0]?.snapshotId).toBe(result.snapshotId);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('supports clipboard and readability extraction strategies', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });

    const clipboardSpec: SourceSpec = {
      id: 'clipboard-source',
      label: 'Clipboard Source',
      startUrls: [`${server.baseUrl}/clipboard/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard/**`],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'clipboardButton',
        interactions: [
          {
            action: 'click',
            selector: '#copy-page',
          },
        ],
        clipboardTimeoutMs: 5_000,
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    };

    const readabilitySpec: SourceSpec = {
      id: 'readability-source',
      label: 'Readability Source',
      startUrls: [`${server.baseUrl}/readability/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/readability/**`],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'readability',
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    };

    try {
      catalog.upsertSource(clipboardSpec);
      catalog.upsertSource(readabilitySpec);

      const clipboardResult = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });
      const readabilityResult = await fetchSource({ catalog, sourceId: readabilitySpec.id, dataDir: root });

      expect(clipboardResult.pageCount).toBe(2);
      expect(readabilityResult.pageCount).toBe(1);

      expect(
        catalog.search({ query: 'clipboard-driven maker flow', sourceIds: [clipboardSpec.id] }),
      ).toHaveLength(1);
      expect(
        catalog.search({ query: 'fallback extraction', sourceIds: [readabilitySpec.id] }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });
});
