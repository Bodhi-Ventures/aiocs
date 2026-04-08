import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Catalog } from './catalog/catalog.js';
import { fetchSource, runSourceCanary } from './fetch/fetch-source.js';
import { processEmbeddingJobs } from './hybrid/worker.js';
import { loadSourceSpec } from './spec/source-spec.js';
import { getBundledSourcesDir } from './runtime/bundled-sources.js';
import { getAiocsSourcesDir } from './runtime/paths.js';
import { getHybridRuntimeConfig } from './runtime/hybrid-config.js';
import { pathExists, uniqueResolvedPaths, walkSourceSpecFiles } from './spec/source-spec-files.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_CONTAINER_SOURCE_DIR = '/app/sources';
const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export type DaemonConfig = {
  intervalMinutes: number;
  fetchOnStart: boolean;
  strictSourceSpecDirs: boolean;
  sourceSpecDirs: string[];
};

export type BootstrappedSource = {
  sourceId: string;
  specPath: string;
  configHash: string;
  configChanged: boolean;
};

export type BootstrapResult = {
  processedSpecCount: number;
  removedSourceIds: string[];
  sources: BootstrappedSource[];
};

export type RefreshedSource = {
  sourceId: string;
  snapshotId: string;
  pageCount: number;
  reused: boolean;
};

export type FailedRefresh = {
  sourceId: string;
  errorMessage: string;
};

export type CanariedSource = {
  sourceId: string;
  status: 'pass' | 'fail';
  checkedAt: string;
  summary: {
    checkCount: number;
    passCount: number;
    failCount: number;
  };
};

export type FailedCanary = {
  sourceId: string;
  errorMessage: string;
};

export type EmbeddedSnapshot = {
  sourceId: string;
  snapshotId: string;
  chunkCount: number;
};

export type FailedEmbedding = {
  sourceId: string;
  snapshotId: string;
  errorMessage: string;
};

export type DaemonCycleResult = {
  startedAt: string;
  finishedAt: string;
  dueSourceIds: string[];
  canaryDueSourceIds: string[];
  bootstrapped: BootstrapResult;
  canaried: CanariedSource[];
  canaryFailed: FailedCanary[];
  refreshed: RefreshedSource[];
  failed: FailedRefresh[];
  embedded: EmbeddedSnapshot[];
  embeddingFailed: FailedEmbedding[];
};

export type DaemonEvent =
  | {
      type: 'daemon.started';
      intervalMinutes: number;
      fetchOnStart: boolean;
      sourceSpecDirs: string[];
    }
  | {
      type: 'daemon.stopped';
    }
  | {
      type: 'daemon.cycle.started';
      reason: 'startup' | 'interval';
      startedAt: string;
    }
  | {
      type: 'daemon.cycle.completed';
      reason: 'startup' | 'interval';
      result: DaemonCycleResult;
    };

export type DaemonLogger = {
  emit(event: DaemonEvent): void;
};

type ParseDaemonConfigOptions = {
  bundledSourceDir?: string;
  containerSourceDir?: string;
  userSourceDir?: string;
};

type BootstrapSourceSpecsInput = {
  catalog: Catalog;
  sourceSpecDirs: string[];
  strictSourceSpecDirs?: boolean;
};

type RunDaemonCycleInput = {
  catalog: Catalog;
  dataDir: string;
  sourceSpecDirs: string[];
  strictSourceSpecDirs?: boolean;
  referenceTime?: string;
};

type StartDaemonInput = {
  catalog: Catalog;
  dataDir: string;
  config: DaemonConfig;
  logger: DaemonLogger;
  signal?: AbortSignal;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parsePositiveInteger(raw: string, variableName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${variableName} must be a positive integer`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(raw: string, variableName: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new Error(`${variableName} must be one of: true, false, 1, 0, yes, no, on, off`);
}

export function parseDaemonConfig(
  env: NodeJS.ProcessEnv,
  options: ParseDaemonConfigOptions = {},
): DaemonConfig {
  const intervalMinutes = env.AIOCS_DAEMON_INTERVAL_MINUTES
    ? parsePositiveInteger(env.AIOCS_DAEMON_INTERVAL_MINUTES, 'AIOCS_DAEMON_INTERVAL_MINUTES')
    : DEFAULT_INTERVAL_MINUTES;

  const fetchOnStart = env.AIOCS_DAEMON_FETCH_ON_START
    ? parseBoolean(env.AIOCS_DAEMON_FETCH_ON_START, 'AIOCS_DAEMON_FETCH_ON_START')
    : true;

  const defaultContainerSourceDir = options.containerSourceDir
    ?? (existsSync(DEFAULT_CONTAINER_SOURCE_DIR) ? DEFAULT_CONTAINER_SOURCE_DIR : undefined);
  const defaultSourceDirs = uniqueResolvedPaths([
    options.bundledSourceDir ?? getBundledSourcesDir(),
    options.userSourceDir ?? getAiocsSourcesDir(env),
    ...(defaultContainerSourceDir ? [defaultContainerSourceDir] : []),
  ]);

  const sourceSpecDirs = env.AIOCS_SOURCE_SPEC_DIRS
    ? uniqueResolvedPaths(
      env.AIOCS_SOURCE_SPEC_DIRS
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    : defaultSourceDirs;

  if (env.AIOCS_SOURCE_SPEC_DIRS && sourceSpecDirs.length === 0) {
    throw new Error('AIOCS_SOURCE_SPEC_DIRS must include at least one directory');
  }

  return {
    intervalMinutes,
    fetchOnStart,
    strictSourceSpecDirs: Boolean(env.AIOCS_SOURCE_SPEC_DIRS),
    sourceSpecDirs,
  };
}

export async function bootstrapSourceSpecs(input: BootstrapSourceSpecsInput): Promise<BootstrapResult> {
  const normalizedSourceSpecDirs = uniqueResolvedPaths(input.sourceSpecDirs);
  const missingDirs: string[] = [];
  const existingDirs: string[] = [];
  const sources: BootstrappedSource[] = [];

  for (const sourceSpecDir of normalizedSourceSpecDirs) {
    if (!await pathExists(sourceSpecDir)) {
      missingDirs.push(sourceSpecDir);
      continue;
    }
    existingDirs.push(sourceSpecDir);
  }

  if (input.strictSourceSpecDirs && missingDirs.length > 0) {
    throw new Error(`Missing source spec directories: ${missingDirs.join(', ')}`);
  }

  for (const sourceSpecDir of existingDirs) {
    const specPaths = await walkSourceSpecFiles(sourceSpecDir);
    for (const specPath of specPaths) {
      const spec = await loadSourceSpec(specPath);
      const upserted = input.catalog.upsertSource(spec, { specPath });
      sources.push({
        sourceId: upserted.sourceId,
        configHash: upserted.configHash,
        configChanged: upserted.configChanged,
        specPath,
      });
    }
  }

  if (input.strictSourceSpecDirs && sources.length === 0) {
    throw new Error(`No source spec files found in configured directories: ${normalizedSourceSpecDirs.join(', ')}`);
  }

  const removedSourceIds = input.catalog.removeManagedSources({
    managedRoots: existingDirs.map((sourceSpecDir) => resolve(sourceSpecDir)),
    activeSources: sources.map((source) => ({
      sourceId: source.sourceId,
      specPath: source.specPath,
    })),
  });

  return {
    processedSpecCount: sources.length,
    removedSourceIds,
    sources,
  };
}

export async function runDaemonCycle(input: RunDaemonCycleInput): Promise<DaemonCycleResult> {
  const startedAt = nowIso();
  const bootstrapped = await bootstrapSourceSpecs({
    catalog: input.catalog,
    sourceSpecDirs: input.sourceSpecDirs,
    ...(input.strictSourceSpecDirs !== undefined ? { strictSourceSpecDirs: input.strictSourceSpecDirs } : {}),
  });
  const dueSourceIds = [
    ...new Set([
      ...input.catalog.listDueSourceIds(input.referenceTime ?? startedAt),
      ...bootstrapped.sources.filter((source) => source.configChanged).map((source) => source.sourceId),
    ]),
  ];
  const canaryDueSourceIds = [
    ...new Set([
      ...input.catalog.listCanaryDueSourceIds(input.referenceTime ?? startedAt),
      ...bootstrapped.sources.filter((source) => source.configChanged).map((source) => source.sourceId),
      ...input.catalog.listSources()
        .filter((source) => source.lastCanaryCheckedAt === null)
        .map((source) => source.id),
    ]),
  ];
  const canaried: CanariedSource[] = [];
  const canaryFailed: FailedCanary[] = [];
  const refreshed: RefreshedSource[] = [];
  const failed: FailedRefresh[] = [];
  const embedded: EmbeddedSnapshot[] = [];
  const embeddingFailed: FailedEmbedding[] = [];

  for (const sourceId of canaryDueSourceIds) {
    try {
      const result = await runSourceCanary({
        catalog: input.catalog,
        sourceId,
        dataDir: input.dataDir,
        env: process.env,
      });
      canaried.push({
        sourceId,
        status: result.status,
        checkedAt: result.checkedAt,
        summary: result.summary,
      });
      if (result.status === 'fail') {
        canaryFailed.push({
          sourceId,
          errorMessage: `One or more canary checks failed for ${sourceId}`,
        });
      }
    } catch (error) {
      canaryFailed.push({
        sourceId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const sourceId of dueSourceIds) {
    try {
      const result = await fetchSource({
        catalog: input.catalog,
        dataDir: input.dataDir,
        sourceId,
      });
      refreshed.push({
        sourceId,
        snapshotId: result.snapshotId,
        pageCount: result.pageCount,
        reused: result.reused,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      failed.push({
        sourceId,
        errorMessage,
      });
    }
  }

  try {
    const embeddingResult = await processEmbeddingJobs({
      catalog: input.catalog,
      config: getHybridRuntimeConfig(process.env),
    });
    embedded.push(...embeddingResult.succeededJobs);
    embeddingFailed.push(...embeddingResult.failedJobs);
  } catch (error) {
    embeddingFailed.push({
      sourceId: 'system',
      snapshotId: 'system',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    dueSourceIds,
    canaryDueSourceIds,
    bootstrapped,
    canaried,
    canaryFailed,
    refreshed,
    failed,
    embedded,
    embeddingFailed,
  };
}

export async function startDaemon(input: StartDaemonInput): Promise<void> {
  const intervalMs = input.config.intervalMinutes * 60_000;
  input.catalog.resetRunningEmbeddingJobs();
  input.catalog.markDaemonStarted({
    startedAt: nowIso(),
    intervalMinutes: input.config.intervalMinutes,
    fetchOnStart: input.config.fetchOnStart,
  });
  input.logger.emit({
    type: 'daemon.started',
    intervalMinutes: input.config.intervalMinutes,
    fetchOnStart: input.config.fetchOnStart,
    sourceSpecDirs: input.config.sourceSpecDirs,
  });

  const runCycle = async (reason: 'startup' | 'interval') => {
    const startedAt = nowIso();
    input.catalog.markDaemonCycleStarted(startedAt);
    input.logger.emit({
      type: 'daemon.cycle.started',
      reason,
      startedAt,
    });
    try {
      const result = await runDaemonCycle({
        catalog: input.catalog,
        dataDir: input.dataDir,
        sourceSpecDirs: input.config.sourceSpecDirs,
        strictSourceSpecDirs: input.config.strictSourceSpecDirs,
        referenceTime: startedAt,
      });
      input.catalog.markDaemonCycleCompleted({
        completedAt: result.finishedAt,
        status: result.failed.length > 0 || result.canaryFailed.length > 0 || result.embeddingFailed.length > 0
          ? 'degraded'
          : 'success',
      });
      input.logger.emit({
        type: 'daemon.cycle.completed',
        reason,
        result,
      });
    } catch (error) {
      input.catalog.markDaemonCycleCompleted({
        completedAt: nowIso(),
        status: 'failed',
      });
      throw error;
    }
  };

  if (input.config.fetchOnStart && !input.signal?.aborted) {
    await runCycle('startup');
  }

  while (!input.signal?.aborted) {
    try {
      await sleep(intervalMs, undefined, { signal: input.signal });
    } catch (error) {
      if (input.signal?.aborted) {
        break;
      }
      throw error;
    }

    if (input.signal?.aborted) {
      break;
    }

    await runCycle('interval');
  }

  input.logger.emit({
    type: 'daemon.stopped',
  });
}
