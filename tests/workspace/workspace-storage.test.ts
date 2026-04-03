import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureWorkspaceDirectories,
  readWorkspaceArtifact,
  writeWorkspaceArtifact,
  writeWorkspaceManifest,
} from '../../src/workspace/storage.js';

describe('workspace storage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-storage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the workspace directory layout and reads/writes artifacts safely', async () => {
    const directories = ensureWorkspaceDirectories({
      dataDir: root,
      workspaceId: 'market-structure',
    });

    expect(directories.workspaceRoot).toBe(join(root, 'workspaces', 'market-structure'));
    expect(existsSync(directories.rawDir)).toBe(true);
    expect(existsSync(directories.derivedDir)).toBe(true);
    expect(existsSync(directories.outputsDir)).toBe(true);
    expect(existsSync(directories.manifestsDir)).toBe(true);

    const artifact = await writeWorkspaceArtifact({
      dataDir: root,
      workspaceId: 'market-structure',
      path: 'derived/concepts/orders.md',
      content: '# Orders\n\nDerived concept page.',
    });

    expect(artifact.absolutePath).toBe(join(root, 'workspaces', 'market-structure', 'derived', 'concepts', 'orders.md'));
    expect(readFileSync(artifact.absolutePath, 'utf8')).toContain('Derived concept page');
    expect(await readWorkspaceArtifact({
      dataDir: root,
      workspaceId: 'market-structure',
      path: 'derived/concepts/orders.md',
    })).toEqual(
      expect.objectContaining({
        path: 'derived/concepts/orders.md',
        content: '# Orders\n\nDerived concept page.',
      }),
    );
  });

  it('writes workspace manifests and rejects directory traversal paths', async () => {
    const manifest = await writeWorkspaceManifest({
      dataDir: root,
      workspaceId: 'market-structure',
      fileName: 'compile-run.json',
      data: {
        workspaceId: 'market-structure',
        artifactCount: 3,
      },
    });

    expect(manifest.absolutePath).toBe(join(root, 'workspaces', 'market-structure', 'manifests', 'compile-run.json'));
    expect(readFileSync(manifest.absolutePath, 'utf8')).toContain('"artifactCount": 3');

    await expect(writeWorkspaceArtifact({
      dataDir: root,
      workspaceId: 'market-structure',
      path: '../escape.md',
      content: 'nope',
    })).rejects.toThrow(/workspace-relative path/i);
  });
});
