import { resolve } from 'node:path';

import { exportBackup, importBackup } from './backup.js';
import { openCatalog } from './catalog/catalog.js';
import { verifyCoverageAgainstReferences, type CoverageVerificationResult } from './coverage.js';
import { AiocsError, AIOCS_ERROR_CODES } from './errors.js';
import { resolveProjectScope } from './catalog/project-scope.js';
import { bootstrapSourceSpecs } from './daemon.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { fetchSource, runSourceCanary } from './fetch/fetch-source.js';
import { AiocsVectorStore } from './hybrid/qdrant.js';
import { searchHybridCatalog } from './hybrid/search.js';
import { processEmbeddingJobs } from './hybrid/worker.js';
import { getAiocsConfigDir, getAiocsDataDir } from './runtime/paths.js';
import { getBundledSourcesDir } from './runtime/bundled-sources.js';
import { getHybridRuntimeConfig, type SearchMode } from './runtime/hybrid-config.js';
import { loadSourceSpec } from './spec/source-spec.js';

export type SearchOptions = {
  source: string[];
  snapshot?: string;
  all?: boolean;
  project?: string;
  limit?: number;
  offset?: number;
  mode?: SearchMode;
};

type CatalogContext = {
  dataDir: string;
  catalog: ReturnType<typeof openCatalog>;
};

function createCatalog(): CatalogContext {
  const dataDir = getAiocsDataDir();
  getAiocsConfigDir();
  return {
    dataDir,
    catalog: openCatalog({ dataDir }),
  };
}

function withCatalog<T>(run: (ctx: CatalogContext) => Promise<T> | T): Promise<T> {
  const ctx = createCatalog();
  return Promise.resolve(run(ctx)).finally(() => ctx.catalog.close());
}

export async function upsertSourceFromSpecFile(specFile: string): Promise<{
  sourceId: string;
  configHash: string;
  specPath: string;
}> {
  const specPath = resolve(specFile);
  const spec = await loadSourceSpec(specPath);
  const result = await withCatalog(({ catalog }) => catalog.upsertSource(spec, { specPath }));

  return {
    sourceId: result.sourceId,
    configHash: result.configHash,
    specPath,
  };
}

export async function listSources(): Promise<{
  sources: Array<{
    id: string;
    label: string;
    nextDueAt: string;
    nextCanaryDueAt: string | null;
    lastCheckedAt: string | null;
    lastSuccessfulSnapshotAt: string | null;
    lastSuccessfulSnapshotId: string | null;
    lastCanaryCheckedAt: string | null;
    lastSuccessfulCanaryAt: string | null;
    lastCanaryStatus: 'pass' | 'fail' | null;
  }>;
}> {
  const sources = await withCatalog(({ catalog }) => catalog.listSources());
  return { sources };
}

export async function fetchSources(sourceIdOrAll: string): Promise<{
  results: Array<{
    sourceId: string;
    snapshotId: string;
    pageCount: number;
    reused: boolean;
  }>;
}> {
  const results = await withCatalog(async ({ catalog, dataDir }) => {
    const sourceIds = sourceIdOrAll === 'all'
      ? catalog.listSources().map((item) => item.id)
      : [sourceIdOrAll];

    if (sourceIds.length === 0) {
      return [];
    }

    const fetched = [];
    for (const sourceId of sourceIds) {
      const result = await fetchSource({ catalog, sourceId, dataDir });
      fetched.push({
        sourceId,
        snapshotId: result.snapshotId,
        pageCount: result.pageCount,
        reused: result.reused,
      });
    }

    await processEmbeddingJobs({
      catalog,
      config: getHybridRuntimeConfig(),
    });
    return fetched;
  });

  return { results };
}

export async function refreshDueSources(): Promise<{
  results: Array<{
    sourceId: string;
    snapshotId: string;
    pageCount: number;
    reused: boolean;
  }>;
}> {
  const results = await withCatalog(async ({ catalog, dataDir }) => {
    const dueIds = catalog.listDueSourceIds();
    const fetched = [];

    for (const sourceId of dueIds) {
      const result = await fetchSource({ catalog, sourceId, dataDir });
      fetched.push({
        sourceId,
        snapshotId: result.snapshotId,
        pageCount: result.pageCount,
        reused: result.reused,
      });
    }

    await processEmbeddingJobs({
      catalog,
      config: getHybridRuntimeConfig(),
    });

    return fetched;
  });

  return { results };
}

export async function runSourceCanaries(sourceIdOrAll: string): Promise<{
  results: Array<{
    sourceId: string;
    status: 'pass' | 'fail';
    checkedAt: string;
    summary: {
      checkCount: number;
      passCount: number;
      failCount: number;
    };
    checks: Array<{
      url: string;
      status: 'pass' | 'fail';
      title?: string;
      markdownLength?: number;
      errorMessage?: string;
    }>;
  }>;
}> {
  const results = await withCatalog(async ({ catalog }) => {
    const sourceIds = sourceIdOrAll === 'all'
      ? catalog.listSources().map((item) => item.id)
      : [sourceIdOrAll];

    if (sourceIds.length === 0) {
      return [];
    }

    const canaried = [];
    for (const sourceId of sourceIds) {
      canaried.push(await runSourceCanary({
        catalog,
        sourceId,
        env: process.env,
      }));
    }

    return canaried;
  });

  return { results };
}

export async function listSnapshotsForSource(sourceId: string): Promise<{
  sourceId: string;
  snapshots: Array<{
    snapshotId: string;
    sourceId: string;
    detectedVersion: string | null;
    createdAt: string;
    pageCount: number;
  }>;
}> {
  const snapshots = await withCatalog(({ catalog }) => catalog.listSnapshots(sourceId));
  return {
    sourceId,
    snapshots,
  };
}

export async function diffSnapshotsForSource(input: {
  sourceId: string;
  fromSnapshotId?: string;
  toSnapshotId?: string;
}): Promise<{
  sourceId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  summary: {
    addedPageCount: number;
    removedPageCount: number;
    changedPageCount: number;
    unchangedPageCount: number;
  };
  addedPages: Array<{ url: string; title: string }>;
  removedPages: Array<{ url: string; title: string }>;
  changedPages: Array<{
    url: string;
    beforeTitle: string;
    afterTitle: string;
    lineSummary: {
      addedLineCount: number;
      removedLineCount: number;
    };
  }>;
}> {
  return withCatalog(({ catalog }) => catalog.diffSnapshots(input));
}

export async function linkProjectSources(projectPath: string, sourceIds: string[]): Promise<{
  projectPath: string;
  sourceIds: string[];
}> {
  const resolvedProjectPath = resolve(projectPath);
  await withCatalog(({ catalog }) => {
    catalog.linkProject(resolvedProjectPath, sourceIds);
  });
  return {
    projectPath: resolvedProjectPath,
    sourceIds,
  };
}

export async function unlinkProjectSources(projectPath: string, sourceIds: string[]): Promise<{
  projectPath: string;
  sourceIds: string[];
}> {
  const resolvedProjectPath = resolve(projectPath);
  await withCatalog(({ catalog }) => {
    catalog.unlinkProject(resolvedProjectPath, sourceIds);
  });
  return {
    projectPath: resolvedProjectPath,
    sourceIds,
  };
}

export async function searchCatalog(query: string, options: SearchOptions): Promise<{
  query: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  modeRequested: SearchMode;
  modeUsed: 'lexical' | 'hybrid' | 'semantic';
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
}> {
  const cwd = options.project ? resolve(options.project) : process.cwd();
  const explicitSources = options.source.length > 0;
  const results = await withCatalog(({ catalog }) => {
    const hybridConfig = getHybridRuntimeConfig();
    const scope = resolveProjectScope(cwd, catalog.listProjectLinks());

    if (!explicitSources && !options.all && !scope) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.noProjectScope,
        'No linked project scope found. Use --source or --all.',
      );
    }

    return searchHybridCatalog({
      catalog,
      config: hybridConfig,
      query,
      mode: options.mode ?? hybridConfig.defaultSearchMode,
      searchInput: {
        cwd,
        ...(explicitSources ? { sourceIds: options.source } : {}),
        ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
        ...(options.all ? { all: true } : {}),
        ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
        ...(typeof options.offset === 'number' ? { offset: options.offset } : {}),
      },
    });
  });

  return {
    query,
    total: results.total,
    limit: results.limit,
    offset: results.offset,
    hasMore: results.hasMore,
    modeRequested: results.modeRequested,
    modeUsed: results.modeUsed,
    results: results.results,
  };
}

export async function showChunk(chunkId: number): Promise<{
  chunk: {
    chunkId: number;
    sourceId: string;
    snapshotId: string;
    pageUrl: string;
    pageTitle: string;
    sectionTitle: string;
    markdown: string;
  };
}> {
  const chunk = await withCatalog(({ catalog }) => catalog.getChunkById(chunkId));
  if (!chunk) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.chunkNotFound,
      `Chunk ${chunkId} not found`,
    );
  }

  return { chunk };
}

export async function verifyCoverage(input: {
  sourceId: string;
  referenceFiles: string[];
  snapshotId?: string;
}): Promise<CoverageVerificationResult> {
  return withCatalog(async ({ catalog }) => {
    const corpus = catalog.getCoverageCorpus({
      sourceId: input.sourceId,
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    });

    return verifyCoverageAgainstReferences(corpus, input.referenceFiles);
  });
}

export async function initBuiltInSources(options?: {
  fetch?: boolean;
  sourceSpecDir?: string;
}): Promise<{
  sourceSpecDir: string;
  fetched: boolean;
  initializedSources: Array<{
    sourceId: string;
    specPath: string;
    configHash: string;
    configChanged: boolean;
  }>;
  removedSourceIds: string[];
  fetchResults: Array<{
    sourceId: string;
    snapshotId: string;
    pageCount: number;
    reused: boolean;
  }>;
}> {
  const sourceSpecDir = options?.sourceSpecDir ?? getBundledSourcesDir();
  const fetched = options?.fetch ?? false;

  return withCatalog(async ({ catalog, dataDir }) => {
    const bootstrapped = await bootstrapSourceSpecs({
      catalog,
      sourceSpecDirs: [sourceSpecDir],
      strictSourceSpecDirs: true,
    });

    const fetchResults = [];
    if (fetched) {
      for (const source of bootstrapped.sources) {
        const result = await fetchSource({
          catalog,
          dataDir,
          sourceId: source.sourceId,
        });
        fetchResults.push({
          sourceId: source.sourceId,
          snapshotId: result.snapshotId,
          pageCount: result.pageCount,
          reused: result.reused,
        });
      }
      await processEmbeddingJobs({
        catalog,
        config: getHybridRuntimeConfig(),
      });
    }

    return {
      sourceSpecDir,
      fetched,
      initializedSources: bootstrapped.sources,
      removedSourceIds: bootstrapped.removedSourceIds,
      fetchResults,
    };
  });
}

export function getDoctorReport(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  return runDoctor(env);
}

export async function exportCatalogBackup(input: {
  outputDir: string;
  replaceExisting?: boolean;
}): Promise<{
  outputDir: string;
  manifestPath: string;
  manifest: {
    formatVersion: 1;
    createdAt: string;
    packageVersion: string;
    entries: Array<{
      relativePath: string;
      type: 'file' | 'directory';
      size: number;
    }>;
  };
}> {
  return exportBackup({
    dataDir: getAiocsDataDir(),
    configDir: getAiocsConfigDir(),
    outputDir: input.outputDir,
    ...(typeof input.replaceExisting === 'boolean' ? { replaceExisting: input.replaceExisting } : {}),
  });
}

export async function importCatalogBackup(input: {
  inputDir: string;
  replaceExisting?: boolean;
}): Promise<{
  inputDir: string;
  dataDir: string;
  configDir?: string;
  manifest: {
    formatVersion: 1;
    createdAt: string;
    packageVersion: string;
    entries: Array<{
      relativePath: string;
      type: 'file' | 'directory';
      size: number;
    }>;
  };
}> {
  const result = await importBackup({
    inputDir: input.inputDir,
    dataDir: getAiocsDataDir(),
    configDir: getAiocsConfigDir(),
    ...(typeof input.replaceExisting === 'boolean' ? { replaceExisting: input.replaceExisting } : {}),
  });

  try {
    await new AiocsVectorStore(getHybridRuntimeConfig()).clearCollection();
  } catch {
    // Vector state is derived and may be rebuilt after import even if the local Qdrant service is offline.
  }

  await withCatalog(({ catalog }) => {
    catalog.resetEmbeddingsAfterImport();
  });

  return result;
}

export async function getEmbeddingStatus(): Promise<{
  queue: {
    pendingJobs: number;
    runningJobs: number;
    failedJobs: number;
  };
  sources: Array<{
    sourceId: string;
    snapshotId: string | null;
    totalChunks: number;
    indexedChunks: number;
    pendingChunks: number;
    failedChunks: number;
    staleChunks: number;
    coverageRatio: number;
  }>;
}> {
  return withCatalog(({ catalog }) => catalog.getEmbeddingOverview());
}

export async function backfillEmbeddings(sourceIdOrAll: string): Promise<{
  queuedJobs: number;
}> {
  return withCatalog(({ catalog }) =>
    sourceIdOrAll === 'all'
      ? catalog.requeueLatestEmbeddingJobs()
      : catalog.requeueLatestEmbeddingJobs([sourceIdOrAll]));
}

export async function clearEmbeddings(sourceIdOrAll: string): Promise<{
  clearedSources: string[];
}> {
  return withCatalog(async ({ catalog }) => {
    const hybridConfig = getHybridRuntimeConfig();
    const vectorStore = new AiocsVectorStore(hybridConfig);
    if (sourceIdOrAll === 'all') {
      await vectorStore.clearCollection();
      return catalog.clearEmbeddings();
    }

    const chunkIds = catalog.listEmbeddingChunkIds([sourceIdOrAll]);
    if (chunkIds.length > 0) {
      await vectorStore.deleteChunkIds(chunkIds);
    }
    return catalog.clearEmbeddings([sourceIdOrAll]);
  });
}

export async function runEmbeddingWorker(): Promise<{
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
}> {
  return withCatalog(({ catalog }) =>
    processEmbeddingJobs({
      catalog,
      config: getHybridRuntimeConfig(),
    }));
}
