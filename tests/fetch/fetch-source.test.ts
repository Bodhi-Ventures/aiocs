import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { applyScopedAuthHeaders, fetchSource, runSourceCanary } from '../../src/fetch/fetch-source.js';
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

      expect(searchResults.results).toHaveLength(1);
      expect(searchResults.results[0]?.snapshotId).toBe(result.snapshotId);
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
        catalog.search({ query: 'clipboard-driven maker flow', sourceIds: [clipboardSpec.id] }).results,
      ).toHaveLength(1);
      expect(
        catalog.search({ query: 'fallback extraction', sourceIds: [readabilitySpec.id] }).results,
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('supports authenticated fetches with environment-backed headers and cookies', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });

    const spec = parseSourceSpecObject({
      id: 'authenticated-source',
      label: 'Authenticated Source',
      startUrls: [`${server.baseUrl}/auth/start`],
      allowedHosts: ['127.0.0.1'],
      discovery: {
        include: [`${server.baseUrl}/auth/**`],
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
      auth: {
        headers: [
          {
            name: 'x-aiocs-token',
            valueFromEnv: 'AIOCS_TEST_HEADER_TOKEN',
          },
        ],
        cookies: [
          {
            name: 'aiocs_session',
            valueFromEnv: 'AIOCS_TEST_COOKIE_TOKEN',
            domain: '127.0.0.1',
            path: '/',
          },
        ],
      },
    });

    try {
      catalog.upsertSource(spec);

      const result = await fetchSource({
        catalog,
        sourceId: spec.id,
        dataDir: root,
        env: {
          ...process.env,
          AIOCS_TEST_HEADER_TOKEN: 'header-secret',
          AIOCS_TEST_COOKIE_TOKEN: 'cookie-secret',
        },
      });

      expect(result.pageCount).toBe(1);
      expect(
        catalog.search({
          query: 'secret market structure docs',
          sourceIds: [spec.id],
        }).results,
      ).toHaveLength(1);
    } finally {
      await server.close();
      catalog.close();
    }
  });

  it('scopes authenticated headers to the source allowed hosts only', () => {
    const spec = parseSourceSpecObject({
      id: 'scoped-auth-source',
      label: 'Scoped Auth Source',
      startUrls: ['https://docs.example.com/start'],
      allowedHosts: ['docs.example.com'],
      discovery: {
        include: ['https://docs.example.com/**'],
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
      auth: {
        headers: [
          {
            name: 'x-aiocs-token',
            valueFromEnv: 'AIOCS_TEST_HEADER_TOKEN',
          },
        ],
        cookies: [],
      },
    });

    expect(applyScopedAuthHeaders(
      'https://docs.example.com/private',
      { accept: 'text/html' },
      [{ name: 'x-aiocs-token', value: 'header-secret', hosts: ['docs.example.com'] }],
    )).toMatchObject({
      accept: 'text/html',
      'x-aiocs-token': 'header-secret',
    });

    expect(applyScopedAuthHeaders(
      'https://cdn.example.com/asset.js',
      { accept: '*/*' },
      [{ name: 'x-aiocs-token', value: 'header-secret', hosts: ['docs.example.com'] }],
    )).toEqual({
      accept: '*/*',
    });
  });

  it('supports per-header host and path scoping for authenticated headers', () => {
    expect(applyScopedAuthHeaders(
      'https://docs.example.com/private/start',
      { accept: 'text/html' },
      [{
        name: 'x-aiocs-token',
        value: 'header-secret',
        hosts: ['docs.example.com'],
        include: ['https://docs.example.com/private/**'],
      }],
    )).toMatchObject({
      accept: 'text/html',
      'x-aiocs-token': 'header-secret',
    });

    expect(applyScopedAuthHeaders(
      'https://docs.example.com/public/start',
      { accept: 'text/html' },
      [{
        name: 'x-aiocs-token',
        value: 'header-secret',
        hosts: ['docs.example.com'],
        include: ['https://docs.example.com/private/**'],
      }],
    )).toEqual({
      accept: 'text/html',
    });
  });

  it('runs lightweight canary checks without creating a snapshot', async () => {
    const server = await startDocsServer();
    const catalog = openCatalog({ dataDir: root });

    const spec = parseSourceSpecObject({
      id: 'canary-source',
      label: 'Canary Source',
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
      canary: {
        everyHours: 6,
        checks: [
          {
            url: `${server.baseUrl}/clipboard/start`,
            expectedTitle: 'Clipboard Start',
            expectedText: 'Clipboard-driven maker flow docs.',
            minMarkdownLength: 20,
          },
        ],
      },
    });

    try {
      catalog.upsertSource(spec);

      const result = await runSourceCanary({
        catalog,
        sourceId: spec.id,
        env: process.env,
      });

      expect(result).toMatchObject({
        sourceId: spec.id,
        status: 'pass',
        summary: {
          passCount: 1,
          failCount: 0,
        },
        checks: [
          expect.objectContaining({
            url: `${server.baseUrl}/clipboard/start`,
            status: 'pass',
          }),
        ],
      });
      expect(catalog.listSnapshots(spec.id)).toHaveLength(0);
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
        }).results,
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
        }).results,
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
        }).results,
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
        }).results,
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
        }).results,
      ).toHaveLength(1);
      expect(
        catalog.search({
          query: 'raw mirror content should not replace the canonical html page',
          sourceIds: [spec.id],
        }).results,
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
        }).results,
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
        }).results,
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
        }).results,
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
        }).results,
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
        }).results,
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
