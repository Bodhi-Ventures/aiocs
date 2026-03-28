import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openCatalog } from './catalog/catalog.js';
import { parseDaemonConfig } from './daemon.js';
import { getAiocsConfigDir, getAiocsDataDir } from './runtime/paths.js';
import { getBundledSourcesDir } from './runtime/bundled-sources.js';
import { pathExists, walkSourceSpecFiles } from './spec/source-spec-files.js';

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorSummaryStatus = 'healthy' | 'degraded' | 'unhealthy';

export type DoctorCheck = {
  id:
    | 'catalog'
    | 'playwright'
    | 'daemon-config'
    | 'source-spec-dirs'
    | 'freshness'
    | 'daemon-heartbeat'
    | 'docker';
  status: DoctorCheckStatus;
  summary: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  summary: {
    status: DoctorSummaryStatus;
    checkCount: number;
    passCount: number;
    warnCount: number;
    failCount: number;
  };
  checks: DoctorCheck[];
};

function summarize(checks: DoctorCheck[]): DoctorReport['summary'] {
  const passCount = checks.filter((check) => check.status === 'pass').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const failCount = checks.filter((check) => check.status === 'fail').length;

  return {
    status: failCount > 0 ? 'unhealthy' : warnCount > 0 ? 'degraded' : 'healthy',
    checkCount: checks.length,
    passCount,
    warnCount,
    failCount,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function checkCatalog(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const dataDir = getAiocsDataDir(env);
  const configDir = getAiocsConfigDir(env);
  let catalog = null;

  try {
    catalog = openCatalog({ dataDir });
    const sourceCount = catalog.listSources().length;
    const projectLinkCount = catalog.listProjectLinks().length;
    return {
      id: 'catalog',
      status: 'pass',
      summary: `Catalog opened successfully at ${dataDir}`,
      details: {
        dataDir,
        configDir,
        sourceCount,
        projectLinkCount,
      },
    };
  } catch (error) {
    return {
      id: 'catalog',
      status: 'fail',
      summary: `Catalog unavailable: ${toErrorMessage(error)}`,
      details: {
        dataDir,
        configDir,
      },
    };
  } finally {
    catalog?.close();
  }
}

async function checkPlaywright(): Promise<DoctorCheck> {
  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    if (!executablePath) {
      return {
        id: 'playwright',
        status: 'fail',
        summary: 'Playwright is installed but Chromium has no resolved executable path.',
      };
    }

    await access(executablePath);
    return {
      id: 'playwright',
      status: 'pass',
      summary: 'Playwright Chromium executable is available.',
      details: {
        executablePath,
      },
    };
  } catch (error) {
    return {
      id: 'playwright',
      status: 'fail',
      summary: `Playwright is not ready: ${toErrorMessage(error)}`,
    };
  }
}

async function checkDaemonConfig(env: NodeJS.ProcessEnv): Promise<{
  daemonConfigCheck: DoctorCheck;
  daemonConfig: ReturnType<typeof parseDaemonConfig> | null;
}> {
  try {
    const daemonConfig = parseDaemonConfig(env, {
      bundledSourceDir: getBundledSourcesDir(),
    });
    return {
      daemonConfig,
      daemonConfigCheck: {
        id: 'daemon-config',
        status: 'pass',
        summary: 'Daemon configuration parsed successfully.',
        details: daemonConfig,
      },
    };
  } catch (error) {
    return {
      daemonConfig: null,
      daemonConfigCheck: {
        id: 'daemon-config',
        status: 'fail',
        summary: `Daemon configuration is invalid: ${toErrorMessage(error)}`,
      },
    };
  }
}

async function checkSourceSpecDirs(
  daemonConfig: ReturnType<typeof parseDaemonConfig> | null,
): Promise<DoctorCheck> {
  if (!daemonConfig) {
    return {
      id: 'source-spec-dirs',
      status: 'fail',
      summary: 'Source spec directories cannot be validated until daemon configuration is valid.',
    };
  }

  const directories = await Promise.all(daemonConfig.sourceSpecDirs.map(async (directory) => {
    const exists = await pathExists(directory);
    const specFiles = exists ? await walkSourceSpecFiles(directory) : [];
    return {
      directory,
      exists,
      specCount: specFiles.length,
    };
  }));

  const existingCount = directories.filter((directory) => directory.exists).length;
  const totalSpecCount = directories.reduce((sum, directory) => sum + directory.specCount, 0);

  let status: DoctorCheckStatus = 'pass';
  let summary = `Validated ${directories.length} source spec director${directories.length === 1 ? 'y' : 'ies'}.`;

  if (directories.length === 0) {
    status = 'fail';
    summary = 'No source spec directories are configured.';
  } else if (daemonConfig.strictSourceSpecDirs && directories.some((directory) => !directory.exists)) {
    status = 'fail';
    summary = 'One or more explicitly configured source spec directories are missing.';
  } else if (existingCount === 0) {
    status = 'warn';
    summary = 'No configured source spec directories currently exist.';
  } else if (totalSpecCount === 0) {
    status = 'warn';
    summary = 'Configured source spec directories exist but contain no source specs.';
  } else if (directories.some((directory) => !directory.exists)) {
    status = 'warn';
    summary = 'Some optional source spec directories are missing.';
  }

  return {
    id: 'source-spec-dirs',
    status,
    summary,
    details: {
      strict: daemonConfig.strictSourceSpecDirs,
      directories,
    },
  };
}

async function checkFreshness(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const dataDir = getAiocsDataDir(env);
  let catalog = null;

  try {
    catalog = openCatalog({ dataDir });
    const sources = catalog.listSources();
    const referenceTime = Date.now();

    if (sources.length === 0) {
      return {
        id: 'freshness',
        status: 'pass',
        summary: 'No sources are registered, so no source freshness checks are pending.',
        details: {
          sourceCount: 0,
        },
      };
    }

    const staleSources = sources
      .filter((source) => !source.lastSuccessfulSnapshotId || Date.parse(source.nextDueAt) <= referenceTime)
      .map((source) => ({
        sourceId: source.id,
        nextDueAt: source.nextDueAt,
        lastSuccessfulSnapshotAt: source.lastSuccessfulSnapshotAt,
      }));

    const staleCanaries = sources
      .filter((source) =>
        (source.nextCanaryDueAt && Date.parse(source.nextCanaryDueAt) <= referenceTime)
        || source.lastCanaryStatus === 'fail',
      )
      .map((source) => ({
        sourceId: source.id,
        nextCanaryDueAt: source.nextCanaryDueAt,
        lastCanaryCheckedAt: source.lastCanaryCheckedAt,
        lastCanaryStatus: source.lastCanaryStatus,
      }));

    const status: DoctorCheckStatus = staleSources.length > 0 || staleCanaries.length > 0 ? 'warn' : 'pass';
    const summary = status === 'pass'
      ? 'Source snapshots and canaries are fresh.'
      : `Source freshness issues detected: ${staleSources.length} stale snapshot scope(s), ${staleCanaries.length} stale/failed canary scope(s).`;

    return {
      id: 'freshness',
      status,
      summary,
      details: {
        sourceCount: sources.length,
        staleSources,
        staleCanaries,
      },
    };
  } catch (error) {
    return {
      id: 'freshness',
      status: 'fail',
      summary: `Freshness checks failed: ${toErrorMessage(error)}`,
    };
  } finally {
    catalog?.close();
  }
}

async function checkDaemonHeartbeat(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const dataDir = getAiocsDataDir(env);
  let catalog = null;

  try {
    catalog = openCatalog({ dataDir });
    const daemonState = catalog.getDaemonState();
    if (!daemonState) {
      return {
        id: 'daemon-heartbeat',
        status: 'warn',
        summary: 'No daemon heartbeat has been recorded yet.',
      };
    }

    const intervalMinutes = daemonState.intervalMinutes ?? 60;
    const completedAt = parseTimestamp(daemonState.lastCycleCompletedAt);
    if (!completedAt) {
      return {
        id: 'daemon-heartbeat',
        status: 'warn',
        summary: 'Daemon heartbeat exists but no completed cycle has been recorded yet.',
        details: daemonState,
      };
    }

    const ageMinutes = Math.floor((Date.now() - completedAt) / 60_000);
    const stale = ageMinutes > intervalMinutes * 2;
    const unhealthyStatus = daemonState.lastCycleStatus === 'failed' || daemonState.lastCycleStatus === 'degraded';

    return {
      id: 'daemon-heartbeat',
      status: stale || unhealthyStatus ? 'warn' : 'pass',
      summary: stale || unhealthyStatus
        ? `Daemon heartbeat is stale or unhealthy (age=${ageMinutes}m, status=${daemonState.lastCycleStatus ?? 'unknown'}).`
        : `Daemon heartbeat is recent (age=${ageMinutes}m).`,
      details: {
        ...daemonState,
        ageMinutes,
      },
    };
  } catch (error) {
    return {
      id: 'daemon-heartbeat',
      status: 'fail',
      summary: `Daemon heartbeat check failed: ${toErrorMessage(error)}`,
    };
  } finally {
    catalog?.close();
  }
}

async function checkDocker(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{json .ServerVersion}}']);
    const version = JSON.parse(stdout.trim()) as string;
    return {
      id: 'docker',
      status: 'pass',
      summary: `Docker is available (server ${version}).`,
      details: {
        serverVersion: version,
      },
    };
  } catch (error) {
    const message = toErrorMessage(error);

    if (message.includes('ENOENT')) {
      return {
        id: 'docker',
        status: 'warn',
        summary: 'Docker CLI is not installed; Docker-based daemon deployment is unavailable on this machine.',
      };
    }

    return {
      id: 'docker',
      status: 'warn',
      summary: `Docker is not ready: ${message}`,
    };
  }
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const catalogCheck = await checkCatalog(env);
  const playwrightCheck = await checkPlaywright();
  const { daemonConfigCheck, daemonConfig } = await checkDaemonConfig(env);
  const sourceSpecDirsCheck = await checkSourceSpecDirs(daemonConfig);
  const freshnessCheck = await checkFreshness(env);
  const daemonHeartbeatCheck = await checkDaemonHeartbeat(env);
  const dockerCheck = await checkDocker();
  const checks = [
    catalogCheck,
    playwrightCheck,
    daemonConfigCheck,
    sourceSpecDirsCheck,
    freshnessCheck,
    daemonHeartbeatCheck,
    dockerCheck,
  ];

  return {
    summary: summarize(checks),
    checks,
  };
}
