import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { runDoctor } from '../../src/doctor.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';

describe('doctor freshness reporting', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-doctor-freshness-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports stale sources and stale daemon heartbeat in doctor output', async () => {
    const dataDir = join(root, 'data');
    const configDir = join(root, 'config');
    const catalog = openCatalog({ dataDir });
    const spec = parseSourceSpecObject({
      id: 'doctor-stale',
      label: 'Doctor Stale',
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
      canary: {
        everyHours: 6,
        checks: [
          {
            url: 'https://example.com/docs/start',
            expectedTitle: 'Doctor Stale',
            minMarkdownLength: 10,
          },
        ],
      },
    });

    try {
      catalog.upsertSource(spec);
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Doctor Stale',
            markdown: '# Doctor Stale\n\nOld content.',
          },
        ],
      });
    } finally {
      catalog.close();
    }

    const db = new Database(join(dataDir, 'catalog.sqlite'));
    db.prepare(`
      UPDATE sources
      SET next_due_at = ?, last_checked_at = ?, last_successful_snapshot_at = ?,
          next_canary_due_at = ?, last_canary_checked_at = ?, last_successful_canary_at = ?, last_canary_status = ?
      WHERE id = ?
    `).run(
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      'fail',
      'doctor-stale',
    );
    db.prepare(`
      INSERT OR REPLACE INTO daemon_state (
        singleton_id,
        last_started_at,
        last_cycle_started_at,
        last_cycle_completed_at,
        last_cycle_status,
        interval_minutes,
        fetch_on_start
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      'failed',
      60,
      1,
    );
    db.close();

    const report = await runDoctor({
      ...process.env,
      AIOCS_DATA_DIR: dataDir,
      AIOCS_CONFIG_DIR: configDir,
    });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'freshness',
        status: 'warn',
      }),
      expect.objectContaining({
        id: 'daemon-heartbeat',
        status: 'warn',
      }),
    ]));
  });
});
