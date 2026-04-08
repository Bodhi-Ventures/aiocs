import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../../src/errors.js';
import type { SourceSpec } from '../../src/spec/source-spec.js';

describe('Catalog awareness and learning flow', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-awareness-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stores source context, lists pages, reads full pages, and persists routing learnings', () => {
    const catalog = openCatalog({ dataDir: root });
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
          markdown: '# Introduction\n\nBulk exchange overview.',
        },
        {
          url: 'https://example.com/docs/api/authentication',
          title: 'Authentication',
          markdown: '# Authentication\n\nAPI keys are required for authenticated trading.',
        },
      ],
    });

    const context = catalog.upsertSourceContext('bulk-trade', {
      purpose: 'Bulk Trade API and trading documentation',
      summary: 'REST and trading auth reference for Bulk Trade.',
      topicHints: ['authentication', 'trading api'],
      commonLocations: [
        {
          label: 'Auth docs',
          url: 'https://example.com/docs/api/authentication',
          note: 'Start here for API key setup.',
        },
      ],
      gotchas: ['Authenticated endpoints require API keys.'],
      authNotes: ['Use the API authentication page first for auth questions.'],
    });

    expect(context.context.summary).toContain('Bulk Trade');

    const pageListing = catalog.listPages({
      sourceId: 'bulk-trade',
      query: 'auth',
    });
    expect(pageListing.total).toBe(1);
    expect(pageListing.pages[0]).toMatchObject({
      title: 'Authentication',
      url: 'https://example.com/docs/api/authentication',
    });

    const page = catalog.getPage({
      sourceId: 'bulk-trade',
      url: 'https://example.com/docs/api/authentication',
    });
    expect(page.snapshotId).toBe(snapshot.snapshotId);
    expect(page.page.markdown).toContain('API keys are required');

    const discovery = catalog.upsertRoutingLearning({
      sourceId: 'bulk-trade',
      snapshotId: snapshot.snapshotId,
      learningType: 'discovery',
      intent: 'how do i authenticate with the bulk api',
      pageUrl: 'https://example.com/docs/api/authentication',
      title: 'Authentication',
      note: 'Use this page first for API auth questions.',
      searchTerms: ['bulk api auth', 'api keys'],
    });
    const negative = catalog.upsertRoutingLearning({
      sourceId: 'bulk-trade',
      snapshotId: snapshot.snapshotId,
      learningType: 'negative',
      intent: 'how do i authenticate with the bulk api',
      pageUrl: 'https://example.com/docs/introduction',
      title: 'Introduction',
      note: 'Overview page does not contain auth setup.',
      searchTerms: ['bulk overview'],
    });

    const learnings = catalog.listRoutingLearnings({
      sourceId: 'bulk-trade',
      intentQuery: 'authenticate',
    });

    expect(learnings).toHaveLength(2);
    expect(learnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        learningId: negative.learningId,
        learningType: 'negative',
      }),
      expect.objectContaining({
        learningId: discovery.learningId,
        learningType: 'discovery',
        pageUrl: 'https://example.com/docs/api/authentication',
      }),
    ]));

    catalog.close();
  });

  it('validates implicit learning targets against the latest snapshot without pinning snapshotId', () => {
    const catalog = openCatalog({ dataDir: root });
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
    catalog.recordSuccessfulSnapshot({
      sourceId: 'bulk-trade',
      pages: [
        {
          url: 'https://example.com/docs/api/authentication',
          title: 'Authentication',
          markdown: '# Authentication\n\nAPI keys are required for authenticated trading.',
        },
      ],
    });

    const learning = catalog.upsertRoutingLearning({
      sourceId: 'bulk-trade',
      learningType: 'discovery',
      intent: 'where is auth documented',
      pageUrl: 'https://example.com/docs/api/authentication',
    });

    expect(learning.snapshotId).toBeNull();

    catalog.close();
  });

  it('rejects cross-source page lookups and invalid routing learning targets', () => {
    const catalog = openCatalog({ dataDir: root });
    const bulkSpec: SourceSpec = {
      kind: 'web',
      id: 'bulk-trade',
      label: 'Bulk Trade Docs',
      startUrls: ['https://example.com/bulk'],
      allowedHosts: ['example.com'],
      discovery: {
        include: ['https://example.com/bulk/**'],
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
    const decibelSpec: SourceSpec = {
      ...bulkSpec,
      id: 'decibel',
      label: 'Decibel Docs',
      startUrls: ['https://example.com/decibel'],
      discovery: {
        include: ['https://example.com/decibel/**'],
        exclude: [],
        maxPages: 50,
      },
    };

    catalog.upsertSource(bulkSpec);
    catalog.upsertSource(decibelSpec);

    const bulkSnapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'bulk-trade',
      pages: [
        {
          url: 'https://example.com/bulk/auth',
          title: 'Bulk Auth',
          markdown: '# Bulk Auth\n\nAuth page.',
        },
      ],
    });
    const decibelSnapshot = catalog.recordSuccessfulSnapshot({
      sourceId: 'decibel',
      pages: [
        {
          url: 'https://example.com/decibel/overview',
          title: 'Decibel Overview',
          markdown: '# Decibel Overview\n\nOverview page.',
        },
      ],
    });

    expect(() => catalog.getPage({
      sourceId: 'bulk-trade',
      snapshotId: decibelSnapshot.snapshotId,
      url: 'https://example.com/decibel/overview',
    })).toThrowError(expect.objectContaining<Partial<AiocsError>>({
      code: AIOCS_ERROR_CODES.pageNotFound,
    }));

    expect(() => catalog.upsertRoutingLearning({
      sourceId: 'bulk-trade',
      snapshotId: decibelSnapshot.snapshotId,
      learningType: 'discovery',
      intent: 'wrong source snapshot',
      pageUrl: 'https://example.com/decibel/overview',
    })).toThrowError(expect.objectContaining<Partial<AiocsError>>({
      code: AIOCS_ERROR_CODES.snapshotNotFound,
    }));

    expect(() => catalog.upsertRoutingLearning({
      sourceId: 'bulk-trade',
      snapshotId: bulkSnapshot.snapshotId,
      learningType: 'discovery',
      intent: 'missing target page',
      pageUrl: 'https://example.com/bulk/missing',
    })).toThrowError(expect.objectContaining<Partial<AiocsError>>({
      code: AIOCS_ERROR_CODES.pageNotFound,
    }));

    catalog.close();
  });
});
