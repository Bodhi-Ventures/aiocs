import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { fetchSource, runSourceCanary } from '../../src/fetch/fetch-source.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';
import { createGitRepoFixture } from '../helpers/git-repo.js';

describe('git source fetch', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-git-fetch-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches a local git repo, reuses the same commit snapshot, and creates a new snapshot after changes', async () => {
    const repo = createGitRepoFixture(join(root, 'repo'));
    const firstCommit = repo.commit({
      'README.md': '# Hyperliquid Client\n\nShared external code reference.\n',
      'src/client.ts': 'export function submitOrder() {\n  return "maker-flow";\n}\n',
      'dist/generated.js': 'ignored();\n',
    }, 'initial');
    const catalog = openCatalog({ dataDir: join(root, 'data') });
    const spec = parseSourceSpecObject({
      kind: 'git',
      id: 'repo-source',
      label: 'Repo Source',
      repo: {
        url: repo.fileUrl,
        ref: 'main',
        include: ['README.md', 'src/**'],
        exclude: ['dist/**'],
        maxFiles: 20,
        textFileMaxBytes: 32_768,
      },
      schedule: {
        everyHours: 24,
      },
    });

    try {
      catalog.upsertSource(spec);

      const first = await fetchSource({
        catalog,
        sourceId: spec.id,
        dataDir: join(root, 'data'),
      });
      expect(first.pageCount).toBe(2);

      const firstSnapshots = catalog.listSnapshots(spec.id);
      expect(firstSnapshots).toHaveLength(1);
      expect(firstSnapshots[0]?.detectedVersion).toBe(firstCommit);

      const firstSearch = catalog.search({
        query: 'maker flow',
        sourceIds: [spec.id],
      });
      expect(firstSearch.results).toHaveLength(1);
      expect(firstSearch.results[0]?.filePath).toBe('src/client.ts');
      expect(firstSearch.results[0]?.language).toBe('typescript');

      const reused = await fetchSource({
        catalog,
        sourceId: spec.id,
        dataDir: join(root, 'data'),
      });
      expect(reused.reused).toBe(true);
      expect(reused.snapshotId).toBe(first.snapshotId);

      const secondCommit = repo.commit({
        'README.md': '# Hyperliquid Client\n\nShared external code reference.\n',
        'src/client.ts': 'export function submitOrder() {\n  return "maker-flow-updated";\n}\n',
        'src/rest.ts': 'export const restEndpoint = "/orders";\n',
      }, 'second');

      const second = await fetchSource({
        catalog,
        sourceId: spec.id,
        dataDir: join(root, 'data'),
      });

      expect(second.reused).toBe(false);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const snapshots = catalog.listSnapshots(spec.id);
      expect(snapshots[0]?.detectedVersion).toBe(secondCommit);
      expect(snapshots).toHaveLength(2);

      const diff = catalog.diffSnapshots({
        sourceId: spec.id,
      });
      expect(diff.addedPages).toEqual([
        expect.objectContaining({
          filePath: 'src/rest.ts',
          pageKind: 'file',
        }),
      ]);
      expect(diff.changedPages).toEqual([
        expect.objectContaining({
          filePath: 'src/client.ts',
          pageKind: 'file',
        }),
      ]);
    } finally {
      catalog.close();
    }
  });

  it('runs git canaries against scoped file paths', async () => {
    const repo = createGitRepoFixture(join(root, 'repo'));
    repo.commit({
      'README.md': '# Repo Title\n\nLocal git source canary target.\n',
      'src/client.ts': 'export function submitOrder() {\n  return "ok";\n}\n',
    }, 'initial');
    const catalog = openCatalog({ dataDir: join(root, 'data') });
    const spec = parseSourceSpecObject({
      kind: 'git',
      id: 'git-canary-source',
      label: 'Git Canary Source',
      repo: {
        url: repo.fileUrl,
        ref: 'main',
        include: ['README.md', 'src/**'],
        exclude: [],
        maxFiles: 20,
        textFileMaxBytes: 32_768,
      },
      schedule: {
        everyHours: 24,
      },
      canary: {
        checks: [
          {
            path: 'README.md',
            expectedText: 'Local git source canary target',
            minContentLength: 20,
          },
        ],
      },
    });

    try {
      catalog.upsertSource(spec);
      const result = await runSourceCanary({
        catalog,
        sourceId: spec.id,
        dataDir: join(root, 'data'),
      });

      expect(result.status).toBe('pass');
      expect(result.checks).toEqual([
        expect.objectContaining({
          path: 'README.md',
          status: 'pass',
        }),
      ]);
    } finally {
      catalog.close();
    }
  });
});
