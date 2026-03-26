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
  id: 'catalog' | 'playwright' | 'daemon-config' | 'source-spec-dirs' | 'docker';
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

async function checkCatalog(): Promise<DoctorCheck> {
  const dataDir = getAiocsDataDir();
  const configDir = getAiocsConfigDir();
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
  const catalogCheck = await checkCatalog();
  const playwrightCheck = await checkPlaywright();
  const { daemonConfigCheck, daemonConfig } = await checkDaemonConfig(env);
  const sourceSpecDirsCheck = await checkSourceSpecDirs(daemonConfig);
  const dockerCheck = await checkDocker();
  const checks = [
    catalogCheck,
    playwrightCheck,
    daemonConfigCheck,
    sourceSpecDirsCheck,
    dockerCheck,
  ];

  return {
    summary: summarize(checks),
    checks,
  };
}
