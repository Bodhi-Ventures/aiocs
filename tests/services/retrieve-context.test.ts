import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { retrieveContext } from '../../src/services.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

describe('retrieveContext', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-retrieve-'));
    previousDataDir = process.env.AIOCS_DATA_DIR;
    previousConfigDir = process.env.AIOCS_CONFIG_DIR;
    process.env.AIOCS_DATA_DIR = join(root, 'data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (typeof previousDataDir === 'string') {
      process.env.AIOCS_DATA_DIR = previousDataDir;
    } else {
      delete process.env.AIOCS_DATA_DIR;
    }

    if (typeof previousConfigDir === 'string') {
      process.env.AIOCS_CONFIG_DIR = previousConfigDir;
    } else {
      delete process.env.AIOCS_CONFIG_DIR;
    }

    rmSync(root, { recursive: true, force: true });
  });

  it('skips stale learning targets instead of failing retrieval', async () => {
    const catalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR! });
    const spec: SourceSpec = {
      kind: 'web',
      id: 'bulk-trade',
      label: 'Bulk Trade Docs',
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
    const snapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'bulk-trade',
      pages: [
        {
          url: 'https://example.com/docs/introduction',
          title: 'Introduction',
          markdown: '# Introduction\n\nMaker flow docs live here.',
        },
      ],
    });
    catalog.close();

    const db = new Database(join(process.env.AIOCS_DATA_DIR!, 'catalog.sqlite'));
    db.prepare(`
      INSERT INTO routing_learnings (
        id,
        route_key,
        source_id,
        snapshot_id,
        learning_type,
        intent,
        page_url,
        file_path,
        title,
        note,
        search_terms_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bad-learning',
      'bad-learning',
      'bulk-trade',
      snapshot.snapshotId,
      'discovery',
      'maker flow',
      'https://example.com/docs/missing',
      null,
      'Missing page',
      'Stale row injected for regression coverage.',
      JSON.stringify(['maker flow']),
      '2026-04-08T00:00:00.000Z',
      '2026-04-08T00:00:00.000Z',
    );
    db.close();

    const result = await retrieveContext('maker flow', {
      source: ['bulk-trade'],
      mode: 'lexical',
      pageLimit: 2,
    });

    expect(result.matchedLearnings).toHaveLength(1);
    expect(result.matchedLearnings[0]).toMatchObject({
      sourceId: 'bulk-trade',
      pageUrl: 'https://example.com/docs/missing',
    });
    expect(result.pages).toEqual([
      expect.objectContaining({
        sourceId: 'bulk-trade',
        url: 'https://example.com/docs/introduction',
        title: 'Introduction',
      }),
    ]);
  });
});
