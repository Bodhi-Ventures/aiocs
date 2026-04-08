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
import { getAiocsConfigDir, getAiocsDataDir, getAiocsSourcesDir } from './runtime/paths.js';
import { getBundledSourcesDir } from './runtime/bundled-sources.js';
import { getHybridRuntimeConfig, type SearchMode } from './runtime/hybrid-config.js';
import { scoreLearning, scoreSourceContext, type RetrievalLearning } from './retrieval.js';
import { uniqueResolvedPaths } from './spec/source-spec-files.js';
import { loadSourceSpec } from './spec/source-spec.js';
import { loadSourceContextFile, type CommonLocation, type SourceContext } from './source-context.js';

export type SearchOptions = {
  source: string[];
  snapshot?: string;
  all?: boolean;
  project?: string;
  path?: string[];
  language?: string[];
  limit?: number;
  offset?: number;
  mode?: SearchMode;
};

export type PageListOptions = {
  snapshot?: string;
  query?: string;
  path?: string[];
  limit?: number;
  offset?: number;
};

function dedupePagesByIdentity<T extends { sourceId: string; snapshotId: string; pageUrl: string; filePath?: string | null }>(
  rows: T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = `${row.sourceId}::${row.snapshotId}::${row.filePath ?? row.pageUrl}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

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
    kind: 'web' | 'git';
    label: string;
    specPath: string | null;
    nextDueAt: string;
    isDue: boolean;
    nextCanaryDueAt: string | null;
    isCanaryDue: boolean;
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

export async function describeSource(sourceId: string): Promise<{
  source: NonNullable<Awaited<ReturnType<typeof listSources>>['sources'][number]>;
  context: {
    sourceId: string;
    context: SourceContext | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  latestSnapshot: {
    snapshotId: string;
    detectedVersion: string | null;
    createdAt: string;
    pageCount: number;
  } | null;
  recentLearnings: RetrievalLearning[];
}> {
  return withCatalog(({ catalog }) => {
    const source = catalog.getSourceById(sourceId);
    if (!source) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.sourceNotFound,
        `Unknown source '${sourceId}'`,
      );
    }

    const latestSnapshot = catalog.listSnapshots(sourceId)[0] ?? null;

    return {
      source,
      context: catalog.getSourceContext(sourceId),
      latestSnapshot,
      recentLearnings: catalog.listRoutingLearnings({
        sourceId,
        limit: 10,
      }),
    };
  });
}

export async function upsertSourceContextFromFile(sourceId: string, contextFile: string): Promise<{
  sourceId: string;
  context: SourceContext;
  contextFile: string;
  createdAt: string;
  updatedAt: string;
}> {
  const resolvedContextFile = resolve(contextFile);
  const context = await loadSourceContextFile(resolvedContextFile);
  const result = await withCatalog(({ catalog }) => catalog.upsertSourceContext(sourceId, context));
  return {
    ...result,
    contextFile: resolvedContextFile,
  };
}

export async function getSourceContextForSource(sourceId: string): Promise<{
  sourceId: string;
  context: SourceContext | null;
  createdAt: string | null;
  updatedAt: string | null;
}> {
  return withCatalog(({ catalog }) => catalog.getSourceContext(sourceId));
}

export async function listSourcePages(sourceId: string, options: PageListOptions): Promise<{
  sourceId: string;
  snapshotId: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  pages: Array<{
    url: string;
    title: string;
    pageKind: 'document' | 'file';
    filePath: string | null;
    language: string | null;
    markdownLength: number;
  }>;
}> {
  return withCatalog(({ catalog }) => catalog.listPages({
    sourceId,
    ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
    ...(options.query ? { query: options.query } : {}),
    ...(options.path && options.path.length > 0 ? { pathPatterns: options.path } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    ...(typeof options.offset === 'number' ? { offset: options.offset } : {}),
  }));
}

export async function showPage(input: {
  sourceId: string;
  snapshotId?: string;
  url?: string;
  filePath?: string;
}): Promise<{
  sourceId: string;
  snapshotId: string;
  page: {
    url: string;
    title: string;
    markdown: string;
    pageKind: 'document' | 'file';
    filePath: string | null;
    language: string | null;
  };
}> {
  return withCatalog(({ catalog }) => catalog.getPage(input));
}

export async function saveRoutingLearning(input: {
  sourceId: string;
  snapshotId?: string;
  learningType: 'discovery' | 'negative';
  intent: string;
  pageUrl?: string;
  filePath?: string;
  title?: string;
  note?: string;
  searchTerms?: string[];
}): Promise<{ learning: RetrievalLearning }> {
  const learning = await withCatalog(({ catalog }) => catalog.upsertRoutingLearning({
    sourceId: input.sourceId,
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    learningType: input.learningType,
    intent: input.intent,
    ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.searchTerms ? { searchTerms: input.searchTerms } : {}),
  }));

  return { learning };
}

export async function listRoutingLearningsForQuery(input?: {
  sourceId?: string;
  learningType?: 'discovery' | 'negative';
  intentQuery?: string;
  limit?: number;
}): Promise<{ learnings: RetrievalLearning[] }> {
  const learnings = await withCatalog(({ catalog }) => catalog.listRoutingLearnings(input));
  return { learnings };
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

export async function refreshDueSources(sourceIdOrAll = 'all'): Promise<{
  results: Array<{
    sourceId: string;
    snapshotId: string;
    pageCount: number;
    reused: boolean;
  }>;
}> {
  const results = await withCatalog(async ({ catalog, dataDir }) => {
    const dueIds = sourceIdOrAll === 'all'
      ? catalog.listDueSourceIds()
      : (() => {
          const spec = catalog.getSourceSpec(sourceIdOrAll);
          if (!spec) {
            throw new AiocsError(
              AIOCS_ERROR_CODES.sourceNotFound,
              `Unknown source '${sourceIdOrAll}'`,
            );
          }

          return catalog.listDueSourceIds().includes(sourceIdOrAll) ? [sourceIdOrAll] : [];
        })();
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
      url?: string;
      path?: string;
      status: 'pass' | 'fail';
      title?: string;
      markdownLength?: number;
      errorMessage?: string;
    }>;
  }>;
}> {
  const results = await withCatalog(async ({ catalog, dataDir }) => {
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
        dataDir,
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
    pageKind: 'document' | 'file';
    filePath: string | null;
    language: string | null;
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
        ...(options.path && options.path.length > 0 ? { pathPatterns: options.path } : {}),
        ...(options.language && options.language.length > 0 ? { languages: options.language } : {}),
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

export async function retrieveContext(query: string, options: SearchOptions & { pageLimit?: number }): Promise<{
  query: string;
  modeRequested: SearchMode;
  modeUsed: 'lexical' | 'hybrid' | 'semantic';
  sourceScope: string[];
  sourceHints: Array<{
    sourceId: string;
    score: number;
    context: SourceContext;
    matchedCommonLocations: CommonLocation[];
  }>;
  matchedLearnings: Array<RetrievalLearning & { score: number }>;
  avoidedLearnings: Array<RetrievalLearning & { score: number }>;
  search: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    results: Array<{
      chunkId: number;
      sourceId: string;
      snapshotId: string;
      pageUrl: string;
      pageTitle: string;
      sectionTitle: string;
      markdown: string;
      pageKind: 'document' | 'file';
      filePath: string | null;
      language: string | null;
      score: number;
      signals: Array<'lexical' | 'vector'>;
    }>;
  };
  pages: Array<{
    sourceId: string;
    snapshotId: string;
    url: string;
    title: string;
    markdown: string;
    pageKind: 'document' | 'file';
    filePath: string | null;
    language: string | null;
  }>;
}> {
  const cwd = options.project ? resolve(options.project) : process.cwd();
  const explicitSources = options.source.length > 0;
  const pageLimit = typeof options.pageLimit === 'number' ? options.pageLimit : 3;

  return withCatalog(async ({ catalog }) => {
    const hybridConfig = getHybridRuntimeConfig();
    const scope = resolveProjectScope(cwd, catalog.listProjectLinks());

    if (!explicitSources && !options.all && !scope) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.noProjectScope,
        'No linked project scope found. Use --source or --all.',
      );
    }

    const sourceScope = explicitSources
      ? options.source
      : options.all
        ? catalog.listSources().map((source) => source.id)
        : (scope?.sourceIds ?? []);

    const learnings = catalog.listRoutingLearnings({
      limit: 100,
    }).filter((learning) => sourceScope.length === 0 || sourceScope.includes(learning.sourceId));

    const scoredLearnings = learnings
      .map((learning) => ({
        ...learning,
        score: scoreLearning(query, learning),
      }))
      .filter((learning) => learning.score > 0)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));

    const matchedLearnings = scoredLearnings.filter((learning) => learning.learningType === 'discovery');
    const avoidedLearnings = scoredLearnings.filter((learning) => learning.learningType === 'negative');
    const avoidedPageKeys = new Set(
      avoidedLearnings.map((learning) => `${learning.sourceId}::${learning.filePath ?? learning.pageUrl ?? ''}`),
    );

    const sourceHints = sourceScope
      .map((sourceId) => {
        const contextRecord = catalog.getSourceContext(sourceId);
        const score = scoreSourceContext(query, contextRecord.context);
        if (!contextRecord.context || score <= 0) {
          return null;
        }

        const matchedCommonLocations = contextRecord.context.commonLocations.filter((location) =>
          scoreSourceContext(query, {
            purpose: '',
            summary: '',
            topicHints: [],
            commonLocations: [location],
            gotchas: [],
            authNotes: [],
          }) > 0,
        );

        return {
          sourceId,
          score,
          context: contextRecord.context,
          matchedCommonLocations,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId));

    const search = await searchHybridCatalog({
      catalog,
      config: hybridConfig,
      query,
      mode: options.mode ?? hybridConfig.defaultSearchMode,
      searchInput: {
        cwd,
        ...(explicitSources ? { sourceIds: options.source } : {}),
        ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
        ...(options.all ? { all: true } : {}),
        ...(options.path && options.path.length > 0 ? { pathPatterns: options.path } : {}),
        ...(options.language && options.language.length > 0 ? { languages: options.language } : {}),
        ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
        ...(typeof options.offset === 'number' ? { offset: options.offset } : {}),
      },
    });

    const learnedPages = matchedLearnings
      .filter((learning) => learning.pageUrl || learning.filePath)
      .map((learning) => ({
        sourceId: learning.sourceId,
        snapshotId: learning.snapshotId ?? catalog.getSourceById(learning.sourceId)?.lastSuccessfulSnapshotId ?? '',
        pageUrl: learning.pageUrl ?? '',
        filePath: learning.filePath ?? null,
      }))
      .filter((entry) => entry.snapshotId);

    const searchedPages = search.results
      .filter((result) => !avoidedPageKeys.has(`${result.sourceId}::${result.filePath ?? result.pageUrl}`))
      .map((result) => ({
        sourceId: result.sourceId,
        snapshotId: result.snapshotId,
        pageUrl: result.pageUrl,
        filePath: result.filePath,
      }));

    const selectedPages = dedupePagesByIdentity([
      ...learnedPages,
      ...searchedPages,
    ]).slice(0, Math.max(1, pageLimit));

    const pages = selectedPages.flatMap((entry) => {
      try {
        const page = catalog.getPage({
          sourceId: entry.sourceId,
          snapshotId: entry.snapshotId,
          ...(entry.filePath ? { filePath: entry.filePath } : { url: entry.pageUrl }),
        });

        return [{
          sourceId: page.sourceId,
          snapshotId: page.snapshotId,
          ...page.page,
        }];
      } catch (error) {
        if (
          error instanceof AiocsError
          && (error.code === AIOCS_ERROR_CODES.pageNotFound || error.code === AIOCS_ERROR_CODES.snapshotNotFound)
        ) {
          return [];
        }
        throw error;
      }
    });

    return {
      query,
      modeRequested: search.modeRequested,
      modeUsed: search.modeUsed,
      sourceScope,
      sourceHints,
      matchedLearnings,
      avoidedLearnings,
      search: {
        total: search.total,
        limit: search.limit,
        offset: search.offset,
        hasMore: search.hasMore,
        results: search.results,
      },
      pages,
    };
  });
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

export async function initManagedSources(options?: {
  fetch?: boolean;
  sourceSpecDirs?: string[];
}): Promise<{
  sourceSpecDirs: string[];
  userSourceDir: string;
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
  const sourceSpecDirs = uniqueResolvedPaths(
    options?.sourceSpecDirs ?? [
      getBundledSourcesDir(),
      getAiocsSourcesDir(),
    ],
  );
  const fetched = options?.fetch ?? false;
  const userSourceDir = getAiocsSourcesDir();

  return withCatalog(async ({ catalog, dataDir }) => {
    const bootstrapped = await bootstrapSourceSpecs({
      catalog,
      sourceSpecDirs,
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
      sourceSpecDirs,
      userSourceDir,
      fetched,
      initializedSources: bootstrapped.sources,
      removedSourceIds: bootstrapped.removedSourceIds,
      fetchResults,
    };
  });
}

export function getManagedSourceSpecDirectories(): {
  bundledSourceDir: string;
  userSourceDir: string;
} {
  return {
    bundledSourceDir: getBundledSourcesDir(),
    userSourceDir: getAiocsSourcesDir(),
  };
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
