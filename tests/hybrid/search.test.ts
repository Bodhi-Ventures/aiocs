import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { searchHybridCatalog } from '../../src/hybrid/search.js';
import type { HybridRuntimeConfig } from '../../src/runtime/hybrid-config.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

const { embedTextsMock, vectorSearchMock } = vi.hoisted(() => ({
  embedTextsMock: vi.fn(),
  vectorSearchMock: vi.fn(),
}));

vi.mock('../../src/hybrid/ollama.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hybrid/ollama.js')>('../../src/hybrid/ollama.js');
  return {
    ...actual,
    embedTexts: embedTextsMock,
  };
});

vi.mock('../../src/hybrid/qdrant.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hybrid/qdrant.js')>('../../src/hybrid/qdrant.js');
  return {
    ...actual,
    AiocsVectorStore: class {
      async search(...args: unknown[]) {
        return vectorSearchMock(...args);
      }
    },
  };
});

const baseConfig: HybridRuntimeConfig = {
  defaultSearchMode: 'auto',
  qdrantUrl: 'http://127.0.0.1:6333',
  qdrantCollection: 'aiocs_docs_chunks',
  qdrantTimeoutMs: 1_000,
  embeddingProvider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaTimeoutMs: 1_000,
  ollamaMaxInputChars: 4_000,
  embeddingBatchSize: 16,
  embeddingJobsPerCycle: 1,
  lexicalCandidateWindow: 20,
  vectorCandidateWindow: 20,
  rrfK: 60,
};

function buildSpec(id: string): SourceSpec {
  return {
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

describe('hybrid search', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-hybrid-search-'));
    embedTextsMock.mockReset();
    vectorSearchMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to lexical mode in auto search when embeddings are incomplete', async () => {
    const catalog = openCatalog({ dataDir: root });
    catalog.upsertSource(buildSpec('auto-fallback'));
    catalog.linkProject('/workspace/trader', ['auto-fallback']);
    catalog.recordSuccessfulSnapshot({
      sourceId: 'auto-fallback',
      pages: [
        {
          url: 'https://example.com/docs/orders',
          title: 'Orders',
          markdown: '# Orders\n\nMaker flow overview.',
        },
      ],
    });

    const result = await searchHybridCatalog({
      catalog,
      config: baseConfig,
      query: 'maker flow',
      mode: 'auto',
      searchInput: {
        cwd: '/workspace/trader',
      },
    });

    expect(result.modeUsed).toBe('lexical');
    expect(result.total).toBe(1);
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(vectorSearchMock).not.toHaveBeenCalled();
  });

  it('fuses lexical and vector candidates in hybrid mode', async () => {
    const catalog = openCatalog({ dataDir: root });
    catalog.upsertSource(buildSpec('hybrid-docs'));
    catalog.linkProject('/workspace/trader', ['hybrid-docs']);
    catalog.recordSuccessfulSnapshot({
      sourceId: 'hybrid-docs',
      pages: [
        {
          url: 'https://example.com/docs/orders',
          title: 'Orders',
          markdown: '# Orders\n\nMaker flow overview with maker rebates.',
        },
        {
          url: 'https://example.com/docs/risk',
          title: 'Risk',
          markdown: '# Risk\n\nLiquidation mechanics for makers and takers.',
        },
      ],
    });

    const chunks = catalog.search({
      query: 'maker',
      cwd: '/workspace/trader',
      all: false,
    }).results;
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    embedTextsMock.mockResolvedValue([[0.1, 0.2, 0.3]]);
    vectorSearchMock.mockResolvedValue([
      { chunkId: chunks[1]!.chunkId, score: 0.98 },
      { chunkId: chunks[0]!.chunkId, score: 0.91 },
    ]);

    const result = await searchHybridCatalog({
      catalog,
      config: baseConfig,
      query: 'maker flow',
      mode: 'hybrid',
      searchInput: {
        cwd: '/workspace/trader',
      },
    });

    expect(result.modeUsed).toBe('hybrid');
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.results[0]?.signals).toContain('vector');
    expect(result.results[0]?.signals).toContain('lexical');
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(vectorSearchMock).toHaveBeenCalledTimes(1);
  });
});
