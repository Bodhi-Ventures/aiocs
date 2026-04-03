import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { parseSourceSpecObject, type SourceSpec } from '../../src/spec/source-spec.js';

describe('Catalog search flow', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-catalog-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('searches latest successful snapshot for the linked project and ignores failed runs', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      kind: 'web',
      id: 'hyperliquid',
      label: 'Hyperliquid Docs',
      startUrls: ['https://example.com/docs'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 50,
      },
      extract: {
        strategy: 'selector',
        selector: 'article',
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    };

    catalog.upsertSource(spec);
    catalog.linkProject('/workspace/trader', ['hyperliquid']);

    const success = catalog.recordSuccessfulSnapshot({
      sourceId: 'hyperliquid',
      detectedVersion: '2026.03',
      pages: [
        {
          url: 'https://example.com/docs/orders',
          title: 'Orders',
          markdown: '# Orders\n\nUse post-only orders for maker flow.',
        },
      ],
    });

    catalog.recordFailedFetchRun({
      sourceId: 'hyperliquid',
      errorMessage: 'timed out',
    });

    const search = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader/apps/mm',
    });

    expect(search.total).toBe(1);
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.chunkId).toBeDefined();
    expect(search.results[0]?.sourceId).toBe('hyperliquid');
    expect(search.results[0]?.snapshotId).toBe(success.snapshotId);

    const chunk = catalog.getChunkById(search.results[0]!.chunkId);
    expect(chunk?.markdown).toContain('maker flow');
  });

  it('supports paginated search with total counts', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      kind: 'web',
      id: 'lighter',
      label: 'Lighter Docs',
      startUrls: ['https://example.com/docs'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 50,
      },
      extract: {
        strategy: 'selector',
        selector: 'article',
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    };

    catalog.upsertSource(spec);
    catalog.linkProject('/workspace/trader', ['lighter']);
    catalog.recordSuccessfulSnapshot({
      sourceId: 'lighter',
      pages: [
        {
          url: 'https://example.com/docs/one',
          title: 'Orders One',
          markdown: '# Orders One\n\nMaker flow alpha.',
        },
        {
          url: 'https://example.com/docs/two',
          title: 'Orders Two',
          markdown: '# Orders Two\n\nMaker flow beta.',
        },
        {
          url: 'https://example.com/docs/three',
          title: 'Orders Three',
          markdown: '# Orders Three\n\nMaker flow gamma.',
        },
      ],
    });

    const firstPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 0,
    });
    const secondPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 1,
    });
    const repeatedFirstPage = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      limit: 1,
      offset: 0,
    });

    expect(firstPage.total).toBe(3);
    expect(firstPage.limit).toBe(1);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.results).toHaveLength(1);

    expect(secondPage.total).toBe(3);
    expect(secondPage.limit).toBe(1);
    expect(secondPage.offset).toBe(1);
    expect(secondPage.results).toHaveLength(1);
    expect(secondPage.results[0]?.chunkId).not.toBe(firstPage.results[0]?.chunkId);
    expect(repeatedFirstPage.results[0]?.chunkId).toBe(firstPage.results[0]?.chunkId);
  });

  it('supports path and language filters for git-backed file search', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      kind: 'git',
      id: 'repo-reference',
      label: 'Repo Reference',
      repo: {
        url: 'https://github.com/example/repo.git',
        ref: 'main',
        include: ['README.md', 'src/**'],
        exclude: [],
        maxFiles: 50,
        textFileMaxBytes: 65_536,
      },
      schedule: {
        everyHours: 24,
      },
    });

    catalog.upsertSource(spec);
    catalog.linkProject('/workspace/trader', ['repo-reference']);
    catalog.recordSuccessfulSnapshot({
      sourceId: 'repo-reference',
      detectedVersion: 'commit-one',
      revisionKey: 'commit-one',
      pages: [
        {
          url: 'https://github.com/example/repo/blob/main/src/client.ts',
          title: 'src/client.ts',
          markdown: 'export function submitOrder() {\n  return "maker flow";\n}\n',
          pageKind: 'file',
          filePath: 'src/client.ts',
          language: 'typescript',
        },
        {
          url: 'https://github.com/example/repo/blob/main/README.md',
          title: 'README.md',
          markdown: '# Repo\n\nMaker flow overview.\n',
          pageKind: 'file',
          filePath: 'README.md',
          language: 'markdown',
        },
      ],
    });

    const pathFiltered = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      pathPatterns: ['src/**'],
    });
    const languageFiltered = catalog.search({
      query: 'maker flow',
      cwd: '/workspace/trader',
      languages: ['markdown'],
    });

    expect(pathFiltered.results).toHaveLength(1);
    expect(pathFiltered.results[0]?.filePath).toBe('src/client.ts');
    expect(languageFiltered.results).toHaveLength(1);
    expect(languageFiltered.results[0]?.filePath).toBe('README.md');
  });

  it('defaults legacy stored source specs without kind to web in source listing', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec: SourceSpec = {
      kind: 'web',
      id: 'legacy-web',
      label: 'Legacy Web Docs',
      startUrls: ['https://example.com/docs'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/docs/**'],
        exclude: [],
        maxPages: 10,
      },
      extract: {
        strategy: 'selector',
        selector: 'article',
      },
      normalize: {
        prependSourceComment: true,
      },
      schedule: {
        everyHours: 24,
      },
    };

    catalog.upsertSource(spec);
    catalog.close();

    const db = new Database(join(root, 'catalog.sqlite'));
    db.prepare('UPDATE sources SET spec_json = ? WHERE id = ?').run(JSON.stringify({
      id: spec.id,
      label: spec.label,
      startUrls: spec.startUrls,
      allowedHosts: spec.allowedHosts,
      discovery: spec.discovery,
      extract: spec.extract,
      normalize: spec.normalize,
      schedule: spec.schedule,
    }), spec.id);
    db.close();

    const reopened = openCatalog({ dataDir: root });
    const sources = reopened.listSources();

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-web',
        kind: 'web',
      }),
    ]));

    reopened.close();
  });
});
