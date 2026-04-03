import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Catalog } from '../catalog/catalog.js';
import { detectLanguage } from '../catalog/chunking.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { matchesPatterns } from '../patterns.js';
import {
  isGitSourceSpec,
  resolveSourceCanary,
  type GitSourceCanaryCheck,
  type GitSourceSpec,
} from '../spec/source-spec.js';

const execFileAsync = promisify(execFile);

type GitFetchInput = {
  catalog: Catalog;
  sourceId: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
};

type GitCanaryInput = {
  catalog: Catalog;
  sourceId: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
};

type GitFetchedPage = {
  url: string;
  title: string;
  markdown: string;
  pageKind: 'file';
  filePath: string;
  language: string | null;
};

export type GitCanaryCheckResult = {
  path: string;
  status: 'pass' | 'fail';
  title?: string;
  markdownLength?: number;
  errorMessage?: string;
};

export type GitCanaryRunResult = {
  sourceId: string;
  status: 'pass' | 'fail';
  checkedAt: string;
  summary: {
    checkCount: number;
    passCount: number;
    failCount: number;
  };
  checks: GitCanaryCheckResult[];
};

type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: 'utf8' | 'buffer';
  authHeader?: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function getGitMirrorDir(dataDir: string, sourceId: string): string {
  return join(dataDir, 'git-mirrors', `${sourceId}.git`);
}

function resolveEnvValue(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.authEnvMissing,
      `Missing required environment variable '${name}' for authenticated source access`,
      { envVar: name },
    );
  }

  return value;
}

function buildGitAuthHeader(spec: GitSourceSpec, env: NodeJS.ProcessEnv): string | null {
  if (!spec.repo.auth) {
    return null;
  }

  const token = resolveEnvValue(spec.repo.auth.tokenFromEnv, env);
  if (spec.repo.auth.scheme === 'bearer') {
    return `AUTHORIZATION: Bearer ${token}`;
  }

  const credentials = Buffer.from(`${spec.repo.auth.username}:${token}`, 'utf8').toString('base64');
  return `AUTHORIZATION: Basic ${credentials}`;
}

async function runGit(
  args: string[],
  options: GitCommandOptions = {},
): Promise<string | Buffer> {
  const commandArgs = options.authHeader
    ? ['-c', `http.extraHeader=${options.authHeader}`, ...args]
    : args;

  const result = await execFileAsync('git', commandArgs, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).catch((error: unknown) => {
    throw new AiocsError(
      AIOCS_ERROR_CODES.internalError,
      `Git command failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        args,
      },
    );
  });

  return result.stdout;
}

async function ensureGitMirror(spec: GitSourceSpec, dataDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const mirrorDir = getGitMirrorDir(dataDir, spec.id);
  mkdirSync(dirname(mirrorDir), { recursive: true });
  const authHeader = buildGitAuthHeader(spec, env);

  if (!existsSync(mirrorDir)) {
    await runGit(['clone', '--mirror', spec.repo.url, mirrorDir], {
      env,
      authHeader,
    });
    return mirrorDir;
  }

  await runGit(['--git-dir', mirrorDir, 'remote', 'set-url', 'origin', spec.repo.url], {
    env,
    authHeader,
  });
  await runGit(['--git-dir', mirrorDir, 'fetch', '--prune', '--prune-tags', '--tags', 'origin'], {
    env,
    authHeader,
  });

  return mirrorDir;
}

async function resolveGitCommit(mirrorDir: string, ref: string, env: NodeJS.ProcessEnv): Promise<string> {
  const stdout = await runGit(['--git-dir', mirrorDir, 'rev-parse', `${ref}^{commit}`], {
    env,
  });
  return String(stdout).trim();
}

async function listRepoFiles(mirrorDir: string, commitSha: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const stdout = await runGit(['--git-dir', mirrorDir, 'ls-tree', '-r', '-z', '--name-only', commitSha], {
    env,
    encoding: 'buffer',
  });
  const entries = stdout instanceof Buffer ? stdout.toString('utf8') : String(stdout);
  return entries
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isIncluded(spec: GitSourceSpec, filePath: string): boolean {
  if (!matchesPatterns(filePath, spec.repo.include)) {
    return false;
  }

  if (spec.repo.exclude.length > 0 && matchesPatterns(filePath, spec.repo.exclude)) {
    return false;
  }

  return true;
}

async function getObjectSize(
  mirrorDir: string,
  commitSha: string,
  filePath: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const stdout = await runGit(['--git-dir', mirrorDir, 'cat-file', '-s', `${commitSha}:${filePath}`], {
    env,
  });
  return Number(String(stdout).trim());
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function readRepoFile(
  mirrorDir: string,
  commitSha: string,
  filePath: string,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const stdout = await runGit(['--git-dir', mirrorDir, 'show', `${commitSha}:${filePath}`], {
    env,
    encoding: 'buffer',
  });
  return stdout instanceof Buffer ? stdout : Buffer.from(String(stdout), 'utf8');
}

function normalizeRepoUrl(repoUrl: string): URL {
  return new URL(repoUrl);
}

function normalizeRepoWebBase(repoUrl: string): string {
  const url = normalizeRepoUrl(repoUrl);
  const pathname = url.pathname.replace(/\.git$/i, '');
  return `${url.origin}${pathname}`;
}

function buildRepoFileUrl(spec: GitSourceSpec, filePath: string): string {
  const url = normalizeRepoUrl(spec.repo.url);
  const encodedPath = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const encodedRef = spec.repo.ref.split('/').map((segment) => encodeURIComponent(segment)).join('/');

  if (url.protocol === 'file:') {
    return `${spec.repo.url}#ref=${encodeURIComponent(spec.repo.ref)}&path=${encodeURIComponent(filePath)}`;
  }

  const base = normalizeRepoWebBase(spec.repo.url);
  if (url.hostname === 'github.com') {
    return `${base}/blob/${encodedRef}/${encodedPath}`;
  }
  if (url.hostname === 'gitlab.com') {
    return `${base}/-/blob/${encodedRef}/${encodedPath}`;
  }

  return `${base}#ref=${encodeURIComponent(spec.repo.ref)}&path=${encodeURIComponent(filePath)}`;
}

function persistGitSnapshotFiles(
  input: GitFetchInput,
  snapshotId: string,
  pages: GitFetchedPage[],
): void {
  const snapshotDir = join(input.dataDir, 'sources', input.sourceId, 'snapshots', snapshotId, 'files');
  for (const page of pages) {
    const filePath = join(snapshotDir, page.filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, page.markdown, 'utf8');
  }
}

async function materializeGitPages(
  spec: GitSourceSpec,
  mirrorDir: string,
  commitSha: string,
  env: NodeJS.ProcessEnv,
): Promise<GitFetchedPage[]> {
  const repoFiles = await listRepoFiles(mirrorDir, commitSha, env);
  const includedFiles = repoFiles.filter((filePath) => isIncluded(spec, filePath));

  if (includedFiles.length > spec.repo.maxFiles) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Git source '${spec.id}' matched ${includedFiles.length} files, exceeding maxFiles=${spec.repo.maxFiles}`,
    );
  }

  const pages: GitFetchedPage[] = [];
  for (const filePath of includedFiles) {
    const size = await getObjectSize(mirrorDir, commitSha, filePath, env);
    if (!Number.isFinite(size) || size > spec.repo.textFileMaxBytes) {
      continue;
    }

    const content = await readRepoFile(mirrorDir, commitSha, filePath, env).catch(() => null);
    if (!content || isProbablyBinary(content)) {
      continue;
    }

    const markdown = content.toString('utf8').trimEnd();
    if (!markdown.trim()) {
      continue;
    }

    pages.push({
      url: buildRepoFileUrl(spec, filePath),
      title: filePath,
      markdown,
      pageKind: 'file',
      filePath,
      language: detectLanguage(filePath),
    });
  }

  return pages.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function assertCanaryPathInScope(spec: GitSourceSpec, check: GitSourceCanaryCheck): void {
  if (!isIncluded(spec, check.path)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Git canary path '${check.path}' is outside the configured include/exclude scope`,
    );
  }
}

async function readCanaryTarget(
  spec: GitSourceSpec,
  mirrorDir: string,
  commitSha: string,
  check: GitSourceCanaryCheck,
  env: NodeJS.ProcessEnv,
): Promise<GitFetchedPage> {
  assertCanaryPathInScope(spec, check);
  const content = await readRepoFile(mirrorDir, commitSha, check.path, env);
  if (isProbablyBinary(content)) {
    throw new Error(`Canary target '${check.path}' is binary`);
  }

  return {
    url: buildRepoFileUrl(spec, check.path),
    title: check.path,
    markdown: content.toString('utf8').trimEnd(),
    pageKind: 'file',
    filePath: check.path,
    language: detectLanguage(check.path),
  };
}

export async function fetchGitSource(input: GitFetchInput): Promise<{
  snapshotId: string;
  pageCount: number;
  reused: boolean;
  detectedVersion: string;
}> {
  const spec = input.catalog.getSourceSpec(input.sourceId);
  if (!spec || !isGitSourceSpec(spec)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.sourceNotFound,
      `Unknown git source '${input.sourceId}'`,
    );
  }

  const env = input.env ?? process.env;
  const mirrorDir = await ensureGitMirror(spec, input.dataDir, env);
  const commitSha = await resolveGitCommit(mirrorDir, spec.repo.ref, env);
  const pages = await materializeGitPages(spec, mirrorDir, commitSha, env);

  if (pages.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.noPagesFetched,
      `No text files fetched for git source '${input.sourceId}'`,
    );
  }

  const result = input.catalog.recordSuccessfulSnapshot({
    sourceId: input.sourceId,
    detectedVersion: commitSha,
    revisionKey: commitSha,
    pages,
  });

  if (!result.reused) {
    persistGitSnapshotFiles(input, result.snapshotId, pages);
  }

  return {
    snapshotId: result.snapshotId,
    pageCount: pages.length,
    reused: result.reused,
    detectedVersion: commitSha,
  };
}

export async function runGitSourceCanary(input: GitCanaryInput): Promise<GitCanaryRunResult> {
  const spec = input.catalog.getSourceSpec(input.sourceId);
  if (!spec || !isGitSourceSpec(spec)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.sourceNotFound,
      `Unknown git source '${input.sourceId}'`,
    );
  }

  const env = input.env ?? process.env;
  const dataDir = input.dataDir ?? join(process.env.HOME ?? '', '.aiocs', 'data');
  const mirrorDir = await ensureGitMirror(spec, dataDir, env);
  const commitSha = await resolveGitCommit(mirrorDir, spec.repo.ref, env);
  const canary = resolveSourceCanary(spec);
  const checkedAt = nowIso();
  const checks: GitCanaryCheckResult[] = [];

  for (const check of canary.checks) {
    try {
      const page = await readCanaryTarget(spec, mirrorDir, commitSha, check, env);
      if (check.expectedTitle && !page.title.includes(check.expectedTitle)) {
        throw new Error(`Expected title to include '${check.expectedTitle}'`);
      }
      if (check.expectedText && !page.markdown.includes(check.expectedText)) {
        throw new Error(`Expected markdown to include '${check.expectedText}'`);
      }
      if (page.markdown.trim().length < check.minContentLength) {
        throw new Error(`Expected content length to be at least ${check.minContentLength}`);
      }

      checks.push({
        path: check.path,
        status: 'pass',
        title: page.title,
        markdownLength: page.markdown.trim().length,
      });
    } catch (error) {
      checks.push({
        path: check.path,
        status: 'fail',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const passCount = checks.filter((check) => check.status === 'pass').length;
  const failCount = checks.length - passCount;
  const status = failCount > 0 ? 'fail' : 'pass';
  const result: GitCanaryRunResult = {
    sourceId: input.sourceId,
    status,
    checkedAt,
    summary: {
      checkCount: checks.length,
      passCount,
      failCount,
    },
    checks,
  };

  input.catalog.recordCanaryRun({
    sourceId: input.sourceId,
    status,
    checkedAt,
    details: result,
  });

  if (status === 'fail') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.canaryFailed,
      `Git source canary failed for '${input.sourceId}'`,
      result,
    );
  }

  return result;
}
