import { resolve } from 'node:path';

import { openCatalog } from './catalog/catalog.js';
import { resolveProjectScope } from './catalog/project-scope.js';
import { bootstrapSourceSpecs } from './daemon.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { fetchSource } from './fetch/fetch-source.js';
import { getAiocsConfigDir, getAiocsDataDir } from './runtime/paths.js';
import { getBundledSourcesDir } from './runtime/bundled-sources.js';
import { loadSourceSpec } from './spec/source-spec.js';

export type SearchOptions = {
  source: string[];
  snapshot?: string;
  all?: boolean;
  project?: string;
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
    lastCheckedAt: string | null;
    lastSuccessfulSnapshotId: string | null;
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

    return fetched;
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
  results: Array<{
    chunkId: number;
    sourceId: string;
    snapshotId: string;
    pageUrl: string;
    pageTitle: string;
    sectionTitle: string;
    markdown: string;
  }>;
}> {
  const cwd = options.project ? resolve(options.project) : process.cwd();
  const explicitSources = options.source.length > 0;
  const results = await withCatalog(({ catalog }) => {
    const scope = resolveProjectScope(cwd, catalog.listProjectLinks());

    if (!explicitSources && !options.all && !scope) {
      throw new Error('No linked project scope found. Use --source or --all.');
    }

    return catalog.search({
      query,
      cwd,
      ...(explicitSources ? { sourceIds: options.source } : {}),
      ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
      ...(options.all ? { all: true } : {}),
    });
  });

  return {
    query,
    results,
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
    throw new Error(`Chunk ${chunkId} not found`);
  }

  return { chunk };
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
