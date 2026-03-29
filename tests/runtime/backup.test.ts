import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportBackup, importBackup } from '../../src/backup.js';
import { openCatalog } from '../../src/catalog/catalog.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';

describe('backup export/import', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-backup-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exports a manifest-backed backup and imports it into a fresh data directory', async () => {
    const sourceDataDir = join(root, 'source-data');
    const exportDir = join(root, 'exported-backup');
    const restoredDataDir = join(root, 'restored-data');
    const catalog = openCatalog({ dataDir: sourceDataDir });
    const spec = parseSourceSpecObject({
      id: 'backup-source',
      label: 'Backup Source',
      startUrls: ['https://example.com/docs/start'],
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
    });

    let exported: Awaited<ReturnType<typeof exportBackup>>;
    try {
      catalog.upsertSource(spec);
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Backup Start',
            markdown: '# Backup Start\n\nSnapshot body for export/import.',
          },
        ],
      });

      exported = await exportBackup({
        dataDir: sourceDataDir,
        outputDir: exportDir,
      });
    } finally {
      catalog.close();
    }

    expect(exported.manifestPath).toBe(join(exportDir, 'manifest.json'));
    expect(existsSync(exported.manifestPath)).toBe(true);
    expect(readFileSync(exported.manifestPath, 'utf8')).toContain('"formatVersion"');

    const imported = await importBackup({
      inputDir: exportDir,
      dataDir: restoredDataDir,
    });

    expect(imported.dataDir).toBe(restoredDataDir);

    const restoredCatalog = openCatalog({ dataDir: restoredDataDir });
    try {
      expect(restoredCatalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'backup-source',
          lastSuccessfulSnapshotId: expect.any(String),
        }),
      ]);
    } finally {
      restoredCatalog.close();
    }
  });

  it('does not delete the live catalog when the backup payload is incomplete', async () => {
    const liveDataDir = join(root, 'live-data');
    const invalidBackupDir = join(root, 'invalid-backup');
    const catalog = openCatalog({ dataDir: liveDataDir });
    const spec = parseSourceSpecObject({
      id: 'live-source',
      label: 'Live Source',
      startUrls: ['https://example.com/docs/start'],
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
    });

    try {
      catalog.upsertSource(spec);
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Live Page',
            markdown: '# Live Page\n\nThis content must survive a bad restore.',
          },
        ],
      });
    } finally {
      catalog.close();
    }

    rmSync(invalidBackupDir, { recursive: true, force: true });
    mkdirSync(invalidBackupDir, { recursive: true });
    mkdirSync(join(invalidBackupDir, 'data'), { recursive: true });
    writeFileSync(
      join(invalidBackupDir, 'manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        packageVersion: '0.1.1',
        entries: [],
      }, null, 2),
      'utf8',
    );

    await expect(importBackup({
      inputDir: invalidBackupDir,
      dataDir: liveDataDir,
      replaceExisting: true,
    })).rejects.toThrow(/missing the catalog database/i);

    const restoredCatalog = openCatalog({ dataDir: liveDataDir });
    try {
      expect(restoredCatalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'live-source',
          lastSuccessfulSnapshotId: expect.any(String),
        }),
      ]);
    } finally {
      restoredCatalog.close();
    }
  });

  it('rejects a backup that omits the data directory entirely', async () => {
    const invalidBackupDir = join(root, 'missing-data-backup');
    mkdirSync(invalidBackupDir, { recursive: true });
    writeFileSync(
      join(invalidBackupDir, 'manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        packageVersion: '0.1.1',
        entries: [],
      }, null, 2),
      'utf8',
    );

    await expect(importBackup({
      inputDir: invalidBackupDir,
      dataDir: join(root, 'restored-data'),
      replaceExisting: true,
    })).rejects.toThrow(/missing the data directory/i);
  });

  it('rejects export when the source data directory has no catalog database', async () => {
    const emptyDataDir = join(root, 'empty-data');
    const exportDir = join(root, 'empty-export');
    mkdirSync(emptyDataDir, { recursive: true });

    await expect(exportBackup({
      dataDir: emptyDataDir,
      outputDir: exportDir,
    })).rejects.toThrow(/missing the catalog database/i);
  });
});
