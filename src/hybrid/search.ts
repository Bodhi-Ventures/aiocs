import type { Catalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { HybridRuntimeConfig, SearchMode } from '../runtime/hybrid-config.js';
import { embedTexts, getEmbeddingModelKey } from './ollama.js';
import { AiocsVectorStore } from './qdrant.js';
import { reciprocalRankFusion } from './rank.js';

export type HybridSearchResult = {
  query: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  modeRequested: SearchMode;
  modeUsed: Exclude<SearchMode, 'auto'>;
  results: Array<{
    chunkId: number;
    sourceId: string;
    snapshotId: string;
    pageUrl: string;
    pageTitle: string;
    sectionTitle: string;
    markdown: string;
    score: number;
    signals: Array<'lexical' | 'vector'>;
  }>;
};

type HybridSearchInput = {
  catalog: Catalog;
  config: HybridRuntimeConfig;
  query: string;
  searchInput: {
    cwd?: string;
    sourceIds?: string[];
    snapshotId?: string;
    all?: boolean;
    limit?: number;
    offset?: number;
  };
  mode: SearchMode;
};

function windowSize(limit: number, offset: number, minimum: number): number {
  return Math.max(limit + offset, minimum);
}

function withScores<T extends { chunkId: number; sourceId: string; snapshotId: string; pageUrl: string; pageTitle: string; sectionTitle: string; markdown: string }>(
  rows: T[],
  scoreLookup: Map<number, { score: number; signals: Array<'lexical' | 'vector'> }>,
): HybridSearchResult['results'] {
  return rows.map((row) => {
    const score = scoreLookup.get(row.chunkId) ?? {
      score: 0,
      signals: ['lexical'],
    };
    return {
      ...row,
      score: score.score,
      signals: score.signals,
    };
  });
}

export async function searchHybridCatalog(input: HybridSearchInput): Promise<HybridSearchResult> {
  const scope = input.catalog.resolveSearchScope({
    query: input.query,
    ...(input.searchInput.cwd ? { cwd: input.searchInput.cwd } : {}),
    ...(input.searchInput.sourceIds ? { sourceIds: input.searchInput.sourceIds } : {}),
    ...(input.searchInput.snapshotId ? { snapshotId: input.searchInput.snapshotId } : {}),
    ...(input.searchInput.all ? { all: true } : {}),
    ...(typeof input.searchInput.limit === 'number' ? { limit: input.searchInput.limit } : {}),
    ...(typeof input.searchInput.offset === 'number' ? { offset: input.searchInput.offset } : {}),
  });

  const lexicalOnly = (): HybridSearchResult => {
    const lexical = input.catalog.searchLexical({
      query: input.query,
      scope,
    });
    return {
      query: input.query,
      total: lexical.total,
      limit: lexical.limit,
      offset: lexical.offset,
      hasMore: lexical.hasMore,
      modeRequested: input.mode,
      modeUsed: 'lexical',
      results: lexical.results.map((result, index) => ({
        ...result,
        score: 1 / (index + 1),
        signals: ['lexical'],
      })),
    };
  };

  if (scope.snapshotIds.length === 0) {
    return {
      query: input.query,
      total: 0,
      limit: scope.limit,
      offset: scope.offset,
      hasMore: false,
      modeRequested: input.mode,
      modeUsed: input.mode === 'semantic' ? 'semantic' : 'lexical',
      results: [],
    };
  }

  if (input.mode === 'lexical') {
    return lexicalOnly();
  }

  const overview = input.catalog.getEmbeddingOverview();
  const snapshotIdSet = new Set(scope.snapshotIds);
  const scopedSources = overview.sources.filter((source) =>
    source.snapshotId ? snapshotIdSet.has(source.snapshotId) : false,
  );
  const allSnapshotsIndexed = scopedSources.every((source) =>
    !source.snapshotId || (source.totalChunks > 0 && source.indexedChunks === source.totalChunks),
  );

  if (input.mode === 'auto' && !allSnapshotsIndexed) {
    return lexicalOnly();
  }

  let queryVector: number[] | undefined;
  let vectorCandidates: Array<{ chunkId: number; score: number }> = [];
  const modelKey = getEmbeddingModelKey(input.config);

  try {
    const embedding = await embedTexts(input.config, [input.query]);
    queryVector = embedding[0];
    if (!queryVector) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.embeddingProviderUnavailable,
        'Embedding provider returned no vector for the search query',
      );
    }

    const vectorStore = new AiocsVectorStore(input.config);
    vectorCandidates = await vectorStore.search({
      vector: queryVector,
      snapshotIds: scope.snapshotIds,
      sourceIds: scope.sourceIds,
      modelKey,
      limit: windowSize(scope.limit, scope.offset, input.config.vectorCandidateWindow),
    });
  } catch (error) {
    if (input.mode === 'auto') {
      return lexicalOnly();
    }
    throw error;
  }

  if (input.mode === 'auto' && vectorCandidates.length === 0) {
    return lexicalOnly();
  }

  if (input.mode === 'semantic') {
    const orderedChunkIds = vectorCandidates.map((candidate) => candidate.chunkId);
    const chunkRows = input.catalog.getChunksByIds(orderedChunkIds);
    const chunkMap = new Map(chunkRows.map((row) => [row.chunkId, row]));
    const orderedRows = orderedChunkIds
      .map((chunkId) => chunkMap.get(chunkId))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const pagedRows = orderedRows.slice(scope.offset, scope.offset + scope.limit);
    const scoreLookup = new Map(vectorCandidates.map((candidate) => [
      candidate.chunkId,
      { score: candidate.score, signals: ['vector'] as Array<'vector'> },
    ]));

    return {
      query: input.query,
      total: orderedRows.length,
      limit: scope.limit,
      offset: scope.offset,
      hasMore: scope.offset + pagedRows.length < orderedRows.length,
      modeRequested: input.mode,
      modeUsed: 'semantic',
      results: withScores(pagedRows, scoreLookup),
    };
  }

  const lexicalCandidates = input.catalog.searchLexical({
    query: input.query,
    scope,
    limit: windowSize(scope.limit, scope.offset, input.config.lexicalCandidateWindow),
    offset: 0,
  });

  const fused = reciprocalRankFusion([
    lexicalCandidates.results.map((result, index) => ({
      chunkId: result.chunkId,
      rank: index + 1,
      signal: 'lexical' as const,
    })),
    vectorCandidates.map((result, index) => ({
      chunkId: result.chunkId,
      rank: index + 1,
      signal: 'vector' as const,
      score: result.score,
    })),
  ], input.config.rrfK);

  const orderedChunkIds = fused.map((result) => result.chunkId);
  const chunkRows = input.catalog.getChunksByIds(orderedChunkIds);
  const chunkMap = new Map(chunkRows.map((row) => [row.chunkId, row]));
  const orderedRows = orderedChunkIds
    .map((chunkId) => chunkMap.get(chunkId))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const pagedRows = orderedRows.slice(scope.offset, scope.offset + scope.limit);
  const scoreLookup = new Map(fused.map((candidate) => [
    candidate.chunkId,
    {
      score: candidate.fusedScore,
      signals: candidate.signals,
    },
  ]));

  return {
    query: input.query,
    total: orderedRows.length,
    limit: scope.limit,
    offset: scope.offset,
    hasMore: scope.offset + pagedRows.length < orderedRows.length,
    modeRequested: input.mode,
    modeUsed: 'hybrid',
    results: withScores(pagedRows, scoreLookup),
  };
}
