import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { processEmbeddingJobs } from '../../src/hybrid/worker.js';
import type { HybridRuntimeConfig } from '../../src/runtime/hybrid-config.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

const {
  embedTextsMock,
  ensureCollectionMock,
  upsertChunksMock,
  deleteChunkIdsMock,
} = vi.hoisted(() => ({
  embedTextsMock: vi.fn(),
  ensureCollectionMock: vi.fn(),
  upsertChunksMock: vi.fn(),
  deleteChunkIdsMock: vi.fn(),
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
      async ensureCollection(...args: unknown[]) {
        return ensureCollectionMock(...args);
      }

      async upsertChunks(...args: unknown[]) {
        return upsertChunksMock(...args);
      }

      async deleteChunkIds(...args: unknown[]) {
        return deleteChunkIdsMock(...args);
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
  embeddingJobsPerCycle: 2,
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

describe('embedding worker', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-hybrid-worker-'));
    embedTextsMock.mockReset();
    ensureCollectionMock.mockReset();
    upsertChunksMock.mockReset();
    deleteChunkIdsMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes queued latest-snapshot chunks and updates coverage', async () => {
    const catalog = openCatalog({ dataDir: root });
    catalog.upsertSource(buildSpec('worker-docs'));
    catalog.recordSuccessfulSnapshot({
      sourceId: 'worker-docs',
      pages: [
        {
          url: 'https://example.com/docs/orders',
          title: 'Orders',
          markdown: '# Orders\n\nMaker flow overview.',
        },
      ],
    });

    embedTextsMock.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await processEmbeddingJobs({
      catalog,
      config: baseConfig,
    });

    const overview = catalog.getEmbeddingOverview();
    expect(result.processedJobs).toBe(1);
    expect(result.succeededJobs).toEqual([
      expect.objectContaining({
        sourceId: 'worker-docs',
        chunkCount: 1,
      }),
    ]);
    expect(ensureCollectionMock).toHaveBeenCalledWith(3);
    expect(upsertChunksMock).toHaveBeenCalledTimes(1);
    expect(deleteChunkIdsMock).not.toHaveBeenCalled();
    expect(overview.queue.pendingJobs).toBe(0);
    expect(overview.sources[0]).toMatchObject({
      sourceId: 'worker-docs',
      totalChunks: 1,
      indexedChunks: 1,
      pendingChunks: 0,
      failedChunks: 0,
    });
  });
});
