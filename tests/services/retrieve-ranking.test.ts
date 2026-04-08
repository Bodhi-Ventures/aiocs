import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { scorePageCandidate } from '../../src/retrieval.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

const { searchHybridCatalogMock } = vi.hoisted(() => ({
  searchHybridCatalogMock: vi.fn(),
}));

vi.mock('../../src/hybrid/search.js', () => ({
  searchHybridCatalog: searchHybridCatalogMock,
}));

import { retrieveContext } from '../../src/services.js';

function buildSpec(id: string): SourceSpec {
  return {
    kind: 'web',
    id,
    label: `${id} docs`,
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
}

describe('retrieveContext ranking', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-retrieve-ranking-'));
    previousDataDir = process.env.AIOCS_DATA_DIR;
    previousConfigDir = process.env.AIOCS_CONFIG_DIR;
    process.env.AIOCS_DATA_DIR = join(root, 'data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'config');
    searchHybridCatalogMock.mockReset();
  });

  afterEach(() => {
    if (typeof previousDataDir === 'string') {
      process.env.AIOCS_DATA_DIR = previousDataDir;
    } else {
      delete process.env.AIOCS_DATA_DIR;
    }

    if (typeof previousConfigDir === 'string') {
      process.env.AIOCS_CONFIG_DIR = previousConfigDir;
    } else {
      delete process.env.AIOCS_CONFIG_DIR;
    }

    rmSync(root, { recursive: true, force: true });
  });

  it('prefers title and path matches over raw chunk order for navigational queries', async () => {
    const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
    catalog.upsertSource(buildSpec('hyperliquid'));
    const snapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'hyperliquid',
      pages: [
        {
          url: 'https://example.com/docs/support/api-questions',
          title: 'API questions',
          markdown: '# API questions\n\nIf you have websocket transport questions, ask in support.',
        },
        {
          url: 'https://example.com/docs/api/websocket-transport',
          title: 'WebSocket Transport',
          markdown: '# WebSocket Transport\n\nTransport details for websocket clients.',
        },
      ],
    });
    catalog.close();

    searchHybridCatalogMock.mockResolvedValue({
      query: 'websocket transport',
      total: 2,
      limit: 20,
      offset: 0,
      hasMore: false,
      modeRequested: 'hybrid',
      modeUsed: 'hybrid',
      results: [
        {
          chunkId: 1001,
          sourceId: 'hyperliquid',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/support/api-questions',
          pageTitle: 'API questions',
          sectionTitle: 'API questions (1-3)',
          markdown: 'If you have websocket transport questions, ask in support.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.99,
          signals: ['vector'],
        },
        {
          chunkId: 1002,
          sourceId: 'hyperliquid',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/api/websocket-transport',
          pageTitle: 'WebSocket Transport',
          sectionTitle: 'WebSocket Transport (1-3)',
          markdown: 'Transport details for websocket clients.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.7,
          signals: ['lexical'],
        },
      ],
    });

    const result = await retrieveContext('websocket transport', {
      source: ['hyperliquid'],
      mode: 'hybrid',
      pageLimit: 1,
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        sourceId: 'hyperliquid',
        url: 'https://example.com/docs/api/websocket-transport',
        title: 'WebSocket Transport',
      }),
    ]);
  });

  it('injects matched common locations as page candidates during retrieval', async () => {
    const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
    catalog.upsertSource(buildSpec('bulk-trade'));
    const snapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'bulk-trade',
      pages: [
        {
          url: 'https://example.com/docs/support/intro',
          title: 'Introduction',
          markdown: '# Introduction\n\nGeneral introduction and support overview.',
        },
        {
          url: 'https://example.com/docs/api/websocket-overview',
          title: 'WebSocket Overview',
          markdown: '# WebSocket Overview\n\nRealtime subscription and websocket auth details.',
        },
      ],
    });
    catalog.upsertSourceContext('bulk-trade', {
      purpose: 'Bulk Trade API docs',
      summary: 'Exchange API docs for traders and integrators.',
      topicHints: ['websocket', 'rest api'],
      commonLocations: [
        {
          label: 'WebSocket docs',
          url: 'https://example.com/docs/api/websocket-overview',
          note: 'Start here for realtime API usage.',
        },
      ],
      gotchas: [],
      authNotes: [],
    });
    catalog.close();

    searchHybridCatalogMock.mockResolvedValue({
      query: 'bulk websocket auth',
      total: 1,
      limit: 20,
      offset: 0,
      hasMore: false,
      modeRequested: 'hybrid',
      modeUsed: 'hybrid',
      results: [
        {
          chunkId: 2001,
          sourceId: 'bulk-trade',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/support/intro',
          pageTitle: 'Introduction',
          sectionTitle: 'Introduction (1-3)',
          markdown: 'General introduction and support overview.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.92,
          signals: ['vector'],
        },
      ],
    });

    const result = await retrieveContext('bulk websocket auth', {
      source: ['bulk-trade'],
      mode: 'hybrid',
      pageLimit: 1,
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        sourceId: 'bulk-trade',
        url: 'https://example.com/docs/api/websocket-overview',
        title: 'WebSocket Overview',
      }),
    ]);
  });

  it('keeps substantive query tokens when ranking mixed navigational queries', async () => {
    const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
    catalog.upsertSource(buildSpec('decibel'));
    const snapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'decibel',
      pages: [
        {
          url: 'https://example.com/docs/api/introduction',
          title: 'API Overview',
          markdown: '# API Overview\n\nGeneral introduction to the API.',
        },
        {
          url: 'https://example.com/docs/api/rate-limits',
          title: 'Rate Limits',
          markdown: '# Rate Limits\n\nRequest limits, quotas, and burst rules.',
        },
      ],
    });
    catalog.close();

    searchHybridCatalogMock.mockResolvedValue({
      query: 'api rate limits',
      total: 2,
      limit: 20,
      offset: 0,
      hasMore: false,
      modeRequested: 'hybrid',
      modeUsed: 'hybrid',
      results: [
        {
          chunkId: 3001,
          sourceId: 'decibel',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/api/introduction',
          pageTitle: 'API Overview',
          sectionTitle: 'API Overview (1-3)',
          markdown: 'General introduction to the API.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.96,
          signals: ['vector'],
        },
        {
          chunkId: 3002,
          sourceId: 'decibel',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/api/rate-limits',
          pageTitle: 'Rate Limits',
          sectionTitle: 'Rate Limits (1-3)',
          markdown: 'Request limits, quotas, and burst rules.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.71,
          signals: ['lexical'],
        },
      ],
    });

    const result = await retrieveContext('api rate limits', {
      source: ['decibel'],
      mode: 'hybrid',
      pageLimit: 1,
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        sourceId: 'decibel',
        url: 'https://example.com/docs/api/rate-limits',
        title: 'Rate Limits',
      }),
    ]);
  });

  it('does not treat substring matches as exact title coverage', async () => {
    const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
    catalog.upsertSource(buildSpec('o1-exchange'));
    const snapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'o1-exchange',
      pages: [
        {
          url: 'https://example.com/docs/news/authors',
          title: 'News Authors',
          markdown: '# News Authors\n\nEditorial contributor directory.',
        },
        {
          url: 'https://example.com/docs/api/websocket-auth',
          title: 'WebSocket Auth',
          markdown: '# WebSocket Auth\n\nAuthentication for websocket sessions.',
        },
      ],
    });
    catalog.close();

    searchHybridCatalogMock.mockResolvedValue({
      query: 'ws auth',
      total: 2,
      limit: 20,
      offset: 0,
      hasMore: false,
      modeRequested: 'hybrid',
      modeUsed: 'hybrid',
      results: [
        {
          chunkId: 4001,
          sourceId: 'o1-exchange',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/news/authors',
          pageTitle: 'News Authors',
          sectionTitle: 'News Authors (1-3)',
          markdown: 'Editorial contributor directory.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.97,
          signals: ['vector'],
        },
        {
          chunkId: 4002,
          sourceId: 'o1-exchange',
          snapshotId: snapshot.snapshotId,
          pageUrl: 'https://example.com/docs/api/websocket-auth',
          pageTitle: 'WebSocket Auth',
          sectionTitle: 'WebSocket Auth (1-3)',
          markdown: 'Authentication for websocket sessions.',
          pageKind: 'document',
          filePath: null,
          language: null,
          score: 0.69,
          signals: ['lexical'],
        },
      ],
    });

    const result = await retrieveContext('ws auth', {
      source: ['o1-exchange'],
      mode: 'hybrid',
      pageLimit: 1,
    });

    expect(result.pages).toEqual([
      expect.objectContaining({
        sourceId: 'o1-exchange',
        url: 'https://example.com/docs/api/websocket-auth',
        title: 'WebSocket Auth',
      }),
    ]);
  });

  it('uses token coverage instead of substring coverage for exact boosts', () => {
    const falsePositive = scorePageCandidate('ws auth', {
      pageTitle: 'News Authors',
      pageReference: 'https://example.com/docs/news/authors',
      sectionTitles: ['News Authors (1-3)'],
      bestLexicalScore: 0,
      bestVectorScore: 0.97,
      learningScore: 0,
      sourceHintScore: 0,
      commonLocationScore: 0,
    });

    const intendedPage = scorePageCandidate('ws auth', {
      pageTitle: 'WebSocket Auth',
      pageReference: 'https://example.com/docs/api/websocket-auth',
      sectionTitles: ['WebSocket Auth (1-3)'],
      bestLexicalScore: 0.69,
      bestVectorScore: 0.69,
      learningScore: 0,
      sourceHintScore: 0,
      commonLocationScore: 0,
    });

    expect(intendedPage).toBeGreaterThan(falsePositive);
  });
});
