import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';
import type { SourceContext } from '../../src/source-context.js';

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

type EvalCase = {
  name: string;
  sourceId: string;
  query: string;
  pages: Array<{
    url: string;
    title: string;
    markdown: string;
  }>;
  searchResults: Array<{
    pageUrl: string;
    pageTitle: string;
    sectionTitle: string;
    markdown: string;
    score: number;
    signals: Array<'lexical' | 'vector'>;
  }>;
  sourceContext?: SourceContext;
  expectedFirstPage: {
    url: string;
    title: string;
  };
};

const evalCases: EvalCase[] = [
  {
    name: 'hyperliquid websocket transport routes to websocket docs',
    sourceId: 'hyperliquid',
    query: 'websocket transport',
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
    searchResults: [
      {
        pageUrl: 'https://example.com/docs/support/api-questions',
        pageTitle: 'API questions',
        sectionTitle: 'API questions (1-3)',
        markdown: 'If you have websocket transport questions, ask in support.',
        score: 0.99,
        signals: ['vector'],
      },
      {
        pageUrl: 'https://example.com/docs/api/websocket-transport',
        pageTitle: 'WebSocket Transport',
        sectionTitle: 'WebSocket Transport (1-3)',
        markdown: 'Transport details for websocket clients.',
        score: 0.7,
        signals: ['lexical'],
      },
    ],
    expectedFirstPage: {
      url: 'https://example.com/docs/api/websocket-transport',
      title: 'WebSocket Transport',
    },
  },
  {
    name: 'bulk websocket auth prefers common-location websocket overview',
    sourceId: 'bulk-trade',
    query: 'bulk websocket auth',
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
    searchResults: [
      {
        pageUrl: 'https://example.com/docs/support/intro',
        pageTitle: 'Introduction',
        sectionTitle: 'Introduction (1-3)',
        markdown: 'General introduction and support overview.',
        score: 0.92,
        signals: ['vector'],
      },
    ],
    sourceContext: {
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
    },
    expectedFirstPage: {
      url: 'https://example.com/docs/api/websocket-overview',
      title: 'WebSocket Overview',
    },
  },
  {
    name: 'decibel mixed query keeps substantive rate-limit tokens',
    sourceId: 'decibel',
    query: 'api rate limits',
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
    searchResults: [
      {
        pageUrl: 'https://example.com/docs/api/introduction',
        pageTitle: 'API Overview',
        sectionTitle: 'API Overview (1-3)',
        markdown: 'General introduction to the API.',
        score: 0.96,
        signals: ['vector'],
      },
      {
        pageUrl: 'https://example.com/docs/api/rate-limits',
        pageTitle: 'Rate Limits',
        sectionTitle: 'Rate Limits (1-3)',
        markdown: 'Request limits, quotas, and burst rules.',
        score: 0.71,
        signals: ['lexical'],
      },
    ],
    expectedFirstPage: {
      url: 'https://example.com/docs/api/rate-limits',
      title: 'Rate Limits',
    },
  },
  {
    name: 'o1 ws auth avoids substring-based false exact matches',
    sourceId: 'o1-exchange',
    query: 'ws auth',
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
    searchResults: [
      {
        pageUrl: 'https://example.com/docs/news/authors',
        pageTitle: 'News Authors',
        sectionTitle: 'News Authors (1-3)',
        markdown: 'Editorial contributor directory.',
        score: 0.97,
        signals: ['vector'],
      },
      {
        pageUrl: 'https://example.com/docs/api/websocket-auth',
        pageTitle: 'WebSocket Auth',
        sectionTitle: 'WebSocket Auth (1-3)',
        markdown: 'Authentication for websocket sessions.',
        score: 0.69,
        signals: ['lexical'],
      },
    ],
    expectedFirstPage: {
      url: 'https://example.com/docs/api/websocket-auth',
      title: 'WebSocket Auth',
    },
  },
];

describe('retrieve eval matrix', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-retrieve-matrix-'));
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

  for (const evalCase of evalCases) {
    it(evalCase.name, async () => {
      const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
      catalog.upsertSource(buildSpec(evalCase.sourceId));
      const snapshot = catalog.recordSuccessfulSnapshot({
        sourceId: evalCase.sourceId,
        pages: evalCase.pages,
      });
      if (evalCase.sourceContext) {
        catalog.upsertSourceContext(evalCase.sourceId, evalCase.sourceContext);
      }
      catalog.close();

      searchHybridCatalogMock.mockResolvedValue({
        query: evalCase.query,
        total: evalCase.searchResults.length,
        limit: 20,
        offset: 0,
        hasMore: false,
        modeRequested: 'hybrid',
        modeUsed: 'hybrid',
        results: evalCase.searchResults.map((result, index) => ({
          chunkId: index + 1,
          sourceId: evalCase.sourceId,
          snapshotId: snapshot.snapshotId,
          pageKind: 'document',
          filePath: null,
          language: null,
          ...result,
        })),
      });

      const result = await retrieveContext(evalCase.query, {
        source: [evalCase.sourceId],
        mode: 'hybrid',
        pageLimit: 1,
      });

      expect(result.pages).toEqual([
        expect.objectContaining({
          sourceId: evalCase.sourceId,
          ...evalCase.expectedFirstPage,
        }),
      ]);
    });
  }
});
