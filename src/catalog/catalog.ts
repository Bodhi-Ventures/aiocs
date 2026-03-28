import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { chunkMarkdown } from './chunking.js';
import { buildSnapshotFingerprint, sha256 } from './fingerprint.js';
import { canonicalizeProjectPath, resolveProjectScope } from './project-scope.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { resolveSourceCanary, type SourceSpec } from '../spec/source-spec.js';

type OpenCatalogOptions = {
  dataDir: string;
};

type SuccessfulPageInput = {
  url: string;
  title: string;
  markdown: string;
};

type RecordSuccessfulSnapshotInput = {
  sourceId: string;
  detectedVersion?: string;
  pages: SuccessfulPageInput[];
};

type SearchInput = {
  query: string;
  cwd?: string;
  sourceIds?: string[];
  snapshotId?: string;
  all?: boolean;
  limit?: number;
  offset?: number;
};

type SearchRow = {
  chunkId: number;
  sourceId: string;
  snapshotId: string;
  pageUrl: string;
  pageTitle: string;
  sectionTitle: string;
  markdown: string;
};

type ChunkRecord = SearchRow;

type ProjectLinkRow = {
  project_path: string;
  source_id: string;
};

type SnapshotPageRow = {
  url: string;
  title: string;
  markdown: string;
  content_hash: string;
};

type DaemonStateRow = {
  last_started_at: string | null;
  last_cycle_started_at: string | null;
  last_cycle_completed_at: string | null;
  last_cycle_status: string | null;
  interval_minutes: number | null;
  fetch_on_start: number | null;
};

function initSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      spec_path TEXT,
      config_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_successful_snapshot_at TEXT,
      last_successful_snapshot_id TEXT,
      last_canary_checked_at TEXT,
      last_successful_canary_at TEXT,
      last_canary_status TEXT,
      next_canary_due_at TEXT,
      next_due_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      detected_version TEXT,
      page_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_id, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(snapshot_id, url)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      page_title TEXT NOT NULL,
      section_title TEXT NOT NULL,
      chunk_order INTEGER NOT NULL,
      markdown TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      page_title,
      section_title,
      markdown,
      content=chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, page_title, section_title, markdown)
      VALUES (new.id, new.page_title, new.section_title, new.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, page_title, section_title, markdown)
      VALUES ('delete', old.id, old.page_title, old.section_title, old.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, page_title, section_title, markdown)
      VALUES ('delete', old.id, old.page_title, old.section_title, old.markdown);
      INSERT INTO chunks_fts(rowid, page_title, section_title, markdown)
      VALUES (new.id, new.page_title, new.section_title, new.markdown);
    END;

    CREATE TABLE IF NOT EXISTS fetch_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
      error_message TEXT,
      snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canary_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
      checked_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_links (
      project_path TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_path, source_id)
    );

    CREATE TABLE IF NOT EXISTS daemon_state (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      last_started_at TEXT,
      last_cycle_started_at TEXT,
      last_cycle_completed_at TEXT,
      last_cycle_status TEXT,
      interval_minutes INTEGER,
      fetch_on_start INTEGER
    );
  `);

  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>;
  if (!sourceColumns.some((column) => column.name === 'spec_path')) {
    db.exec('ALTER TABLE sources ADD COLUMN spec_path TEXT');
  }
  if (!sourceColumns.some((column) => column.name === 'last_successful_snapshot_at')) {
    db.exec('ALTER TABLE sources ADD COLUMN last_successful_snapshot_at TEXT');
  }
  if (!sourceColumns.some((column) => column.name === 'last_canary_checked_at')) {
    db.exec('ALTER TABLE sources ADD COLUMN last_canary_checked_at TEXT');
  }
  if (!sourceColumns.some((column) => column.name === 'last_successful_canary_at')) {
    db.exec('ALTER TABLE sources ADD COLUMN last_successful_canary_at TEXT');
  }
  if (!sourceColumns.some((column) => column.name === 'last_canary_status')) {
    db.exec('ALTER TABLE sources ADD COLUMN last_canary_status TEXT');
  }
  if (!sourceColumns.some((column) => column.name === 'next_canary_due_at')) {
    db.exec('ALTER TABLE sources ADD COLUMN next_canary_due_at TEXT');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function addHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeQuery(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return words.join(' ');
}

function assertPaginationValue(
  value: number | undefined,
  field: 'limit' | 'offset',
  fallback: number,
): number {
  if (typeof value === 'undefined') {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `${field} must be a non-negative integer`,
    );
  }

  if (field === 'limit' && value === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      'limit must be greater than zero',
    );
  }

  return value;
}

export function openCatalog(options: OpenCatalogOptions) {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(join(dataDir, 'catalog.sqlite'));
  initSchema(db);

  const listProjectLinks = (): Array<{ projectPath: string; sourceIds: string[] }> => {
    const rows = db.prepare('SELECT project_path, source_id FROM project_links ORDER BY project_path, source_id').all() as ProjectLinkRow[];
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const current = grouped.get(row.project_path) ?? [];
      current.push(row.source_id);
      grouped.set(row.project_path, current);
    }

    return [...grouped.entries()].map(([projectPath, sourceIds]) => ({ projectPath, sourceIds }));
  };

  return {
    close(): void {
      db.close();
    },

    upsertSource(
      spec: SourceSpec,
      options?: { specPath?: string },
    ): { sourceId: string; configHash: string; configChanged: boolean } {
      const timestamp = nowIso();
      const configHash = sha256(stableStringify(spec));
      const existing = db
        .prepare('SELECT id, created_at, next_due_at, next_canary_due_at, config_hash FROM sources WHERE id = ?')
        .get(spec.id) as {
          id: string;
          created_at: string;
          next_due_at: string;
          next_canary_due_at: string | null;
          config_hash: string;
        } | undefined;
      const resolvedSpecPath = options?.specPath ? resolve(options.specPath) : null;
      const nextDueAt = !existing
        ? addHoursIso(spec.schedule.everyHours)
        : existing.config_hash === configHash
          ? existing.next_due_at
          : timestamp;
      const canaryConfig = resolveSourceCanary(spec);
      const nextCanaryDueAt = !existing
        ? timestamp
        : existing.config_hash === configHash
          ? (existing.next_canary_due_at ?? addHoursIso(canaryConfig.everyHours))
          : timestamp;
      const configChanged = Boolean(existing && existing.config_hash !== configHash);

      db.prepare(`
        INSERT INTO sources (
          id, label, spec_json, spec_path, config_hash, created_at, updated_at, next_due_at, next_canary_due_at
        ) VALUES (
          @id, @label, @specJson, @specPath, @configHash, @createdAt, @updatedAt, @nextDueAt, @nextCanaryDueAt
        )
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          spec_json = excluded.spec_json,
          spec_path = excluded.spec_path,
          config_hash = excluded.config_hash,
          updated_at = excluded.updated_at,
          next_due_at = excluded.next_due_at,
          next_canary_due_at = excluded.next_canary_due_at
      `).run({
        id: spec.id,
        label: spec.label,
        specJson: JSON.stringify(spec),
        specPath: resolvedSpecPath,
        configHash,
        createdAt: existing?.created_at ?? timestamp,
        updatedAt: timestamp,
        nextDueAt,
        nextCanaryDueAt,
      });

      return {
        sourceId: spec.id,
        configHash,
        configChanged,
      };
    },

    getSourceSpec(sourceId: string): SourceSpec | null {
      const row = db
        .prepare('SELECT spec_json FROM sources WHERE id = ?')
        .get(sourceId) as { spec_json: string } | undefined;

      if (!row) {
        return null;
      }

      return JSON.parse(row.spec_json) as SourceSpec;
    },

    listSources(): Array<{
      id: string;
      label: string;
      nextDueAt: string;
      nextCanaryDueAt: string | null;
      lastCheckedAt: string | null;
      lastSuccessfulSnapshotAt: string | null;
      lastSuccessfulSnapshotId: string | null;
      lastCanaryCheckedAt: string | null;
      lastSuccessfulCanaryAt: string | null;
      lastCanaryStatus: 'pass' | 'fail' | null;
    }> {
      const rows = db.prepare(`
        SELECT
          id,
          label,
          next_due_at,
          next_canary_due_at,
          last_checked_at,
          last_successful_snapshot_at,
          last_successful_snapshot_id,
          last_canary_checked_at,
          last_successful_canary_at,
          last_canary_status
        FROM sources
        ORDER BY id
      `).all() as Array<{
        id: string;
        label: string;
        next_due_at: string;
        next_canary_due_at: string | null;
        last_checked_at: string | null;
        last_successful_snapshot_at: string | null;
        last_successful_snapshot_id: string | null;
        last_canary_checked_at: string | null;
        last_successful_canary_at: string | null;
        last_canary_status: 'pass' | 'fail' | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        nextDueAt: row.next_due_at,
        nextCanaryDueAt: row.next_canary_due_at,
        lastCheckedAt: row.last_checked_at,
        lastSuccessfulSnapshotAt: row.last_successful_snapshot_at,
        lastSuccessfulSnapshotId: row.last_successful_snapshot_id,
        lastCanaryCheckedAt: row.last_canary_checked_at,
        lastSuccessfulCanaryAt: row.last_successful_canary_at,
        lastCanaryStatus: row.last_canary_status,
      }));
    },

    listDueSourceIds(referenceTime = nowIso()): string[] {
      const rows = db.prepare(`
        SELECT id
        FROM sources
        WHERE next_due_at <= ?
        ORDER BY next_due_at, id
      `).all(referenceTime) as Array<{ id: string }>;

      return rows.map((row) => row.id);
    },

    listCanaryDueSourceIds(referenceTime = nowIso()): string[] {
      const rows = db.prepare(`
        SELECT id
        FROM sources
        WHERE next_canary_due_at IS NOT NULL
          AND next_canary_due_at <= ?
        ORDER BY next_canary_due_at, id
      `).all(referenceTime) as Array<{ id: string }>;

      return rows.map((row) => row.id);
    },

    linkProject(projectPath: string, sourceIds: string[]): void {
      const normalizedPath = canonicalizeProjectPath(projectPath);
      const timestamp = nowIso();
      const insert = db.prepare(`
        INSERT INTO project_links (project_path, source_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_path, source_id) DO NOTHING
      `);

      const transaction = db.transaction((ids: string[]) => {
        for (const sourceId of ids) {
          insert.run(normalizedPath, sourceId, timestamp);
        }
      });

      transaction(sourceIds);
    },

    unlinkProject(projectPath: string, sourceIds?: string[]): void {
      const normalizedPath = canonicalizeProjectPath(projectPath);
      if (!sourceIds || sourceIds.length === 0) {
        db.prepare('DELETE FROM project_links WHERE project_path = ?').run(normalizedPath);
        return;
      }

      const statement = db.prepare('DELETE FROM project_links WHERE project_path = ? AND source_id = ?');
      const transaction = db.transaction((ids: string[]) => {
        for (const sourceId of ids) {
          statement.run(normalizedPath, sourceId);
        }
      });
      transaction(sourceIds);
    },

    recordSuccessfulSnapshot(input: RecordSuccessfulSnapshotInput): { snapshotId: string; reused: boolean } {
      const sourceRow = db
        .prepare('SELECT config_hash, spec_json FROM sources WHERE id = ?')
        .get(input.sourceId) as { config_hash: string; spec_json: string } | undefined;

      if (!sourceRow) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.sourceNotFound,
          `Unknown source '${input.sourceId}'`,
        );
      }

      const pagesWithHashes = input.pages.map((page) => ({
        ...page,
        markdown: page.markdown.trim(),
        contentHash: sha256(page.markdown.trim()),
      }));

      const fingerprint = buildSnapshotFingerprint({
        sourceId: input.sourceId,
        configHash: sourceRow.config_hash,
        pages: pagesWithHashes.map((page) => ({
          url: page.url,
          contentHash: page.contentHash,
        })),
      });

      const existing = db
        .prepare('SELECT id FROM snapshots WHERE source_id = ? AND fingerprint = ?')
        .get(input.sourceId, fingerprint) as { id: string } | undefined;

      const spec = JSON.parse(sourceRow.spec_json) as SourceSpec;
      const checkedAt = nowIso();
      const nextDueAt = addHoursIso(spec.schedule.everyHours);

      if (existing) {
        db.prepare(`
          UPDATE sources
          SET last_checked_at = ?, last_successful_snapshot_at = ?, last_successful_snapshot_id = ?, next_due_at = ?, updated_at = ?
          WHERE id = ?
        `).run(checkedAt, checkedAt, existing.id, nextDueAt, checkedAt, input.sourceId);

        db.prepare(`
          INSERT INTO fetch_runs (id, source_id, status, snapshot_id, started_at, finished_at)
          VALUES (?, ?, 'success', ?, ?, ?)
        `).run(randomUUID(), input.sourceId, existing.id, checkedAt, checkedAt);

        return {
          snapshotId: existing.id,
          reused: true,
        };
      }

      const snapshotId = `snp_${checkedAt.replace(/[-:.TZ]/g, '')}_${fingerprint.slice(0, 12)}`;
      const insertSnapshot = db.prepare(`
        INSERT INTO snapshots (
          id, source_id, fingerprint, config_hash, detected_version, page_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertPage = db.prepare(`
        INSERT INTO pages (snapshot_id, url, title, markdown, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (
          source_id, snapshot_id, page_id, page_url, page_title, section_title, chunk_order, markdown
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRun = db.prepare(`
        INSERT INTO fetch_runs (id, source_id, status, snapshot_id, started_at, finished_at)
        VALUES (?, ?, 'success', ?, ?, ?)
      `);

      const transaction = db.transaction(() => {
        insertSnapshot.run(
          snapshotId,
          input.sourceId,
          fingerprint,
          sourceRow.config_hash,
          input.detectedVersion ?? null,
          pagesWithHashes.length,
          checkedAt,
        );

        for (const page of pagesWithHashes) {
          const pageInsert = insertPage.run(snapshotId, page.url, page.title, page.markdown, page.contentHash);
          const pageId = Number(pageInsert.lastInsertRowid);
          const chunks = chunkMarkdown(page.title, page.markdown);
          for (const chunk of chunks) {
            insertChunk.run(
              input.sourceId,
              snapshotId,
              pageId,
              page.url,
              page.title,
              chunk.sectionTitle,
              chunk.chunkOrder,
              chunk.markdown,
            );
          }
        }

        db.prepare(`
          UPDATE sources
          SET last_checked_at = ?, last_successful_snapshot_at = ?, last_successful_snapshot_id = ?, next_due_at = ?, updated_at = ?
          WHERE id = ?
        `).run(checkedAt, checkedAt, snapshotId, nextDueAt, checkedAt, input.sourceId);

        insertRun.run(randomUUID(), input.sourceId, snapshotId, checkedAt, checkedAt);
      });

      transaction();

      return {
        snapshotId,
        reused: false,
      };
    },

    recordFailedFetchRun(input: { sourceId: string; errorMessage: string }): void {
      const sourceRow = db
        .prepare('SELECT spec_json FROM sources WHERE id = ?')
        .get(input.sourceId) as { spec_json: string } | undefined;

      if (!sourceRow) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.sourceNotFound,
          `Unknown source '${input.sourceId}'`,
        );
      }

      const spec = JSON.parse(sourceRow.spec_json) as SourceSpec;
      const timestamp = nowIso();

      db.prepare(`
        INSERT INTO fetch_runs (id, source_id, status, error_message, started_at, finished_at)
        VALUES (?, ?, 'failed', ?, ?, ?)
      `).run(randomUUID(), input.sourceId, input.errorMessage, timestamp, timestamp);

      db.prepare(`
        UPDATE sources
        SET last_checked_at = ?, next_due_at = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, addHoursIso(spec.schedule.everyHours), timestamp, input.sourceId);
    },

    recordCanaryRun(input: {
      sourceId: string;
      status: 'pass' | 'fail';
      checkedAt: string;
      details: unknown;
    }): void {
      const sourceRow = db
        .prepare('SELECT spec_json FROM sources WHERE id = ?')
        .get(input.sourceId) as { spec_json: string } | undefined;

      if (!sourceRow) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.sourceNotFound,
          `Unknown source '${input.sourceId}'`,
        );
      }

      const spec = JSON.parse(sourceRow.spec_json) as SourceSpec;
      const canary = resolveSourceCanary(spec);

      db.prepare(`
        INSERT INTO canary_runs (id, source_id, status, checked_at, details_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.sourceId,
        input.status,
        input.checkedAt,
        JSON.stringify(input.details),
      );

      db.prepare(`
        UPDATE sources
        SET
          last_canary_checked_at = ?,
          last_successful_canary_at = CASE WHEN ? = 'pass' THEN ? ELSE last_successful_canary_at END,
          last_canary_status = ?,
          next_canary_due_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        input.checkedAt,
        input.status,
        input.checkedAt,
        input.status,
        addHoursIso(canary.everyHours),
        input.checkedAt,
        input.sourceId,
      );
    },

    listProjectLinks,

    removeManagedSources(input: { managedRoots: string[]; activeSources: Array<{ sourceId: string; specPath: string }> }): string[] {
      if (input.managedRoots.length === 0) {
        return [];
      }

      const activeSourceKeys = new Set(
        input.activeSources.map((source) => `${source.sourceId}::${resolve(source.specPath)}`),
      );
      const rows = db.prepare(`
        SELECT id, spec_path
        FROM sources
        WHERE spec_path IS NOT NULL
        ORDER BY id
      `).all() as Array<{ id: string; spec_path: string | null }>;

      const toDelete = rows
        .filter((row) => {
          if (!row.spec_path) {
            return false;
          }

          const normalizedSpecPath = resolve(row.spec_path);
          return input.managedRoots.some((managedRoot) =>
            normalizedSpecPath === managedRoot || normalizedSpecPath.startsWith(`${managedRoot}/`),
          ) && !activeSourceKeys.has(`${row.id}::${normalizedSpecPath}`);
        })
        .map((row) => row.id);

      if (toDelete.length === 0) {
        return [];
      }

      const deleteStatement = db.prepare('DELETE FROM sources WHERE id = ?');
      const transaction = db.transaction((sourceIds: string[]) => {
        for (const sourceId of sourceIds) {
          deleteStatement.run(sourceId);
        }
      });
      transaction(toDelete);

      return toDelete;
    },

    listSnapshots(sourceId: string): Array<{
      snapshotId: string;
      sourceId: string;
      detectedVersion: string | null;
      createdAt: string;
      pageCount: number;
    }> {
      const rows = db.prepare(`
        SELECT id, source_id, detected_version, created_at, page_count
        FROM snapshots
        WHERE source_id = ?
        ORDER BY rowid DESC
      `).all(sourceId) as Array<{
        id: string;
        source_id: string;
        detected_version: string | null;
        created_at: string;
        page_count: number;
      }>;

      return rows.map((row) => ({
        snapshotId: row.id,
        sourceId: row.source_id,
        detectedVersion: row.detected_version,
        createdAt: row.created_at,
        pageCount: row.page_count,
      }));
    },

    diffSnapshots(input: {
      sourceId: string;
      fromSnapshotId?: string;
      toSnapshotId?: string;
    }): {
      sourceId: string;
      fromSnapshotId: string;
      toSnapshotId: string;
      summary: {
        addedPageCount: number;
        removedPageCount: number;
        changedPageCount: number;
        unchangedPageCount: number;
      };
      addedPages: Array<{ url: string; title: string }>;
      removedPages: Array<{ url: string; title: string }>;
      changedPages: Array<{
        url: string;
        beforeTitle: string;
        afterTitle: string;
        lineSummary: {
          addedLineCount: number;
          removedLineCount: number;
        };
      }>;
    } {
      const snapshots = this.listSnapshots(input.sourceId);
      if (snapshots.length === 0) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.snapshotNotFound,
          `No successful snapshot found for source '${input.sourceId}'`,
        );
      }

      const toSnapshot = input.toSnapshotId
        ? snapshots.find((snapshot) => snapshot.snapshotId === input.toSnapshotId)
        : snapshots[0];

      if (!toSnapshot) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.snapshotNotFound,
          `Snapshot '${input.toSnapshotId}' not found for source '${input.sourceId}'`,
        );
      }

      const toSnapshotIndex = snapshots.findIndex((snapshot) => snapshot.snapshotId === toSnapshot.snapshotId);
      const fromSnapshot = input.fromSnapshotId
        ? snapshots.find((snapshot) => snapshot.snapshotId === input.fromSnapshotId)
        : snapshots[toSnapshotIndex + 1];

      if (!fromSnapshot) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.snapshotDiffBaseNotFound,
          `No base snapshot available to diff source '${input.sourceId}'`,
        );
      }

      const loadSnapshotPages = (snapshotId: string): SnapshotPageRow[] =>
        db.prepare(`
          SELECT url, title, markdown, content_hash
          FROM pages
          WHERE snapshot_id = ?
          ORDER BY url
        `).all(snapshotId) as SnapshotPageRow[];

      const beforePages = loadSnapshotPages(fromSnapshot.snapshotId);
      const afterPages = loadSnapshotPages(toSnapshot.snapshotId);
      const beforeMap = new Map(beforePages.map((page) => [page.url, page]));
      const afterMap = new Map(afterPages.map((page) => [page.url, page]));

      const addedPages = afterPages
        .filter((page) => !beforeMap.has(page.url))
        .map((page) => ({
          url: page.url,
          title: page.title,
        }));

      const removedPages = beforePages
        .filter((page) => !afterMap.has(page.url))
        .map((page) => ({
          url: page.url,
          title: page.title,
        }));

      const summarizeLineDiff = (beforeMarkdown: string, afterMarkdown: string) => {
        const beforeLines = beforeMarkdown.split('\n');
        const afterLines = afterMarkdown.split('\n');
        let prefix = 0;
        while (
          prefix < beforeLines.length &&
          prefix < afterLines.length &&
          beforeLines[prefix] === afterLines[prefix]
        ) {
          prefix += 1;
        }

        let suffix = 0;
        while (
          suffix < beforeLines.length - prefix &&
          suffix < afterLines.length - prefix &&
          beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
        ) {
          suffix += 1;
        }

        return {
          addedLineCount: Math.max(0, afterLines.length - prefix - suffix),
          removedLineCount: Math.max(0, beforeLines.length - prefix - suffix),
        };
      };

      const changedPages = beforePages
        .filter((page) => afterMap.has(page.url))
        .map((page) => ({
          before: page,
          after: afterMap.get(page.url)!,
        }))
        .filter(({ before, after }) => before.content_hash !== after.content_hash || before.title !== after.title)
        .map(({ before, after }) => ({
          url: before.url,
          beforeTitle: before.title,
          afterTitle: after.title,
          lineSummary: summarizeLineDiff(before.markdown, after.markdown),
        }));

      const unchangedPageCount = beforePages.filter((page) => {
        const next = afterMap.get(page.url);
        return next && next.content_hash === page.content_hash && next.title === page.title;
      }).length;

      return {
        sourceId: input.sourceId,
        fromSnapshotId: fromSnapshot.snapshotId,
        toSnapshotId: toSnapshot.snapshotId,
        summary: {
          addedPageCount: addedPages.length,
          removedPageCount: removedPages.length,
          changedPageCount: changedPages.length,
          unchangedPageCount,
        },
        addedPages,
        removedPages,
        changedPages,
      };
    },

    search(input: SearchInput): {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      results: SearchRow[];
    } {
      const normalized = normalizeQuery(input.query);
      if (!normalized) {
        return {
          total: 0,
          limit: assertPaginationValue(input.limit, 'limit', 20),
          offset: assertPaginationValue(input.offset, 'offset', 0),
          hasMore: false,
          results: [],
        };
      }
      const limit = assertPaginationValue(input.limit, 'limit', 20);
      const offset = assertPaginationValue(input.offset, 'offset', 0);

      let sourceIds = input.sourceIds ? [...input.sourceIds] : undefined;
      if (!sourceIds || sourceIds.length === 0) {
        if (input.cwd) {
          const scope = resolveProjectScope(
            input.cwd,
            listProjectLinks().map((link) => ({
              projectPath: link.projectPath,
              sourceIds: link.sourceIds,
            })),
          );
          if (scope) {
            sourceIds = scope.sourceIds;
          }
        }
      }

      if ((!sourceIds || sourceIds.length === 0) && !input.all) {
        return {
          total: 0,
          limit,
          offset,
          hasMore: false,
          results: [],
        };
      }

      const filterSourceIds = sourceIds && sourceIds.length > 0 ? [...new Set(sourceIds)] : null;
      const latestSnapshotIds = input.snapshotId
        ? [input.snapshotId]
        : (db.prepare(`
            SELECT last_successful_snapshot_id AS snapshot_id
            FROM sources
            WHERE last_successful_snapshot_id IS NOT NULL
            ${filterSourceIds ? `AND id IN (${filterSourceIds.map(() => '?').join(',')})` : ''}
          `).all(...(filterSourceIds ?? [])) as Array<{ snapshot_id: string }>).map((row) => row.snapshot_id);

      if (latestSnapshotIds.length === 0) {
        return {
          total: 0,
          limit,
          offset,
          hasMore: false,
          results: [],
        };
      }

      const whereSnapshotPlaceholders = latestSnapshotIds.map(() => '?').join(',');
      const sourceSql = filterSourceIds ? `AND c.source_id IN (${filterSourceIds.map(() => '?').join(',')})` : '';
      const queryArgs = [
        normalized,
        ...latestSnapshotIds,
        ...(filterSourceIds ?? []),
      ];
      const totalRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND c.snapshot_id IN (${whereSnapshotPlaceholders})
          ${sourceSql}
      `).get(...queryArgs) as { total: number };
      const statement = db.prepare(`
        SELECT
          c.id AS chunk_id,
          c.source_id,
          c.snapshot_id,
          c.page_url,
          c.page_title,
          c.section_title,
          c.markdown
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND c.snapshot_id IN (${whereSnapshotPlaceholders})
          ${sourceSql}
        ORDER BY bm25(chunks_fts), c.id
        LIMIT ?
        OFFSET ?
      `);

      const rows = statement.all(
        ...queryArgs,
        limit,
        offset,
      ) as Array<{
        chunk_id: number;
        source_id: string;
        snapshot_id: string;
        page_url: string;
        page_title: string;
        section_title: string;
        markdown: string;
      }>;

      const results = rows.map((row) => ({
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        sectionTitle: row.section_title,
        markdown: row.markdown,
      }));

      return {
        total: totalRow.total,
        limit,
        offset,
        hasMore: offset + results.length < totalRow.total,
        results,
      };
    },

    markDaemonStarted(input: {
      startedAt: string;
      intervalMinutes: number;
      fetchOnStart: boolean;
    }): void {
      db.prepare(`
        INSERT INTO daemon_state (
          singleton_id,
          last_started_at,
          interval_minutes,
          fetch_on_start
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          last_started_at = excluded.last_started_at,
          interval_minutes = excluded.interval_minutes,
          fetch_on_start = excluded.fetch_on_start
      `).run(
        input.startedAt,
        input.intervalMinutes,
        input.fetchOnStart ? 1 : 0,
      );
    },

    markDaemonCycleStarted(startedAt: string): void {
      db.prepare(`
        INSERT INTO daemon_state (singleton_id, last_cycle_started_at)
        VALUES (1, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          last_cycle_started_at = excluded.last_cycle_started_at
      `).run(startedAt);
    },

    markDaemonCycleCompleted(input: {
      completedAt: string;
      status: 'success' | 'degraded' | 'failed';
    }): void {
      db.prepare(`
        INSERT INTO daemon_state (
          singleton_id,
          last_cycle_completed_at,
          last_cycle_status
        ) VALUES (1, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          last_cycle_completed_at = excluded.last_cycle_completed_at,
          last_cycle_status = excluded.last_cycle_status
      `).run(
        input.completedAt,
        input.status,
      );
    },

    getDaemonState(): {
      lastStartedAt: string | null;
      lastCycleStartedAt: string | null;
      lastCycleCompletedAt: string | null;
      lastCycleStatus: string | null;
      intervalMinutes: number | null;
      fetchOnStart: boolean | null;
    } | null {
      const row = db.prepare(`
        SELECT
          last_started_at,
          last_cycle_started_at,
          last_cycle_completed_at,
          last_cycle_status,
          interval_minutes,
          fetch_on_start
        FROM daemon_state
        WHERE singleton_id = 1
      `).get() as DaemonStateRow | undefined;

      if (!row) {
        return null;
      }

      return {
        lastStartedAt: row.last_started_at,
        lastCycleStartedAt: row.last_cycle_started_at,
        lastCycleCompletedAt: row.last_cycle_completed_at,
        lastCycleStatus: row.last_cycle_status,
        intervalMinutes: row.interval_minutes,
        fetchOnStart: row.fetch_on_start === null ? null : row.fetch_on_start === 1,
      };
    },

    getCoverageCorpus(input: {
      sourceId: string;
      snapshotId?: string;
    }): {
      sourceId: string;
      snapshotId: string;
      entries: Array<{
        pageTitle: string;
        sectionTitle: string;
        markdown: string;
      }>;
    } {
      const sourceRow = db
        .prepare('SELECT last_successful_snapshot_id FROM sources WHERE id = ?')
        .get(input.sourceId) as { last_successful_snapshot_id: string | null } | undefined;

      if (!sourceRow) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.sourceNotFound,
          `Unknown source '${input.sourceId}'`,
        );
      }

      const snapshotId = input.snapshotId ?? sourceRow.last_successful_snapshot_id;
      if (!snapshotId) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.snapshotNotFound,
          `No successful snapshot found for source '${input.sourceId}'`,
        );
      }

      const snapshotRow = db
        .prepare('SELECT id FROM snapshots WHERE id = ? AND source_id = ?')
        .get(snapshotId, input.sourceId) as { id: string } | undefined;
      if (!snapshotRow) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.snapshotNotFound,
          `Snapshot '${snapshotId}' not found for source '${input.sourceId}'`,
        );
      }

      const rows = db.prepare(`
        SELECT page_title, section_title, markdown
        FROM chunks
        WHERE source_id = ?
          AND snapshot_id = ?
        ORDER BY page_id, chunk_order
      `).all(input.sourceId, snapshotId) as Array<{
        page_title: string;
        section_title: string;
        markdown: string;
      }>;

      return {
        sourceId: input.sourceId,
        snapshotId,
        entries: rows.map((row) => ({
          pageTitle: row.page_title,
          sectionTitle: row.section_title,
          markdown: row.markdown,
        })),
      };
    },

    getChunkById(chunkId: number): ChunkRecord | null {
      const row = db.prepare(`
        SELECT
          c.id AS chunk_id,
          c.source_id,
          c.snapshot_id,
          c.page_url,
          c.page_title,
          c.section_title,
          c.markdown
        FROM chunks c
        WHERE c.id = ?
      `).get(chunkId) as
        | {
            chunk_id: number;
            source_id: string;
            snapshot_id: string;
            page_url: string;
            page_title: string;
            section_title: string;
            markdown: string;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        sectionTitle: row.section_title,
        markdown: row.markdown,
      };
    },
  };
}

export type Catalog = ReturnType<typeof openCatalog>;
