import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { startDocsServer } from '../helpers/docs-server.js';
import {
  bootstrapSourceSpecs,
  parseDaemonConfig,
  runDaemonCycle,
  startDaemon,
} from '../../src/daemon.js';

function writeSelectorSpec(
  specDir: string,
  baseUrl: string,
  id = 'daemon-selector',
  everyHours = 24,
  startPath = '/selector/start',
): string {
  const specPath = join(specDir, `${id}.yaml`);
  writeSelectorSpecAtPath(specPath, baseUrl, id, everyHours, startPath);
  return specPath;
}

function writeSelectorSpecAtPath(
  specPath: string,
  baseUrl: string,
  id: string,
  everyHours = 24,
  startPath = '/selector/start',
): string {
  writeFileSync(specPath, `
id: ${id}
label: ${id}
startUrls:
  - ${baseUrl}${startPath}
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${baseUrl}${startPath.split('/').slice(0, -1).join('/') || '/'}/**
  exclude: []
  maxPages: 10
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: ${everyHours}
`);
  return specPath;
}

describe('daemon runtime', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-daemon-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses daemon config defaults', () => {
    const config = parseDaemonConfig({}, {
      bundledSourceDir: '/repo/aiocs/sources',
      containerSourceDir: '/app/sources',
    });

    expect(config).toEqual({
      intervalMinutes: 60,
      fetchOnStart: true,
      strictSourceSpecDirs: false,
      sourceSpecDirs: ['/app/sources', '/repo/aiocs/sources'],
    });
  });

  it('rejects an invalid daemon interval', () => {
    expect(() => parseDaemonConfig({
      AIOCS_DAEMON_INTERVAL_MINUTES: '0',
    })).toThrow('AIOCS_DAEMON_INTERVAL_MINUTES must be a positive integer');
  });

  it('parses daemon booleans and source spec dirs', () => {
    const config = parseDaemonConfig({
      AIOCS_DAEMON_FETCH_ON_START: 'false',
      AIOCS_SOURCE_SPEC_DIRS: ' /tmp/one , , /tmp/two ',
    }, {
      bundledSourceDir: '/repo/aiocs/sources',
      containerSourceDir: '/app/sources',
    });

    expect(config.fetchOnStart).toBe(false);
    expect(config.strictSourceSpecDirs).toBe(true);
    expect(config.sourceSpecDirs).toEqual(['/tmp/one', '/tmp/two']);
  });

  it('rejects an explicitly empty source spec dir list', () => {
    expect(() => parseDaemonConfig({
      AIOCS_SOURCE_SPEC_DIRS: ' , , ',
    })).toThrow('AIOCS_SOURCE_SPEC_DIRS must include at least one directory');
  });

  it('bootstraps source specs from directories', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    writeSelectorSpec(specDir, server.baseUrl, 'daemon-bootstrap');

    const catalog = openCatalog({ dataDir });

    try {
      const result = await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      expect(result).toMatchObject({
        processedSpecCount: 1,
        sources: [
          {
            sourceId: 'daemon-bootstrap',
            specPath: join(specDir, 'daemon-bootstrap.yaml'),
          },
        ],
      });
      expect(catalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'daemon-bootstrap',
        }),
      ]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('fails fast when an explicitly configured source spec dir is missing', async () => {
    const dataDir = join(root, 'data');
    const catalog = openCatalog({ dataDir });

    try {
      await expect(bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [join(root, 'missing-specs')],
        strictSourceSpecDirs: true,
      })).rejects.toThrow('Missing source spec directories');
    } finally {
      catalog.close();
    }
  });

  it('runs a daemon cycle and refreshes due sources', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    writeSelectorSpec(specDir, server.baseUrl, 'daemon-refresh');

    const catalog = openCatalog({ dataDir });

    try {
      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      const db = new Database(join(dataDir, 'catalog.sqlite'));
      db.prepare('UPDATE sources SET next_due_at = ? WHERE id = ?').run(
        '2000-01-01T00:00:00.000Z',
        'daemon-refresh',
      );
      db.close();

      const result = await runDaemonCycle({
        catalog,
        dataDir,
        sourceSpecDirs: [specDir],
      });

      expect(result.bootstrapped.processedSpecCount).toBe(1);
      expect(result.refreshed).toEqual([
        expect.objectContaining({
          sourceId: 'daemon-refresh',
          pageCount: 2,
          reused: false,
        }),
      ]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('runs a daemon cycle and skips when nothing is due', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    writeSelectorSpec(specDir, server.baseUrl, 'daemon-idle');

    const catalog = openCatalog({ dataDir });

    try {
      const result = await runDaemonCycle({
        catalog,
        dataDir,
        sourceSpecDirs: [specDir],
      });

      expect(result.bootstrapped.processedSpecCount).toBe(1);
      expect(result.refreshed).toEqual([]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('runs a daemon cycle when a managed source spec changes schedule', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    writeSelectorSpec(specDir, server.baseUrl, 'daemon-schedule-change', 24);

    const catalog = openCatalog({ dataDir });

    try {
      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      writeSelectorSpec(specDir, server.baseUrl, 'daemon-schedule-change', 1);

      const result = await runDaemonCycle({
        catalog,
        dataDir,
        sourceSpecDirs: [specDir],
      });

      expect(result.refreshed).toEqual([
        expect.objectContaining({
          sourceId: 'daemon-schedule-change',
        }),
      ]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('retries transient due-source failures within a single daemon cycle', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    writeSelectorSpec(specDir, server.baseUrl, 'daemon-flaky', 24, '/selector-flaky/start');

    const catalog = openCatalog({ dataDir });

    try {
      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      const db = new Database(join(dataDir, 'catalog.sqlite'));
      db.prepare('UPDATE sources SET next_due_at = ? WHERE id = ?').run(
        '2000-01-01T00:00:00.000Z',
        'daemon-flaky',
      );
      db.close();

      const result = await runDaemonCycle({
        catalog,
        dataDir,
        sourceSpecDirs: [specDir],
      });

      expect(result.refreshed).toEqual([
        expect.objectContaining({
          sourceId: 'daemon-flaky',
          pageCount: 1,
          reused: false,
        }),
      ]);
      expect(result.failed).toEqual([]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('reconciles removed managed source specs out of the catalog', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    const specPath = writeSelectorSpec(specDir, server.baseUrl, 'daemon-removed');

    const catalog = openCatalog({ dataDir });

    try {
      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });
      expect(catalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'daemon-removed',
        }),
      ]);

      unlinkSync(specPath);

      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      expect(catalog.listSources()).toEqual([]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('reconciles managed source id changes for the same spec path', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    const specPath = join(specDir, 'daemon-source.yaml');
    writeSelectorSpecAtPath(specPath, server.baseUrl, 'daemon-old-id');

    const catalog = openCatalog({ dataDir });

    try {
      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });
      expect(catalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'daemon-old-id',
        }),
      ]);

      writeSelectorSpecAtPath(specPath, server.baseUrl, 'daemon-new-id');

      await bootstrapSourceSpecs({
        catalog,
        sourceSpecDirs: [specDir],
      });

      expect(catalog.listSources()).toEqual([
        expect.objectContaining({
          id: 'daemon-new-id',
        }),
      ]);
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('records a degraded daemon heartbeat when startup canaries fail', async () => {
    const server = await startDocsServer();
    const specDir = join(root, 'specs');
    const dataDir = join(root, 'data');
    mkdirSync(specDir, { recursive: true });
    const specPath = join(specDir, 'daemon-canary-fail.yaml');

    writeFileSync(specPath, `
id: daemon-canary-fail
label: daemon-canary-fail
startUrls:
  - ${server.baseUrl}/selector/start
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${server.baseUrl}/selector/**
  exclude: []
  maxPages: 10
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
canary:
  everyHours: 6
  checks:
    - url: ${server.baseUrl}/selector/start
      expectedText: this text does not exist
      minMarkdownLength: 20
`);

    const catalog = openCatalog({ dataDir });
    const events: string[] = [];
    const abortController = new AbortController();

    try {
      await startDaemon({
        catalog,
        dataDir,
        config: {
          intervalMinutes: 60,
          fetchOnStart: true,
          strictSourceSpecDirs: true,
          sourceSpecDirs: [specDir],
        },
        logger: {
          emit(event) {
            events.push(event.type);
            if (event.type === 'daemon.cycle.completed') {
              abortController.abort();
            }
          },
        },
        signal: abortController.signal,
      });

      const daemonState = catalog.getDaemonState();
      expect(events).toContain('daemon.cycle.completed');
      expect(daemonState).toMatchObject({
        lastCycleStatus: 'degraded',
      });
    } finally {
      catalog.close();
      await server.close();
    }
  });

  it('records a failed daemon heartbeat when the cycle crashes before completion', async () => {
    const dataDir = join(root, 'data');
    const catalog = openCatalog({ dataDir });

    await expect(startDaemon({
      catalog,
      dataDir,
      config: {
        intervalMinutes: 60,
        fetchOnStart: true,
        strictSourceSpecDirs: true,
        sourceSpecDirs: [join(root, 'missing-specs')],
      },
      logger: {
        emit() {
          // no-op
        },
      },
    })).rejects.toThrow('Missing source spec directories');

    expect(catalog.getDaemonState()).toMatchObject({
      lastCycleStatus: 'failed',
      lastCycleStartedAt: expect.any(String),
      lastCycleCompletedAt: expect.any(String),
    });

    catalog.close();
  });
});
