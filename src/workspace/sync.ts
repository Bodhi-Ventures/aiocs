import { join, normalize, relative, resolve } from 'node:path';

import type { openCatalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { getWorkspaceObsidianExportSubdir } from './artifacts.js';
import { ensureWorkspaceDirectories, syncWorkspaceTree } from './storage.js';
import { analyzeWorkspaceStatus } from './status.js';

type Catalog = ReturnType<typeof openCatalog>;

function normalizeWorkspaceExportSubdir(input: string): string {
  const normalized = normalize(input).replace(/\\/g, '/');
  if (
    normalized.length === 0
    || normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.startsWith('/')
  ) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Invalid Obsidian export subdirectory: ${input}`,
    );
  }

  return normalized;
}

function pathContains(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath).replace(/\\/g, '/');
  return rel === '' || (!rel.startsWith('../') && !rel.includes('/../'));
}

export async function syncWorkspaceToObsidian(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  vaultPath: string;
  exportSubdir?: string;
}): Promise<{
  workspaceId: string;
  vaultPath: string;
  targetPath: string;
  exportSubdir: string;
}> {
  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const exportSubdir = normalizeWorkspaceExportSubdir(
    input.exportSubdir ?? getWorkspaceObsidianExportSubdir(input.workspaceId),
  );
  const layout = ensureWorkspaceDirectories({
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
  });
  const status = analyzeWorkspaceStatus({
    catalog: input.catalog,
    workspaceId: input.workspaceId,
  });
  if (status.staleArtifactPaths.length > 0 || status.lintSummary.missingArtifactCount > 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceArtifactsStale,
      `Workspace '${input.workspaceId}' has stale or incomplete artifacts. Re-run 'workspace compile' before syncing to Obsidian.`,
      {
        staleArtifactPaths: status.staleArtifactPaths,
        missingArtifactCount: status.lintSummary.missingArtifactCount,
      },
    );
  }

  const resolvedVaultPath = resolve(input.vaultPath);
  const targetPath = resolve(join(resolvedVaultPath, exportSubdir));
  const resolvedWorkspaceRoot = resolve(layout.workspaceRoot);
  const resolvedDataDir = resolve(input.dataDir);
  if (
    pathContains(resolvedWorkspaceRoot, targetPath)
    || pathContains(targetPath, resolvedWorkspaceRoot)
    || pathContains(resolvedDataDir, targetPath)
    || pathContains(targetPath, resolvedDataDir)
  ) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Obsidian export target must not overlap aiocs workspace or data directories: ${targetPath}`,
    );
  }

  await syncWorkspaceTree({
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
    targetRoot: targetPath,
  });

  input.catalog.upsertWorkspaceSyncTarget({
    workspaceId: input.workspaceId,
    kind: 'obsidian',
    targetPath: resolvedVaultPath,
    exportSubdir,
    lastSyncedAt: new Date().toISOString(),
    lastSyncStatus: 'success',
    lastErrorMessage: null,
  });

  return {
    workspaceId: input.workspaceId,
    vaultPath: resolvedVaultPath,
    targetPath,
    exportSubdir,
  };
}
