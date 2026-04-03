import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { AIOCS_ERROR_CODES, AiocsError } from '../../src/errors.js';
import { syncWorkspaceToObsidian } from '../../src/workspace/sync.js';
import {
  deleteWorkspaceArtifact,
  ensureWorkspaceDirectories,
  writeWorkspaceArtifact,
} from '../../src/workspace/storage.js';

describe('workspace obsidian sync', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-sync-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('mirrors the workspace tree so deleted files are pruned on sync', async () => {
    const dataDir = join(root, 'data');
    const vaultDir = join(root, 'vault');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.createWorkspace({
        id: 'research-desk',
        label: 'Research Desk',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
      });

      ensureWorkspaceDirectories({
        dataDir,
        workspaceId: 'research-desk',
      });
      await writeWorkspaceArtifact({
        dataDir,
        workspaceId: 'research-desk',
        path: 'derived/index.md',
        content: '# Research Desk\n\nInitial index.',
      });
      await writeWorkspaceArtifact({
        dataDir,
        workspaceId: 'research-desk',
        path: 'outputs/reports/brief.md',
        content: '# Brief\n\nInitial report.',
      });

      await syncWorkspaceToObsidian({
        catalog,
        dataDir,
        workspaceId: 'research-desk',
        vaultPath: vaultDir,
      });

      const syncedRoot = join(vaultDir, 'aiocs', 'research-desk');
      const syncedReportPath = join(syncedRoot, 'outputs', 'reports', 'brief.md');
      expect(readFileSync(syncedReportPath, 'utf8')).toContain('Initial report.');

      await deleteWorkspaceArtifact({
        dataDir,
        workspaceId: 'research-desk',
        path: 'outputs/reports/brief.md',
      });
      await writeWorkspaceArtifact({
        dataDir,
        workspaceId: 'research-desk',
        path: 'outputs/reports/fresh.md',
        content: '# Fresh\n\nUpdated report.',
      });

      await syncWorkspaceToObsidian({
        catalog,
        dataDir,
        workspaceId: 'research-desk',
        vaultPath: vaultDir,
      });

      expect(existsSync(syncedReportPath)).toBe(false);
      expect(readFileSync(join(syncedRoot, 'outputs', 'reports', 'fresh.md'), 'utf8')).toContain('Updated report.');
    } finally {
      catalog.close();
    }
  });

  it('rejects unsafe export subdirectories', async () => {
    const dataDir = join(root, 'data');
    const vaultDir = join(root, 'vault');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.createWorkspace({
        id: 'unsafe-export',
        label: 'Unsafe Export',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
      });

      await expect(syncWorkspaceToObsidian({
        catalog,
        dataDir,
        workspaceId: 'unsafe-export',
        vaultPath: vaultDir,
        exportSubdir: '.',
      })).rejects.toThrow('Invalid Obsidian export subdirectory');
    } finally {
      catalog.close();
    }
  });

  it('rejects export targets that overlap aiocs workspace storage', async () => {
    const dataDir = join(root, 'data');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.createWorkspace({
        id: 'overlap-export',
        label: 'Overlap Export',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
      });

      await expect(syncWorkspaceToObsidian({
        catalog,
        dataDir,
        workspaceId: 'overlap-export',
        vaultPath: join(dataDir, 'workspaces'),
        exportSubdir: 'overlap-export',
      })).rejects.toThrow('must not overlap aiocs workspace or data directories');
    } finally {
      catalog.close();
    }
  });

  it('fails closed when stale workspace artifacts would be synced', async () => {
    const dataDir = join(root, 'data');
    const vaultDir = join(root, 'vault');
    const catalog = openCatalog({ dataDir });

    try {
      catalog.createWorkspace({
        id: 'stale-sync',
        label: 'Stale Sync',
        compilerProfile: {
          provider: 'lmstudio',
          model: 'google/gemma-4-26b-a4b',
          temperature: 0.1,
          topP: 0.9,
          maxInputChars: 12_000,
          maxOutputTokens: 4_096,
          concurrency: 1,
        },
        defaultOutputFormats: ['report'],
      });

      ensureWorkspaceDirectories({
        dataDir,
        workspaceId: 'stale-sync',
      });
      await writeWorkspaceArtifact({
        dataDir,
        workspaceId: 'stale-sync',
        path: 'derived/index.md',
        content: '# Stale index\n\nNeeds recompilation.',
      });
      catalog.upsertWorkspaceArtifact({
        workspaceId: 'stale-sync',
        path: 'derived/index.md',
        kind: 'index',
        contentHash: 'hash-stale-index',
        compilerMetadata: { provider: 'lmstudio' },
        stale: true,
        chunks: [
          {
            sectionTitle: 'index',
            markdown: '# Stale index\n\nNeeds recompilation.',
          },
        ],
        provenance: [],
      });

      await expect(syncWorkspaceToObsidian({
        catalog,
        dataDir,
        workspaceId: 'stale-sync',
        vaultPath: vaultDir,
      })).rejects.toThrowError(
        expect.objectContaining<Partial<AiocsError>>({
          code: AIOCS_ERROR_CODES.workspaceArtifactsStale,
        }),
      );
    } finally {
      catalog.close();
    }
  });
});
