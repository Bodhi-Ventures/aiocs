import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { chunkMarkdown } from './chunking.js';
import { buildSnapshotFingerprint, sha256 } from './fingerprint.js';
import { canonicalizeProjectPath, resolveProjectScope } from './project-scope.js';
import type { SourceSpec } from '../spec/source-spec.js';

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

function initSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_successful_snapshot_id TEXT,
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

    CREATE TABLE IF NOT EXISTS project_links (
      project_path TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_path, source_id)
    );
  `);
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

    upsertSource(spec: SourceSpec): { sourceId: string; configHash: string } {
      const timestamp = nowIso();
      const configHash = sha256(stableStringify(spec));
      const existing = db
        .prepare('SELECT id FROM sources WHERE id = ?')
        .get(spec.id) as { id: string } | undefined;

      db.prepare(`
        INSERT INTO sources (
          id, label, spec_json, config_hash, created_at, updated_at, next_due_at
        ) VALUES (
          @id, @label, @specJson, @configHash, @createdAt, @updatedAt, @nextDueAt
        )
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          spec_json = excluded.spec_json,
          config_hash = excluded.config_hash,
          updated_at = excluded.updated_at,
          next_due_at = excluded.next_due_at
      `).run({
        id: spec.id,
        label: spec.label,
        specJson: JSON.stringify(spec),
        configHash,
        createdAt: existing ? db.prepare('SELECT created_at FROM sources WHERE id = ?').pluck().get(spec.id) : timestamp,
        updatedAt: timestamp,
        nextDueAt: addHoursIso(spec.schedule.everyHours),
      });

      return {
        sourceId: spec.id,
        configHash,
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
      lastCheckedAt: string | null;
      lastSuccessfulSnapshotId: string | null;
    }> {
      const rows = db.prepare(`
        SELECT id, label, next_due_at, last_checked_at, last_successful_snapshot_id
        FROM sources
        ORDER BY id
      `).all() as Array<{
        id: string;
        label: string;
        next_due_at: string;
        last_checked_at: string | null;
        last_successful_snapshot_id: string | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        nextDueAt: row.next_due_at,
        lastCheckedAt: row.last_checked_at,
        lastSuccessfulSnapshotId: row.last_successful_snapshot_id,
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
        throw new Error(`Unknown source '${input.sourceId}'`);
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
          SET last_checked_at = ?, last_successful_snapshot_id = ?, next_due_at = ?, updated_at = ?
          WHERE id = ?
        `).run(checkedAt, existing.id, nextDueAt, checkedAt, input.sourceId);

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
          SET last_checked_at = ?, last_successful_snapshot_id = ?, next_due_at = ?, updated_at = ?
          WHERE id = ?
        `).run(checkedAt, snapshotId, nextDueAt, checkedAt, input.sourceId);

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
        throw new Error(`Unknown source '${input.sourceId}'`);
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

    listProjectLinks,

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
        ORDER BY created_at DESC, id DESC
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

    search(input: SearchInput): SearchRow[] {
      const normalized = normalizeQuery(input.query);
      if (!normalized) {
        return [];
      }

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
        return [];
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
        return [];
      }

      const whereSnapshotPlaceholders = latestSnapshotIds.map(() => '?').join(',');
      const sourceSql = filterSourceIds ? `AND c.source_id IN (${filterSourceIds.map(() => '?').join(',')})` : '';
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
        ORDER BY bm25(chunks_fts)
        LIMIT 20
      `);

      const rows = statement.all(
        normalized,
        ...latestSnapshotIds,
        ...(filterSourceIds ?? []),
      ) as Array<{
        chunk_id: number;
        source_id: string;
        snapshot_id: string;
        page_url: string;
        page_title: string;
        section_title: string;
        markdown: string;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        sectionTitle: row.section_title,
        markdown: row.markdown,
      }));
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
