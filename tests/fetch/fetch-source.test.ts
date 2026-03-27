import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { fetchSource } from '../../src/fetch/fetch-source.js';
import { parseSourceSpecObject, type SourceSpec } from '../../src/spec/source-spec.js';
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
        clipboardTimeoutMs: 1_500,
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

  it('ingests discovered raw markdown assets without requiring browser copy controls', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'clipboard-raw-source',
      label: 'Clipboard Raw Source',
      startUrls: [`${server.baseUrl}/clipboard-raw/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-raw/**`],
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
    });

    try {
      catalog.upsertSource(spec);
      const result = await fetchSource({ catalog, sourceId: spec.id, dataDir: root });

      expect(result.pageCount).toBe(2);
      expect(
        catalog.search({
          query: 'this markdown asset should be ingested directly',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('skips discovered pages that return 404 instead of aborting the source fetch', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'selector-missing-source',
      label: 'Selector Missing Source',
      startUrls: [`${server.baseUrl}/selector-missing/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector-missing/**`],
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

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'only the valid page should be indexed',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('ignores GitBook internal export URLs during discovery', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'selector-gitbook-source',
      label: 'Selector GitBook Source',
      startUrls: [`${server.baseUrl}/selector-gitbook/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/**`],
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

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'gitbook internal export pages should be ignored',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('deduplicates mirrored raw markdown pages when the canonical html page is also discovered', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'selector-raw-mirror-source',
      label: 'Selector Raw Mirror Source',
      startUrls: [`${server.baseUrl}/selector-raw-mirror/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector-raw-mirror/**`],
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
      expect(
        catalog.search({
          query: 'this content should only appear once in the catalog',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('still prefers the canonical html page when a raw markdown mirror is discovered first', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      id: 'selector-prefer-html-raw-first-source',
      label: 'Selector Prefer Html Raw First Source',
      startUrls: [`${server.baseUrl}/selector-prefer-html-raw-first/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector-prefer-html-raw-first/**`],
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
      expect(
        catalog.search({
          query: 'canonical html content should win when mirrors compete',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(1);
      expect(
        catalog.search({
          query: 'raw mirror content should not replace the canonical html page',
          sourceIds: [spec.id],
        }),
      ).toHaveLength(0);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('supports hover-driven clipboard markdown flows that require desktop viewport', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const clipboardSpec = parseSourceSpecObject({
      id: 'clipboard-advanced-source',
      label: 'Clipboard Advanced Source',
      startUrls: [`${server.baseUrl}/clipboard-advanced/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-advanced/**`],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'clipboardButton',
        interactions: [
          {
            action: 'hover',
            selector: '#cta-root',
          },
          {
            action: 'click',
            selector: '#menu-trigger',
          },
          {
            action: 'click',
            selector: '#copy-menu-item',
          },
        ],
        clipboardTimeoutMs: 2_600,
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    });

    try {
      catalog.upsertSource(clipboardSpec);
      const result = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'desktop-only markdown copy flow docs',
          sourceIds: [clipboardSpec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('supports clipboard copies even when the clipboard already contains the same markdown', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const clipboardSpec = parseSourceSpecObject({
      id: 'clipboard-repeat-source',
      label: 'Clipboard Repeat Source',
      startUrls: [`${server.baseUrl}/clipboard-same/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-same/**`],
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
    });

    try {
      catalog.upsertSource(clipboardSpec);
      const result = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'clipboard content stays identical across repeated copies',
          sourceIds: [clipboardSpec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('retries clipboard copies after an initial no-op interaction', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const clipboardSpec = parseSourceSpecObject({
      id: 'clipboard-retry-source',
      label: 'Clipboard Retry Source',
      startUrls: [`${server.baseUrl}/clipboard-retry/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-retry/**`],
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
    });

    try {
      catalog.upsertSource(clipboardSpec);
      const result = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'clipboard copy succeeds after the first interaction does nothing',
          sourceIds: [clipboardSpec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('retries multi-step clipboard menus when the first sequence leaves the menu closed', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const clipboardSpec = parseSourceSpecObject({
      id: 'clipboard-retry-menu-source',
      label: 'Clipboard Retry Menu Source',
      startUrls: [`${server.baseUrl}/clipboard-retry-menu/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-retry-menu/**`],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'clipboardButton',
        interactions: [
          {
            action: 'click',
            selector: '#ask-ai',
          },
          {
            action: 'click',
            selector: '#copy-markdown',
            timeoutMs: 250,
          },
        ],
        clipboardTimeoutMs: 2_000,
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    });

    try {
      catalog.upsertSource(clipboardSpec);
      const result = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'follow-up copy control appears after the first full menu sequence fails',
          sourceIds: [clipboardSpec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  }, 5_000);

  it('honors longer interaction timeouts when controls become visible slowly', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const clipboardSpec = parseSourceSpecObject({
      id: 'clipboard-delayed-visibility-source',
      label: 'Clipboard Delayed Visibility Source',
      startUrls: [`${server.baseUrl}/clipboard-delayed-visibility/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/clipboard-delayed-visibility/**`],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'clipboardButton',
        interactions: [
          {
            action: 'click',
            selector: '#copy-page',
            timeoutMs: 1_500,
          },
        ],
        clipboardTimeoutMs: 3_000,
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    });

    try {
      catalog.upsertSource(clipboardSpec);
      const result = await fetchSource({ catalog, sourceId: clipboardSpec.id, dataDir: root });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'slow controls can still be handled with longer interaction timeouts',
          sourceIds: [clipboardSpec.id],
        }),
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  }, 7_000);

  it('retries transient source fetch failures up to three attempts before succeeding', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'selector-flaky-source',
      label: 'Selector Flaky Source',
      startUrls: [`${server.baseUrl}/selector-flaky/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector-flaky/**`],
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

    try {
      catalog.upsertSource(spec);

      const result = await fetchSource({ catalog, sourceId: spec.id, dataDir: root });
      expect(result.pageCount).toBe(1);

      const countsResponse = await fetch(`${server.baseUrl}/__counts?path=/selector-flaky/start`);
      const counts = await countsResponse.json() as { count: number };
      expect(counts.count).toBe(3);

      const db = new Database(join(root, 'catalog.sqlite'));
      try {
        const successRuns = db.prepare('SELECT COUNT(*) AS count FROM fetch_runs WHERE source_id = ? AND status = ?')
          .get(spec.id, 'success') as { count: number };
        const failedRuns = db.prepare('SELECT COUNT(*) AS count FROM fetch_runs WHERE source_id = ? AND status = ?')
          .get(spec.id, 'failed') as { count: number };
        expect(successRuns.count).toBe(1);
        expect(failedRuns.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('records a single failed run only after exhausting three attempts', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'selector-always-fail-source',
      label: 'Selector Always Fail Source',
      startUrls: [`${server.baseUrl}/selector-always-fail/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/selector-always-fail/**`],
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

    try {
      catalog.upsertSource(spec);

      await expect(fetchSource({ catalog, sourceId: spec.id, dataDir: root }))
        .rejects
        .toThrow(`No pages fetched for source '${spec.id}'`);

      const countsResponse = await fetch(`${server.baseUrl}/__counts?path=/selector-always-fail/start`);
      const counts = await countsResponse.json() as { count: number };
      expect(counts.count).toBe(3);

      const db = new Database(join(root, 'catalog.sqlite'));
      try {
        const successRuns = db.prepare('SELECT COUNT(*) AS count FROM fetch_runs WHERE source_id = ? AND status = ?')
          .get(spec.id, 'success') as { count: number };
        const failedRuns = db.prepare('SELECT COUNT(*) AS count FROM fetch_runs WHERE source_id = ? AND status = ?')
          .get(spec.id, 'failed') as { count: number };
        expect(successRuns.count).toBe(0);
        expect(failedRuns.count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await server.close();
      catalog.close();
    }
  });
});
