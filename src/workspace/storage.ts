import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';

import {
  getAiocsWorkspacesDir,
  getAiocsWorkspaceDerivedDir,
  getAiocsWorkspaceManifestsDir,
  getAiocsWorkspaceOutputsDir,
  getAiocsWorkspaceRawDir,
  getAiocsWorkspaceRootDir,
} from '../runtime/paths.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';

type WorkspaceDirectoryLayout = {
  workspaceRoot: string;
  rawDir: string;
  derivedDir: string;
  outputsDir: string;
  manifestsDir: string;
};

function validateWorkspaceRelativePath(inputPath: string): string {
  const normalizedPath = normalize(inputPath).replace(/\\/g, '/');
  if (
    normalizedPath.length === 0
    || normalizedPath === '.'
    || normalizedPath.startsWith('../')
    || normalizedPath.includes('/../')
  ) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Invalid workspace-relative path: ${inputPath}`,
    );
  }

  return normalizedPath;
}

function resolveWorkspaceArtifactAbsolutePath(
  dataDir: string,
  workspaceId: string,
  relativePath: string,
): string {
  const workspaceRoot = getAiocsWorkspaceRootDir(workspaceId, {
    ...process.env,
    AIOCS_DATA_DIR: dataDir,
  });
  const normalizedRelativePath = validateWorkspaceRelativePath(relativePath);
  const absolutePath = resolve(workspaceRoot, normalizedRelativePath);
  const workspaceRelativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, '/');

  if (
    workspaceRelativePath.length === 0
    || workspaceRelativePath.startsWith('../')
    || workspaceRelativePath.includes('/../')
  ) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Invalid workspace-relative path: ${relativePath}`,
    );
  }

  return absolutePath;
}

export function ensureWorkspaceDirectories(input: {
  dataDir: string;
  workspaceId: string;
}): WorkspaceDirectoryLayout {
  const env = {
    ...process.env,
    AIOCS_DATA_DIR: input.dataDir,
  };

  getAiocsWorkspacesDir(env);

  return {
    workspaceRoot: getAiocsWorkspaceRootDir(input.workspaceId, env),
    rawDir: getAiocsWorkspaceRawDir(input.workspaceId, env),
    derivedDir: getAiocsWorkspaceDerivedDir(input.workspaceId, env),
    outputsDir: getAiocsWorkspaceOutputsDir(input.workspaceId, env),
    manifestsDir: getAiocsWorkspaceManifestsDir(input.workspaceId, env),
  };
}

export async function writeWorkspaceArtifact(input: {
  dataDir: string;
  workspaceId: string;
  path: string;
  content: string;
}): Promise<{ path: string; absolutePath: string }> {
  ensureWorkspaceDirectories(input);
  const absolutePath = resolveWorkspaceArtifactAbsolutePath(
    input.dataDir,
    input.workspaceId,
    input.path,
  );
  await mkdir(join(absolutePath, '..'), { recursive: true });
  await writeFile(absolutePath, input.content, 'utf8');
  return {
    path: validateWorkspaceRelativePath(input.path),
    absolutePath,
  };
}

export async function readWorkspaceArtifact(input: {
  dataDir: string;
  workspaceId: string;
  path: string;
}): Promise<{ path: string; absolutePath: string; content: string }> {
  const absolutePath = resolveWorkspaceArtifactAbsolutePath(
    input.dataDir,
    input.workspaceId,
    input.path,
  );

  return {
    path: validateWorkspaceRelativePath(input.path),
    absolutePath,
    content: await readFile(absolutePath, 'utf8'),
  };
}

export async function deleteWorkspaceArtifact(input: {
  dataDir: string;
  workspaceId: string;
  path: string;
}): Promise<void> {
  const absolutePath = resolveWorkspaceArtifactAbsolutePath(
    input.dataDir,
    input.workspaceId,
    input.path,
  );
  await rm(absolutePath, { force: true });
}

export async function writeWorkspaceManifest(input: {
  dataDir: string;
  workspaceId: string;
  fileName: string;
  data: unknown;
}): Promise<{ fileName: string; absolutePath: string }> {
  const layout = ensureWorkspaceDirectories(input);
  const normalizedFileName = validateWorkspaceRelativePath(input.fileName);
  const absolutePath = join(layout.manifestsDir, normalizedFileName);
  const manifestRelative = relative(layout.workspaceRoot, absolutePath).replace(/\\/g, '/');
  validateWorkspaceRelativePath(manifestRelative);
  await mkdir(join(absolutePath, '..'), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(input.data, null, 2), 'utf8');
  return {
    fileName: normalizedFileName,
    absolutePath,
  };
}

export async function deleteWorkspaceManifest(input: {
  dataDir: string;
  workspaceId: string;
  fileName: string;
}): Promise<void> {
  const layout = ensureWorkspaceDirectories(input);
  const normalizedFileName = validateWorkspaceRelativePath(input.fileName);
  await rm(join(layout.manifestsDir, normalizedFileName), { force: true });
}
