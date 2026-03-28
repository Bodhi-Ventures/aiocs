import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';

describe('snapshot diffing', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-snapshot-diff-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('diffs the latest snapshot against the previous snapshot for a source', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'diff-source',
      label: 'Diff Source',
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

      const first = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nOriginal page body.',
          },
          {
            url: 'https://example.com/docs/removed',
            title: 'Removed',
            markdown: '# Removed\n\nThis page will disappear.',
          },
        ],
      });

      const second = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nUpdated page body with more detail.',
          },
          {
            url: 'https://example.com/docs/added',
            title: 'Added',
            markdown: '# Added\n\nThis page is new.',
          },
        ],
      });

      const diff = catalog.diffSnapshots({
        sourceId: spec.id,
      });

      expect(diff).toMatchObject({
        sourceId: spec.id,
        fromSnapshotId: first.snapshotId,
        toSnapshotId: second.snapshotId,
        summary: {
          addedPageCount: 1,
          removedPageCount: 1,
          changedPageCount: 1,
          unchangedPageCount: 0,
        },
        addedPages: [
          expect.objectContaining({
            url: 'https://example.com/docs/added',
            title: 'Added',
          }),
        ],
        removedPages: [
          expect.objectContaining({
            url: 'https://example.com/docs/removed',
            title: 'Removed',
          }),
        ],
        changedPages: [
          expect.objectContaining({
            url: 'https://example.com/docs/start',
            beforeTitle: 'Start',
            afterTitle: 'Start',
            lineSummary: expect.objectContaining({
              addedLineCount: expect.any(Number),
              removedLineCount: expect.any(Number),
            }),
          }),
        ],
      });
    } finally {
      catalog.close();
    }
  });

  it('selects the next older snapshot when diffing against an explicit target snapshot', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'diff-target-source',
      label: 'Diff Target Source',
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

      const first = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion one.',
          },
        ],
      });
      const second = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion two.',
          },
        ],
      });
      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion three.',
          },
        ],
      });

      const diff = catalog.diffSnapshots({
        sourceId: spec.id,
        toSnapshotId: second.snapshotId,
      });

      expect(diff.fromSnapshotId).toBe(first.snapshotId);
      expect(diff.toSnapshotId).toBe(second.snapshotId);
    } finally {
      catalog.close();
    }
  });

  it('uses the immediately previous snapshot when diffing against an older target snapshot', () => {
    const catalog = openCatalog({ dataDir: root });
    const spec = parseSourceSpecObject({
      id: 'diff-older-target',
      label: 'Diff Older Target',
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

      const first = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion one.',
          },
        ],
      });

      const second = catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion two.',
          },
        ],
      });

      catalog.recordSuccessfulSnapshot({
        sourceId: spec.id,
        pages: [
          {
            url: 'https://example.com/docs/start',
            title: 'Start',
            markdown: '# Start\n\nVersion three.',
          },
        ],
      });

      const diff = catalog.diffSnapshots({
        sourceId: spec.id,
        toSnapshotId: second.snapshotId,
      });

      expect(diff.fromSnapshotId).toBe(first.snapshotId);
      expect(diff.toSnapshotId).toBe(second.snapshotId);
    } finally {
      catalog.close();
    }
  });
});
