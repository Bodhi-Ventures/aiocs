import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';

import { getBundledSourcesDir } from './bundled-sources.js';

const PORTABLE_USER_SOURCES_PREFIX = '~/.aiocs/sources';
const PORTABLE_BUNDLED_SOURCES_PREFIX = 'aiocs://bundled';
const CONTAINER_USER_SOURCES_DIR = '/root/.aiocs/sources';
const CONTAINER_BUNDLED_SOURCES_DIR = '/app/sources';

function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function getAiocsDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AIOCS_DATA_DIR;
  if (override) {
    mkdirSync(expandTilde(override), { recursive: true });
    return expandTilde(override);
  }

  const target = join(homedir(), '.aiocs', 'data');
  mkdirSync(target, { recursive: true });
  return target;
}

export function getAiocsGitMirrorsDir(env: NodeJS.ProcessEnv = process.env): string {
  const target = join(getAiocsDataDir(env), 'git-mirrors');
  mkdirSync(target, { recursive: true });
  return target;
}

export function getAiocsConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AIOCS_CONFIG_DIR;
  if (override) {
    mkdirSync(expandTilde(override), { recursive: true });
    return expandTilde(override);
  }

  const target = join(homedir(), '.aiocs', 'config');
  mkdirSync(target, { recursive: true });
  return target;
}

export function getAiocsSourcesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AIOCS_SOURCES_DIR;
  if (override) {
    mkdirSync(expandTilde(override), { recursive: true });
    return expandTilde(override);
  }

  const target = join(homedir(), '.aiocs', 'sources');
  mkdirSync(target, { recursive: true });
  return target;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function toPortablePath(prefix: string, rootPath: string, candidatePath: string): string {
  const relativePath = relative(rootPath, candidatePath).split(sep).join('/');
  return relativePath ? `${prefix}/${relativePath}` : prefix;
}

export function canonicalizeManagedSpecPath(
  specPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    specPath === PORTABLE_USER_SOURCES_PREFIX
    || specPath.startsWith(`${PORTABLE_USER_SOURCES_PREFIX}/`)
    || specPath === PORTABLE_BUNDLED_SOURCES_PREFIX
    || specPath.startsWith(`${PORTABLE_BUNDLED_SOURCES_PREFIX}/`)
  ) {
    return specPath;
  }

  const resolvedPath = resolve(specPath);
  const userRoots = [resolve(getAiocsSourcesDir(env)), CONTAINER_USER_SOURCES_DIR];
  for (const rootPath of userRoots) {
    if (isWithinRoot(resolvedPath, rootPath)) {
      return toPortablePath(PORTABLE_USER_SOURCES_PREFIX, rootPath, resolvedPath);
    }
  }

  const bundledRoots = [resolve(getBundledSourcesDir()), CONTAINER_BUNDLED_SOURCES_DIR];
  for (const rootPath of bundledRoots) {
    if (isWithinRoot(resolvedPath, rootPath)) {
      return toPortablePath(PORTABLE_BUNDLED_SOURCES_PREFIX, rootPath, resolvedPath);
    }
  }

  return resolvedPath;
}
