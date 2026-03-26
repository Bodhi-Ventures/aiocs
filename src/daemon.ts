import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Catalog } from './catalog/catalog.js';
import { fetchSource } from './fetch/fetch-source.js';
import { loadSourceSpec } from './spec/source-spec.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_CONTAINER_SOURCE_DIR = '/app/sources';
const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const SOURCE_SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

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

export type DaemonCycleResult = {
  startedAt: string;
  finishedAt: string;
  dueSourceIds: string[];
  bootstrapped: BootstrapResult;
  refreshed: RefreshedSource[];
  failed: FailedRefresh[];
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

function getBundledSourceDir(): string {
  return resolve(fileURLToPath(new URL('../sources', import.meta.url)));
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

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const rawPath of paths) {
    const normalized = resolve(rawPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkSpecFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const discovered: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...await walkSpecFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (SOURCE_SPEC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      discovered.push(entryPath);
    }
  }

  return discovered;
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

  const defaultSourceDirs = uniquePaths([
    options.containerSourceDir ?? DEFAULT_CONTAINER_SOURCE_DIR,
    options.bundledSourceDir ?? getBundledSourceDir(),
  ]);

  const sourceSpecDirs = env.AIOCS_SOURCE_SPEC_DIRS
    ? uniquePaths(
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
  const normalizedSourceSpecDirs = uniquePaths(input.sourceSpecDirs);
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
    const specPaths = await walkSpecFiles(sourceSpecDir);
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
  const refreshed: RefreshedSource[] = [];
  const failed: FailedRefresh[] = [];

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
      input.catalog.recordFailedFetchRun({
        sourceId,
        errorMessage,
      });
      failed.push({
        sourceId,
        errorMessage,
      });
    }
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    dueSourceIds,
    bootstrapped,
    refreshed,
    failed,
  };
}

export async function startDaemon(input: StartDaemonInput): Promise<void> {
  const intervalMs = input.config.intervalMinutes * 60_000;
  input.logger.emit({
    type: 'daemon.started',
    intervalMinutes: input.config.intervalMinutes,
    fetchOnStart: input.config.fetchOnStart,
    sourceSpecDirs: input.config.sourceSpecDirs,
  });

  const runCycle = async (reason: 'startup' | 'interval') => {
    const startedAt = nowIso();
    input.logger.emit({
      type: 'daemon.cycle.started',
      reason,
      startedAt,
    });
    const result = await runDaemonCycle({
      catalog: input.catalog,
      dataDir: input.dataDir,
      sourceSpecDirs: input.config.sourceSpecDirs,
      strictSourceSpecDirs: input.config.strictSourceSpecDirs,
      referenceTime: startedAt,
    });
    input.logger.emit({
      type: 'daemon.cycle.completed',
      reason,
      result,
    });
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
