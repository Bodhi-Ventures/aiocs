import type { Catalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { HybridRuntimeConfig } from '../runtime/hybrid-config.js';
import { embedTexts, getEmbeddingModelKey } from './ollama.js';
import { AiocsVectorStore } from './qdrant.js';

export type EmbeddingWorkerResult = {
  processedJobs: number;
  succeededJobs: Array<{
    sourceId: string;
    snapshotId: string;
    chunkCount: number;
  }>;
  failedJobs: Array<{
    sourceId: string;
    snapshotId: string;
    errorMessage: string;
  }>;
};

type ProcessEmbeddingJobsInput = {
  catalog: Catalog;
  config: HybridRuntimeConfig;
};

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function processEmbeddingJobs(
  input: ProcessEmbeddingJobsInput,
): Promise<EmbeddingWorkerResult> {
  const claimedJobs = input.catalog.claimEmbeddingJobs(input.config.embeddingJobsPerCycle);
  if (claimedJobs.length === 0) {
    return {
      processedJobs: 0,
      succeededJobs: [],
      failedJobs: [],
    };
  }

  const vectorStore = new AiocsVectorStore(input.config);
  const modelKey = getEmbeddingModelKey(input.config);
  const succeededJobs: EmbeddingWorkerResult['succeededJobs'] = [];
  const failedJobs: EmbeddingWorkerResult['failedJobs'] = [];

  for (const job of claimedJobs) {
    try {
      const chunks = input.catalog.listSnapshotChunks({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
      });
      if (chunks.length === 0) {
        input.catalog.markEmbeddingJobFailed({
          sourceId: job.sourceId,
          snapshotId: job.snapshotId,
          errorMessage: 'No chunks found for embedding job snapshot',
        });
        failedJobs.push({
          sourceId: job.sourceId,
          snapshotId: job.snapshotId,
          errorMessage: 'No chunks found for embedding job snapshot',
        });
        continue;
      }

      const existingState = input.catalog.getSnapshotEmbeddingState({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
      });
      const staleChunkIds = [
        ...new Set([
          ...input.catalog.listStaleEmbeddingChunkIds(job.sourceId),
          ...existingState
            .filter((entry) => entry.modelKey && entry.modelKey !== modelKey)
            .map((entry) => entry.chunkId),
        ]),
      ];
      const needsReindex = existingState.some((entry) => entry.status !== 'indexed' || entry.modelKey !== modelKey);
      if (!needsReindex) {
        input.catalog.markEmbeddingJobSucceeded({
          sourceId: job.sourceId,
          snapshotId: job.snapshotId,
          modelKey,
          indexedChunkIds: chunks.map((chunk) => chunk.chunkId),
          staleChunkIds,
        });
        succeededJobs.push({
          sourceId: job.sourceId,
          snapshotId: job.snapshotId,
          chunkCount: chunks.length,
        });
        continue;
      }

      const dimensionProbe = await embedTexts(input.config, [chunks[0]!.markdown]);
      const vectorDimension = dimensionProbe[0]?.length;
      if (!vectorDimension) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.embeddingProviderUnavailable,
          'Embedding provider returned an empty vector for the first chunk',
        );
      }

      await vectorStore.ensureCollection(vectorDimension);

      if (staleChunkIds.length > 0) {
        await vectorStore.deleteChunkIds(staleChunkIds);
      }

      const indexedChunkIds: number[] = [];
      const batchedChunks = chunkArray(chunks, input.config.embeddingBatchSize);

      let dimensionProbeConsumed = false;
      for (const batch of batchedChunks) {
        const embeddings = dimensionProbeConsumed
          ? await embedTexts(input.config, batch.map((chunk) => chunk.markdown))
          : [
              dimensionProbe[0]!,
              ...(batch.length > 1 ? await embedTexts(input.config, batch.slice(1).map((chunk) => chunk.markdown)) : []),
            ];
        dimensionProbeConsumed = true;

        if (embeddings.length !== batch.length) {
          throw new AiocsError(
            AIOCS_ERROR_CODES.embeddingProviderUnavailable,
            `Embedding provider returned ${embeddings.length} embeddings for a batch of ${batch.length}`,
          );
        }

        await vectorStore.upsertChunks({
          modelKey,
          points: batch.map((chunk, index) => ({
            chunkId: chunk.chunkId,
            vector: embeddings[index]!,
            sourceId: chunk.sourceId,
            snapshotId: chunk.snapshotId,
            pageUrl: chunk.pageUrl,
            pageTitle: chunk.pageTitle,
            sectionTitle: chunk.sectionTitle,
          })),
        });

        indexedChunkIds.push(...batch.map((chunk) => chunk.chunkId));
      }

      input.catalog.markEmbeddingJobSucceeded({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
        modelKey,
        indexedChunkIds,
        staleChunkIds,
      });
      succeededJobs.push({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
        chunkCount: indexedChunkIds.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      input.catalog.markEmbeddingJobFailed({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
        errorMessage,
      });
      failedJobs.push({
        sourceId: job.sourceId,
        snapshotId: job.snapshotId,
        errorMessage,
      });
    }
  }

  return {
    processedJobs: claimedJobs.length,
    succeededJobs,
    failedJobs,
  };
}
