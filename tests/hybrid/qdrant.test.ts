import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  upsertMock,
  deleteMock,
  collectionExistsMock,
  getCollectionMock,
  createCollectionMock,
  recreateCollectionMock,
  getCollectionsMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  deleteMock: vi.fn(),
  collectionExistsMock: vi.fn(),
  getCollectionMock: vi.fn(),
  createCollectionMock: vi.fn(),
  recreateCollectionMock: vi.fn(),
  getCollectionsMock: vi.fn(),
}));

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: class {
    collectionExists = collectionExistsMock;
    getCollection = getCollectionMock;
    createCollection = createCollectionMock;
    recreateCollection = recreateCollectionMock;
    upsert = upsertMock;
    delete = deleteMock;
    getCollections = getCollectionsMock;
  },
}));

import { AiocsVectorStore } from '../../src/hybrid/qdrant.js';
import type { HybridRuntimeConfig } from '../../src/runtime/hybrid-config.js';

const config: HybridRuntimeConfig = {
  defaultSearchMode: 'auto',
  qdrantUrl: 'http://127.0.0.1:6333',
  qdrantCollection: 'aiocs_docs_chunks',
  qdrantTimeoutMs: 1_000,
  embeddingProvider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaTimeoutMs: 1_000,
  embeddingBatchSize: 16,
  embeddingJobsPerCycle: 1,
  lexicalCandidateWindow: 20,
  vectorCandidateWindow: 20,
  rrfK: 60,
};

describe('AiocsVectorStore', () => {
  beforeEach(() => {
    upsertMock.mockReset();
    deleteMock.mockReset();
    collectionExistsMock.mockReset();
    getCollectionMock.mockReset();
    createCollectionMock.mockReset();
    recreateCollectionMock.mockReset();
    getCollectionsMock.mockReset();
    upsertMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue(undefined);
    collectionExistsMock.mockResolvedValue(false);
    getCollectionMock.mockResolvedValue(undefined);
    createCollectionMock.mockResolvedValue(undefined);
    recreateCollectionMock.mockResolvedValue(undefined);
    getCollectionsMock.mockResolvedValue({ collections: [] });
  });

  it('uses numeric point ids when upserting chunk vectors', async () => {
    const store = new AiocsVectorStore(config);

    await store.upsertChunks({
      modelKey: 'ollama:nomic-embed-text',
      points: [
        {
          chunkId: 42,
          vector: [0.1, 0.2, 0.3],
          sourceId: 'selector-e2e',
          snapshotId: 'snp_1',
          pageUrl: 'http://127.0.0.1/docs/page',
          pageTitle: 'Page',
          sectionTitle: 'Section',
        },
      ],
    });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith('aiocs_docs_chunks', {
      wait: true,
      points: [
        expect.objectContaining({
          id: 42,
          vector: [0.1, 0.2, 0.3],
        }),
      ],
    });
  });
});
