import { QdrantClient } from '@qdrant/js-client-rest';

import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { HybridRuntimeConfig } from '../runtime/hybrid-config.js';

type ChunkPayload = {
  chunkId: number;
  sourceId: string;
  snapshotId: string;
  pageUrl: string;
  pageTitle: string;
  sectionTitle: string;
  modelKey: string;
};

export type VectorSearchResult = {
  chunkId: number;
  score: number;
};

export class AiocsVectorStore {
  private readonly client: QdrantClient;
  private readonly collectionName: string;

  constructor(config: HybridRuntimeConfig) {
    this.client = new QdrantClient({
      url: config.qdrantUrl,
      timeout: config.qdrantTimeoutMs,
      checkCompatibility: false,
    });
    this.collectionName = config.qdrantCollection;
  }

  private pointIdForChunk(chunkId: number): string {
    return String(chunkId);
  }

  async ensureCollection(dimension: number): Promise<void> {
    const existsResponse = await this.client.collectionExists(this.collectionName).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to reach Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const exists = typeof existsResponse === 'boolean'
      ? existsResponse
      : Boolean((existsResponse as { exists?: boolean }).exists);

    if (!exists) {
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: dimension,
          distance: 'Cosine',
        },
      }).catch((error: unknown) => {
        throw new AiocsError(
          AIOCS_ERROR_CODES.vectorStoreUnavailable,
          `Unable to create Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }

    const collection = await this.client.getCollection(this.collectionName).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to inspect Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const params = collection.config?.params?.vectors;
    const currentSize = typeof params === 'object' && params && 'size' in params ? Number(params.size) : null;
    if (!currentSize || currentSize !== dimension) {
      await this.client.recreateCollection(this.collectionName, {
        vectors: {
          size: dimension,
          distance: 'Cosine',
        },
      }).catch((error: unknown) => {
        throw new AiocsError(
          AIOCS_ERROR_CODES.vectorStoreUnavailable,
          `Unable to recreate Qdrant collection '${this.collectionName}' for dimension ${dimension}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  async upsertChunks(input: {
    modelKey: string;
    points: Array<{
      chunkId: number;
      vector: number[];
      sourceId: string;
      snapshotId: string;
      pageUrl: string;
      pageTitle: string;
      sectionTitle: string;
    }>;
  }): Promise<void> {
    if (input.points.length === 0) {
      return;
    }

    const points = input.points.map((point) => ({
      id: this.pointIdForChunk(point.chunkId),
      vector: point.vector,
      payload: {
        chunkId: point.chunkId,
        sourceId: point.sourceId,
        snapshotId: point.snapshotId,
        pageUrl: point.pageUrl,
        pageTitle: point.pageTitle,
        sectionTitle: point.sectionTitle,
        modelKey: input.modelKey,
      } satisfies ChunkPayload,
    }));

    await this.client.upsert(this.collectionName, {
      wait: true,
      points,
    }).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to upsert vectors into Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async deleteChunkIds(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) {
      return;
    }

    await this.client.delete(this.collectionName, {
      wait: true,
      points: chunkIds.map((chunkId) => this.pointIdForChunk(chunkId)),
    }).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to delete vectors from Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async clearCollection(): Promise<void> {
    const existsResponse = await this.client.collectionExists(this.collectionName).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to reach Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const exists = typeof existsResponse === 'boolean'
      ? existsResponse
      : Boolean((existsResponse as { exists?: boolean }).exists);

    if (!exists) {
      return;
    }

    await this.client.deleteCollection(this.collectionName).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to delete Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async search(input: {
    vector: number[];
    snapshotIds: string[];
    sourceIds?: string[] | null;
    modelKey: string;
    limit: number;
    offset?: number;
  }): Promise<VectorSearchResult[]> {
    if (input.snapshotIds.length === 0) {
      return [];
    }

    const results = await this.client.search(this.collectionName, {
      vector: input.vector,
      limit: input.limit,
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
      with_payload: ['chunkId', 'snapshotId', 'sourceId', 'modelKey'],
      filter: {
        must: [
          {
            key: 'snapshotId',
            match: {
              any: input.snapshotIds,
            },
          },
          {
            key: 'modelKey',
            match: {
              value: input.modelKey,
            },
          },
          ...(input.sourceIds && input.sourceIds.length > 0
            ? [{
                key: 'sourceId',
                match: {
                  any: input.sourceIds,
                },
              } as const]
            : []),
        ],
      },
    }).catch((error: unknown) => {
      throw new AiocsError(
        AIOCS_ERROR_CODES.vectorStoreUnavailable,
        `Unable to search Qdrant collection '${this.collectionName}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return results
      .map((result) => {
        const payload = (result.payload ?? {}) as Partial<ChunkPayload>;
        const chunkId = typeof payload.chunkId === 'number'
          ? payload.chunkId
          : typeof result.id === 'number'
            ? result.id
            : Number(result.id);
        if (!Number.isInteger(chunkId)) {
          return null;
        }

        return {
          chunkId,
          score: result.score,
        };
      })
      .filter((result): result is VectorSearchResult => result !== null);
  }

  async getHealth(): Promise<{ ok: boolean; collections?: string[]; errorMessage?: string }> {
    try {
      const response = await this.client.getCollections();
      return {
        ok: true,
        collections: response.collections?.map((entry) => entry.name) ?? [],
      };
    } catch (error) {
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
