import { basename, extname, resolve } from 'node:path';

import { exportBackup, importBackup } from './backup.js';
import { openCatalog } from './catalog/catalog.js';
import { sha256 } from './catalog/fingerprint.js';
import { verifyCoverageAgainstReferences, type CoverageVerificationResult } from './coverage.js';
import { AiocsError, AIOCS_ERROR_CODES, toAiocsError } from './errors.js';
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
import { uniqueResolvedPaths } from './spec/source-spec-files.js';
import { loadSourceSpec } from './spec/source-spec.js';
import { compileWorkspace as compileWorkspaceRun } from './workspace/compile.js';
import { answerWorkspaceQuestion as answerWorkspaceQuestionRun, generateWorkspaceOutput as generateWorkspaceOutputRun } from './workspace/output.js';
import { lintWorkspace as lintWorkspaceRun } from './workspace/lint.js';
import { analyzeWorkspaceStatus } from './workspace/status.js';
import { enqueueWorkspaceCompileIfEligible, processQueuedWorkspaceCompileJobs } from './workspace/queue.js';
import { extractImageInput, extractMarkdownDirectoryInput, extractPdfInput } from './workspace/raw-inputs.js';
import { deleteWorkspaceArtifact, deleteWorkspaceManifest, deleteWorkspacePath, copyPathIntoWorkspace, readWorkspaceArtifact, writeWorkspaceArtifact } from './workspace/storage.js';
import { resolveWorkspaceCompilerProfile } from './workspace/compiler-profile.js';
import { getWorkspaceAnswerPath, getWorkspaceIndexPath } from './workspace/artifacts.js';
import { syncWorkspaceToObsidian as syncWorkspaceToObsidianRun } from './workspace/sync.js';
import type { WorkspaceAnswerFormat, WorkspaceOutputFormat, WorkspaceRawInputKind } from './workspace/types.js';

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

export type WorkspaceSearchScope = 'source' | 'derived' | 'mixed';

export type WorkspaceSearchOptions = {
  scope?: WorkspaceSearchScope;
  limit?: number;
  offset?: number;
  path?: string[];
  language?: string[];
  mode?: SearchMode;
};

type CatalogContext = {
  dataDir: string;
  catalog: ReturnType<typeof openCatalog>;
};

const workspaceSearchScopes = new Set<WorkspaceSearchScope>(['source', 'derived', 'mixed']);
const workspaceOutputFormats = new Set<WorkspaceOutputFormat>(['report', 'slides', 'summary']);
const workspaceAnswerFormats = new Set<WorkspaceAnswerFormat>(['report', 'slides', 'summary', 'note']);
const workspaceRawInputKinds = new Set<WorkspaceRawInputKind>(['markdown-dir', 'pdf', 'image']);

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

function assertWorkspaceSearchScope(value: string | undefined): WorkspaceSearchScope | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (workspaceSearchScopes.has(value as WorkspaceSearchScope)) {
    return value as WorkspaceSearchScope;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.invalidArgument,
    'workspace scope must be one of: source, derived, mixed',
  );
}

function assertWorkspaceOutputFormat(value: string): WorkspaceOutputFormat {
  if (workspaceOutputFormats.has(value as WorkspaceOutputFormat)) {
    return value as WorkspaceOutputFormat;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.invalidArgument,
    'workspace output format must be one of: report, slides, summary',
  );
}

function assertWorkspaceAnswerFormat(value: string): WorkspaceAnswerFormat {
  if (workspaceAnswerFormats.has(value as WorkspaceAnswerFormat)) {
    return value as WorkspaceAnswerFormat;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.invalidArgument,
    'workspace answer format must be one of: report, slides, summary, note',
  );
}

function assertWorkspaceRawInputKind(value: string): WorkspaceRawInputKind {
  if (workspaceRawInputKinds.has(value as WorkspaceRawInputKind)) {
    return value as WorkspaceRawInputKind;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.invalidArgument,
    'workspace raw input kind must be one of: markdown-dir, pdf, image',
  );
}

async function processPostRefreshWorkspaceCompiles(input: {
  catalog: ReturnType<typeof openCatalog>;
  dataDir: string;
  refreshedSourceIds: string[];
}): Promise<void> {
  const changedSourceIds = [...new Set(input.refreshedSourceIds.filter(Boolean))];
  if (changedSourceIds.length > 0) {
    const workspaceIds = input.catalog.listAutoCompileWorkspaceIdsForSources(changedSourceIds);
    for (const workspaceId of workspaceIds) {
      enqueueWorkspaceCompileIfEligible({
        catalog: input.catalog,
        workspaceId,
        sourceIds: changedSourceIds,
      });
    }
  }

  await processQueuedWorkspaceCompileJobs({
    catalog: input.catalog,
    dataDir: input.dataDir,
  });
}

function slugifySegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'input';
}

function buildWorkspaceRawInputId(input: {
  kind: WorkspaceRawInputKind;
  sourcePath: string;
}): string {
  const fingerprint = sha256(resolve(input.sourcePath)).slice(0, 10);
  const stem = basename(input.sourcePath, extname(input.sourcePath));
  return `${input.kind}-${slugifySegment(stem)}-${fingerprint}`;
}

function buildWorkspaceRawStoragePath(input: {
  kind: WorkspaceRawInputKind;
  rawInputId: string;
  sourcePath: string;
}): string {
  if (input.kind === 'markdown-dir') {
    return `raw/${input.rawInputId}`;
  }

  const fileName = basename(resolve(input.sourcePath));
  return `raw/${input.rawInputId}/${fileName}`;
}

function renderRawInputExtractedText(chunks: Array<{ markdown: string }>): string {
  return chunks.map((chunk) => chunk.markdown.trim()).filter(Boolean).join('\n\n').trim();
}

function assertWorkspaceOutputFormats(values: string[] | undefined): WorkspaceOutputFormat[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  return values.map((value) => assertWorkspaceOutputFormat(value));
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
    await processPostRefreshWorkspaceCompiles({
      catalog,
      dataDir,
      refreshedSourceIds: fetched
        .filter((entry) => entry.reused === false)
        .map((entry) => entry.sourceId),
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
    await processPostRefreshWorkspaceCompiles({
      catalog,
      dataDir,
      refreshedSourceIds: fetched
        .filter((entry) => entry.reused === false)
        .map((entry) => entry.sourceId),
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

export async function createWorkspace(input: {
  workspaceId: string;
  label: string;
  purpose?: string;
  defaultOutputFormats?: string[];
  autoCompileEnabled?: boolean;
}): Promise<{
  workspace: ReturnType<ReturnType<typeof openCatalog>['createWorkspace']>;
}> {
  const defaultOutputFormats = assertWorkspaceOutputFormats(input.defaultOutputFormats);
  const workspace = await withCatalog(({ catalog }) => catalog.createWorkspace({
    id: input.workspaceId,
    label: input.label,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    compilerProfile: resolveWorkspaceCompilerProfile(),
    defaultOutputFormats: defaultOutputFormats ?? ['report', 'slides'],
    ...(typeof input.autoCompileEnabled === 'boolean'
      ? { autoCompileEnabled: input.autoCompileEnabled }
      : {}),
  }));

  return { workspace };
}

export async function updateWorkspaceSettings(input: {
  workspaceId: string;
  autoCompileEnabled: boolean;
}): Promise<{
  workspace: ReturnType<ReturnType<typeof openCatalog>['updateWorkspaceAutoCompile']>;
}> {
  const workspace = await withCatalog(({ catalog }) => catalog.updateWorkspaceAutoCompile({
    workspaceId: input.workspaceId,
    autoCompileEnabled: input.autoCompileEnabled,
  }));

  return { workspace };
}

export async function listWorkspaceRecords(): Promise<{
  workspaces: ReturnType<ReturnType<typeof openCatalog>['listWorkspaces']>;
}> {
  const workspaces = await withCatalog(({ catalog }) => catalog.listWorkspaces());
  return { workspaces };
}

export async function bindWorkspaceSources(input: {
  workspaceId: string;
  sourceIds: string[];
}): Promise<{
  workspaceId: string;
  sourceIds: string[];
}> {
  await withCatalog(({ catalog }) => {
    catalog.bindWorkspaceSources(input.workspaceId, input.sourceIds);
    const workspace = catalog.getWorkspace(input.workspaceId);
    if (workspace?.autoCompileEnabled) {
      enqueueWorkspaceCompileIfEligible({
        catalog,
        workspaceId: input.workspaceId,
        sourceIds: input.sourceIds,
      });
    }
  });

  return {
    workspaceId: input.workspaceId,
    sourceIds: input.sourceIds,
  };
}

export async function unbindWorkspaceSources(input: {
  workspaceId: string;
  sourceIds?: string[];
}): Promise<{
  workspaceId: string;
  sourceIds: string[];
}> {
  let removedSourceIds: string[] = [];
  await withCatalog(async ({ catalog, dataDir }) => {
    const existingBindings = catalog.listWorkspaceSourceBindings(input.workspaceId).map((binding) => binding.sourceId);
    removedSourceIds = input.sourceIds && input.sourceIds.length > 0
      ? [...new Set(input.sourceIds)]
      : existingBindings;

    catalog.unbindWorkspaceSources(input.workspaceId, input.sourceIds);

    const artifactPathsToDelete = catalog.listWorkspaceArtifacts(input.workspaceId)
      .filter((artifact) => {
        if (artifact.path === getWorkspaceIndexPath()) {
          return true;
        }

        const provenance = catalog.listWorkspaceArtifactProvenance(input.workspaceId, artifact.path);
        return provenance.length === 0 || provenance.some((entry) => removedSourceIds.includes(entry.sourceId));
      })
      .map((artifact) => artifact.path);

    catalog.deleteWorkspaceArtifacts({
      workspaceId: input.workspaceId,
      artifactPaths: artifactPathsToDelete,
    });
    await Promise.all(artifactPathsToDelete.map((path) => deleteWorkspaceArtifact({
      dataDir,
      workspaceId: input.workspaceId,
      path,
    })));
    await deleteWorkspaceManifest({
      dataDir,
      workspaceId: input.workspaceId,
      fileName: 'compile-state.json',
    });

    const workspace = catalog.getWorkspace(input.workspaceId);
    if (workspace?.autoCompileEnabled) {
      enqueueWorkspaceCompileIfEligible({
        catalog,
        workspaceId: input.workspaceId,
        sourceIds: removedSourceIds,
      });
    }
  });

  return {
    workspaceId: input.workspaceId,
    sourceIds: removedSourceIds,
  };
}

function rrfMergeWorkspaceResults<
  TSource extends { kind: 'source'; chunkId: number },
  TDerived extends { kind: 'derived'; artifactPath: string; sectionTitle: string }
>(
  sourceResults: TSource[],
  derivedResults: TDerived[],
): Array<(TSource | TDerived) & { fusedScore: number }> {
  const rrfK = 60;
  const scored = new Map<string, { result: TSource | TDerived; fusedScore: number }>();

  sourceResults.forEach((result, index) => {
    const key = `source:${result.chunkId}`;
    scored.set(key, {
      result,
      fusedScore: (scored.get(key)?.fusedScore ?? 0) + 1 / (rrfK + index + 1),
    });
  });
  derivedResults.forEach((result, index) => {
    const key = `derived:${result.artifactPath}:${result.sectionTitle}`;
    scored.set(key, {
      result,
      fusedScore: (scored.get(key)?.fusedScore ?? 0) + 1 / (rrfK + index + 1),
    });
  });

  return [...scored.values()]
    .sort((left, right) => right.fusedScore - left.fusedScore)
    .map((entry) => ({
      ...entry.result,
      fusedScore: entry.fusedScore,
    }));
}

export async function getWorkspaceStatus(workspaceId: string): Promise<{
  workspace: NonNullable<ReturnType<ReturnType<typeof openCatalog>['getWorkspace']>>;
  bindings: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceSourceBindings']>;
  artifacts: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceArtifacts']>;
  compileRuns: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceCompileRuns']>;
  compileJob: ReturnType<ReturnType<typeof openCatalog>['getWorkspaceCompileJob']>;
  rawInputs: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceRawInputs']>;
  syncTargets: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceSyncTargets']>;
  questionRuns: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceQuestionRuns']>;
  links: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceArtifactLinks']>;
  graph: ReturnType<typeof analyzeWorkspaceStatus>['graph'];
  lintSummary: ReturnType<typeof analyzeWorkspaceStatus>['lintSummary'];
  health: ReturnType<typeof analyzeWorkspaceStatus>['health'];
}> {
  return withCatalog(({ catalog }) => {
    const workspace = catalog.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${workspaceId}'`,
      );
    }

    const analysis = analyzeWorkspaceStatus({ catalog, workspaceId });
    return {
      workspace,
      bindings: catalog.listWorkspaceSourceBindings(workspaceId),
      artifacts: catalog.listWorkspaceArtifacts(workspaceId),
      compileRuns: catalog.listWorkspaceCompileRuns(workspaceId),
      compileJob: catalog.getWorkspaceCompileJob(workspaceId),
      rawInputs: catalog.listWorkspaceRawInputs(workspaceId),
      syncTargets: catalog.listWorkspaceSyncTargets(workspaceId),
      questionRuns: catalog.listWorkspaceQuestionRuns(workspaceId),
      links: catalog.listWorkspaceArtifactLinks({ workspaceId }),
      graph: analysis.graph,
      lintSummary: analysis.lintSummary,
      health: analysis.health,
    };
  });
}

export async function compileWorkspaceArtifacts(workspaceId: string): Promise<{
  workspaceId: string;
  skipped: boolean;
  sourceFingerprint: string;
  changedSourceIds: string[];
  changedRawInputIds: string[];
  updatedArtifactPaths: string[];
  artifactCount: number;
  compileRunId: string | null;
}> {
  return withCatalog(({ catalog, dataDir }) => compileWorkspaceRun({
    catalog,
    dataDir,
    workspaceId,
  }));
}

export async function runQueuedWorkspaceCompiles(options?: {
  maxJobs?: number;
}): Promise<ReturnType<typeof processQueuedWorkspaceCompileJobs>> {
  return withCatalog(({ catalog, dataDir }) => processQueuedWorkspaceCompileJobs({
    catalog,
    dataDir,
    env: process.env,
    ...(typeof options?.maxJobs === 'number' ? { maxJobs: options.maxJobs } : {}),
  }));
}

export async function searchWorkspaceCatalog(
  workspaceId: string,
  query: string,
  options: WorkspaceSearchOptions = {},
): Promise<{
  workspaceId: string;
  query: string;
  scope: WorkspaceSearchScope;
  limit: number;
  offset: number;
  hasMore: boolean;
  modeRequested: SearchMode;
  modeUsed: SearchMode | 'derived';
  total: number;
  results: Array<
    | {
        kind: 'source';
        scope: 'source';
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
      }
    | {
        kind: 'derived';
        scope: 'derived';
        artifactPath: string;
        artifactKind: string;
        sectionTitle: string;
        markdown: string;
        stale: boolean;
        score: number;
      }
  >;
}> {
  const scope = assertWorkspaceSearchScope(options.scope) ?? 'mixed';
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;

  return withCatalog(async ({ catalog }) => {
    const workspace = catalog.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${workspaceId}'`,
      );
    }

    const sourceIds = catalog.listWorkspaceSourceBindings(workspaceId).map((binding) => binding.sourceId);
    const hybridConfig = getHybridRuntimeConfig();
    const modeRequested = options.mode ?? hybridConfig.defaultSearchMode;

    const sourceResult = scope === 'derived'
      ? {
          total: 0,
          limit,
          offset,
          hasMore: false,
          modeRequested,
          modeUsed: 'lexical' as const,
          results: [],
        }
      : await searchHybridCatalog({
          catalog,
          config: hybridConfig,
          query,
          mode: modeRequested,
          searchInput: {
            sourceIds,
            all: false,
            ...(options.path && options.path.length > 0 ? { pathPatterns: options.path } : {}),
            ...(options.language && options.language.length > 0 ? { languages: options.language } : {}),
            limit: Math.max(limit + offset, limit),
            offset: 0,
          },
        });

    const derivedResult = scope === 'source'
      ? {
          total: 0,
          limit,
          offset,
          hasMore: false,
          results: [],
        }
      : catalog.searchWorkspaceArtifacts({
          workspaceId,
          query,
          limit: Math.max(limit + offset, limit),
          offset: 0,
        });

    const sourceRows = sourceResult.results.map((result) => ({
      ...result,
      kind: 'source' as const,
      scope: 'source' as const,
    }));
    const derivedRows = derivedResult.results.map((result) => ({
      kind: 'derived' as const,
      scope: 'derived' as const,
      artifactPath: result.artifactPath,
      artifactKind: result.kind,
      sectionTitle: result.sectionTitle,
      markdown: result.markdown,
      stale: result.stale,
      score: result.score,
    }));

    const merged = scope === 'mixed'
      ? rrfMergeWorkspaceResults(sourceRows, derivedRows)
      : scope === 'source'
        ? sourceRows
        : derivedRows;
    const paged = merged.slice(offset, offset + limit);
    const total = merged.length;

    return {
      workspaceId,
      query,
      scope,
      limit,
      offset,
      hasMore: offset + paged.length < total,
      modeRequested,
      modeUsed: scope === 'derived' ? 'derived' : sourceResult.modeUsed,
      total,
      results: paged,
    };
  });
}

export async function listWorkspaceArtifacts(workspaceId: string): Promise<{
  workspaceId: string;
  artifacts: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceArtifacts']>;
}> {
  return withCatalog(({ catalog }) => {
    const workspace = catalog.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${workspaceId}'`,
      );
    }

    return {
      workspaceId,
      artifacts: catalog.listWorkspaceArtifacts(workspaceId),
    };
  });
}

export async function showWorkspaceArtifact(workspaceId: string, artifactPath: string): Promise<{
  workspaceId: string;
  artifact: NonNullable<ReturnType<ReturnType<typeof openCatalog>['getWorkspaceArtifact']>>;
  content: string;
  provenance: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceArtifactProvenance']>;
  rawInputProvenance: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceArtifactRawInputProvenance']>;
}> {
  return withCatalog(async ({ catalog, dataDir }) => {
    const artifact = catalog.getWorkspaceArtifact(workspaceId, artifactPath);
    if (!artifact) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceArtifactNotFound,
        `Workspace artifact '${artifactPath}' not found in '${workspaceId}'`,
      );
    }

    const content = await readWorkspaceArtifact({
      dataDir,
      workspaceId,
      path: artifactPath,
    });

    return {
      workspaceId,
      artifact,
      content: content.content,
      provenance: catalog.listWorkspaceArtifactProvenance(workspaceId, artifactPath),
      rawInputProvenance: catalog.listWorkspaceArtifactRawInputProvenance(workspaceId, artifactPath),
    };
  });
}

export async function lintWorkspaceArtifacts(workspaceId: string) {
  return withCatalog(({ catalog }) => lintWorkspaceRun({
    catalog,
    workspaceId,
  }));
}

export async function generateWorkspaceArtifactOutput(input: {
  workspaceId: string;
  format: string;
  name?: string;
  prompt?: string;
}) {
  const format = assertWorkspaceOutputFormat(input.format);
  return withCatalog(({ catalog, dataDir }) => generateWorkspaceOutputRun({
    catalog,
    dataDir,
    workspaceId: input.workspaceId,
    format,
    ...(input.name ? { name: input.name } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
  }));
}

export async function ingestWorkspaceRawInput(input: {
  workspaceId: string;
  kind: string;
  sourcePath: string;
  label?: string;
}): Promise<{
  workspaceId: string;
  rawInput: ReturnType<ReturnType<typeof openCatalog>['upsertWorkspaceRawInput']>;
}> {
  const kind = assertWorkspaceRawInputKind(input.kind);
  const sourcePath = resolve(input.sourcePath);
  const rawInputId = buildWorkspaceRawInputId({ kind, sourcePath });

  return withCatalog(async ({ catalog, dataDir }) => {
    const workspace = catalog.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${input.workspaceId}'`,
      );
    }

    const extraction = kind === 'markdown-dir'
      ? await extractMarkdownDirectoryInput({ absolutePath: sourcePath, ...(input.label ? { label: input.label } : {}) })
      : kind === 'pdf'
        ? await extractPdfInput({ absolutePath: sourcePath, ...(input.label ? { label: input.label } : {}) })
        : await extractImageInput({ absolutePath: sourcePath, ...(input.label ? { label: input.label } : {}) });

    const storagePath = buildWorkspaceRawStoragePath({
      kind,
      rawInputId,
      sourcePath,
    });
    await copyPathIntoWorkspace({
      dataDir,
      workspaceId: input.workspaceId,
      sourcePath,
      targetPath: storagePath,
    });

    let extractedTextPath: string | null = null;
    if (extraction.extractedTextPath) {
      extractedTextPath = `raw/${rawInputId}/${extraction.extractedTextPath}`;
      await writeWorkspaceArtifact({
        dataDir,
        workspaceId: input.workspaceId,
        path: extractedTextPath,
        content: `${renderRawInputExtractedText(extraction.chunks)}\n`,
      });
    }

    const rawInput = catalog.upsertWorkspaceRawInput({
      id: rawInputId,
      workspaceId: input.workspaceId,
      kind,
      label: extraction.label,
      sourcePath,
      storagePath,
      ...(extractedTextPath ? { extractedTextPath } : {}),
      contentHash: extraction.contentHash,
      metadata: extraction.metadata,
      chunks: extraction.chunks,
    });

    if (workspace.autoCompileEnabled) {
      enqueueWorkspaceCompileIfEligible({
        catalog,
        workspaceId: input.workspaceId,
        rawInputIds: [rawInputId],
      });
    }

    return {
      workspaceId: input.workspaceId,
      rawInput,
    };
  });
}

export async function listWorkspaceRawInputsRecord(workspaceId: string): Promise<{
  workspaceId: string;
  rawInputs: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceRawInputs']>;
}> {
  return withCatalog(({ catalog }) => {
    const workspace = catalog.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${workspaceId}'`,
      );
    }

    return {
      workspaceId,
      rawInputs: catalog.listWorkspaceRawInputs(workspaceId),
    };
  });
}

export async function showWorkspaceRawInput(workspaceId: string, rawInputId: string): Promise<{
  workspaceId: string;
  rawInput: NonNullable<ReturnType<ReturnType<typeof openCatalog>['getWorkspaceRawInput']>>;
  chunks: ReturnType<ReturnType<typeof openCatalog>['listWorkspaceRawInputChunks']>;
}> {
  return withCatalog(({ catalog }) => {
    const rawInput = catalog.getWorkspaceRawInput(workspaceId, rawInputId);
    if (!rawInput) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.invalidArgument,
        `Workspace raw input '${rawInputId}' not found in '${workspaceId}'`,
      );
    }

    return {
      workspaceId,
      rawInput,
      chunks: catalog.listWorkspaceRawInputChunks(workspaceId, rawInputId),
    };
  });
}

export async function removeWorkspaceRawInput(input: {
  workspaceId: string;
  rawInputId: string;
}): Promise<{
  workspaceId: string;
  rawInputId: string;
  deleted: boolean;
}> {
  return withCatalog(async ({ catalog, dataDir }) => {
    const workspace = catalog.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${input.workspaceId}'`,
      );
    }

    const rawInput = catalog.getWorkspaceRawInput(input.workspaceId, input.rawInputId);
    if (!rawInput) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.invalidArgument,
        `Workspace raw input '${input.rawInputId}' not found in '${input.workspaceId}'`,
      );
    }

    const artifactPaths = catalog.listWorkspaceArtifacts(input.workspaceId)
      .filter((artifact) => catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, artifact.path)
        .some((entry) => entry.rawInputId === input.rawInputId))
      .map((artifact) => artifact.path);

    catalog.deleteWorkspaceArtifacts({
      workspaceId: input.workspaceId,
      artifactPaths,
    });
    await Promise.all(artifactPaths.map((path) => deleteWorkspaceArtifact({
      dataDir,
      workspaceId: input.workspaceId,
      path,
    })));
    await deleteWorkspacePath({
      dataDir,
      workspaceId: input.workspaceId,
      path: rawInput.storagePath,
    });
    if (rawInput.extractedTextPath) {
      await deleteWorkspaceArtifact({
        dataDir,
        workspaceId: input.workspaceId,
        path: rawInput.extractedTextPath,
      });
    }
    catalog.deleteWorkspaceRawInput(input.workspaceId, input.rawInputId);
    await deleteWorkspaceManifest({
      dataDir,
      workspaceId: input.workspaceId,
      fileName: 'compile-state.json',
    });

    if (workspace.autoCompileEnabled) {
      enqueueWorkspaceCompileIfEligible({
        catalog,
        workspaceId: input.workspaceId,
        rawInputIds: [input.rawInputId],
      });
    }

    return {
      workspaceId: input.workspaceId,
      rawInputId: input.rawInputId,
      deleted: true,
    };
  });
}

export async function searchWorkspaceRawInputCatalog(input: {
  workspaceId: string;
  query: string;
  limit?: number;
  offset?: number;
  kinds?: string[];
}): Promise<{
  workspaceId: string;
  query: string;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  results: ReturnType<ReturnType<typeof openCatalog>['searchWorkspaceRawInputs']>['results'];
}> {
  const normalizedKinds = input.kinds?.map((kind) => assertWorkspaceRawInputKind(kind));
  return withCatalog(({ catalog }) => {
    const result = catalog.searchWorkspaceRawInputs({
      workspaceId: input.workspaceId,
      query: input.query,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
      ...(normalizedKinds && normalizedKinds.length > 0 ? { kinds: normalizedKinds } : {}),
    });

    return {
      workspaceId: input.workspaceId,
      query: input.query,
      ...result,
    };
  });
}

export async function syncWorkspaceToObsidianVault(input: {
  workspaceId: string;
  vaultPath: string;
  exportSubdir?: string;
}): Promise<Awaited<ReturnType<typeof syncWorkspaceToObsidianRun>>> {
  return withCatalog(({ catalog, dataDir }) => syncWorkspaceToObsidianRun({
    catalog,
    dataDir,
    workspaceId: input.workspaceId,
    vaultPath: input.vaultPath,
    ...(input.exportSubdir ? { exportSubdir: input.exportSubdir } : {}),
  }));
}

export async function answerWorkspace(input: {
  workspaceId: string;
  question: string;
  format: string;
  name?: string;
}): Promise<{
  workspaceId: string;
  format: WorkspaceAnswerFormat;
  path: string;
  artifactCount: number;
  questionRun: ReturnType<ReturnType<typeof openCatalog>['recordWorkspaceQuestionRun']>;
}> {
  const format = assertWorkspaceAnswerFormat(input.format);
  const artifactPath = getWorkspaceAnswerPath(format, input.name);
  return withCatalog(async ({ catalog, dataDir }) => {
    try {
      const result = await answerWorkspaceQuestionRun({
        catalog,
        dataDir,
        workspaceId: input.workspaceId,
        question: input.question,
        format,
        ...(input.name ? { name: input.name } : {}),
        env: process.env,
      });
      const questionRun = catalog.recordWorkspaceQuestionRun({
        workspaceId: input.workspaceId,
        question: input.question,
        format,
        artifactPath,
        status: 'success',
      });
      return {
        ...result,
        questionRun,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const questionRun = catalog.recordWorkspaceQuestionRun({
        workspaceId: input.workspaceId,
        question: input.question,
        format,
        artifactPath,
        status: 'failed',
        errorMessage: message,
      });
      const aiocsError = toAiocsError(error);
      throw new AiocsError(
        aiocsError.code,
        aiocsError.message,
        {
          ...(aiocsError.details ? { originalDetails: aiocsError.details } : {}),
          questionRunId: questionRun.id,
        },
      );
    }
  });
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
