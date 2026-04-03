import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { chunkContent, detectLanguage } from './chunking.js';
import { buildSnapshotFingerprint, sha256 } from './fingerprint.js';
import { canonicalizeProjectPath, resolveProjectScope } from './project-scope.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { toSqliteGlob } from '../patterns.js';
import { canonicalizeManagedSpecPath } from '../runtime/paths.js';
import { parseSourceSpecObject, type SourceSpec } from '../spec/source-spec.js';
import type {
  WorkspaceArtifactChunkInput,
  WorkspaceArtifactKind,
  WorkspaceArtifactProvenanceInput,
  WorkspaceCompilerProfile,
  WorkspaceCompileRunRecord,
  WorkspaceCompileRunStatus,
  WorkspaceOutputFormat,
  WorkspaceRecord,
  WorkspaceSourceBindingRecord,
} from '../workspace/types.js';

type OpenCatalogOptions = {
  dataDir: string;
};

type SuccessfulPageInput = {
  url: string;
  title: string;
  markdown: string;
  pageKind?: 'document' | 'file';
  filePath?: string | null;
  language?: string | null;
};

type RecordSuccessfulSnapshotInput = {
  sourceId: string;
  detectedVersion?: string;
  revisionKey?: string;
  pages: SuccessfulPageInput[];
};

type SearchInput = {
  query: string;
  cwd?: string;
  sourceIds?: string[];
  snapshotId?: string;
  all?: boolean;
  pathPatterns?: string[];
  languages?: string[];
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
  pageKind: 'document' | 'file';
  filePath: string | null;
  language: string | null;
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
  page_kind: 'document' | 'file';
  file_path: string | null;
  language: string | null;
};

type DaemonStateRow = {
  last_started_at: string | null;
  last_cycle_started_at: string | null;
  last_cycle_completed_at: string | null;
  last_cycle_status: string | null;
  interval_minutes: number | null;
  fetch_on_start: number | null;
};

type WorkspaceRow = {
  id: string;
  label: string;
  purpose: string | null;
  compiler_profile_json: string;
  default_output_formats_json: string;
  created_at: string;
  updated_at: string;
  last_compile_run_id: string | null;
  last_compile_status: WorkspaceCompileRunStatus | null;
  last_compiled_at: string | null;
  binding_count: number;
  artifact_count: number;
};

type WorkspaceSourceBindingRow = {
  workspace_id: string;
  source_id: string;
  created_at: string;
};

type WorkspaceCompileRunRow = {
  id: string;
  workspace_id: string;
  status: WorkspaceCompileRunStatus;
  source_fingerprint: string;
  artifact_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string;
};

type WorkspaceArtifactRow = {
  workspace_id: string;
  path: string;
  kind: WorkspaceArtifactKind;
  content_hash: string;
  compiler_metadata_json: string;
  stale: number;
  created_at: string;
  updated_at: string;
  chunk_count: number;
};

type WorkspaceArtifactProvenanceRow = {
  workspace_id: string;
  artifact_path: string;
  source_id: string;
  snapshot_id: string;
  chunk_ids_json: string;
};

type WorkspaceArtifactChunkSearchRow = {
  artifactPath: string;
  kind: WorkspaceArtifactKind;
  sectionTitle: string;
  markdown: string;
  stale: boolean;
  score: number;
};

type SearchScope = {
  limit: number;
  offset: number;
  sourceIds: string[] | null;
  snapshotIds: string[];
  pathPatterns: string[] | null;
  languages: string[] | null;
};

type SearchResult = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  results: SearchRow[];
};

type EmbeddingChunkRecord = ChunkRecord & {
  contentHash: string;
};

type EmbeddingJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

type EmbeddingJobRecord = {
  sourceId: string;
  snapshotId: string;
  status: EmbeddingJobStatus;
  attemptCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
};

type EmbeddingOverviewRow = {
  source_id: string;
  snapshot_id: string | null;
  total_chunks: number;
  indexed_chunks: number;
  pending_chunks: number;
  failed_chunks: number;
  stale_chunks: number;
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
      page_kind TEXT NOT NULL DEFAULT 'document' CHECK(page_kind IN ('document', 'file')),
      file_path TEXT,
      language TEXT,
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
      markdown TEXT NOT NULL,
      page_kind TEXT NOT NULL DEFAULT 'document' CHECK(page_kind IN ('document', 'file')),
      file_path TEXT,
      language TEXT
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

    CREATE TABLE IF NOT EXISTS embedding_state (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      model_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'indexed', 'failed', 'stale')),
      vector_point_id TEXT,
      last_attempted_at TEXT,
      indexed_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS embedding_jobs (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      PRIMARY KEY(source_id, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status_updated
      ON embedding_jobs(status, updated_at, source_id, snapshot_id);

    CREATE INDEX IF NOT EXISTS idx_embedding_state_source_snapshot
      ON embedding_state(source_id, snapshot_id, status);

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      purpose TEXT,
      compiler_profile_json TEXT NOT NULL,
      default_output_formats_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_compile_run_id TEXT,
      last_compile_status TEXT CHECK(last_compile_status IN ('success', 'failed')),
      last_compiled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_source_bindings (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_compile_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
      source_fingerprint TEXT NOT NULL,
      artifact_count INTEGER NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_artifacts (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('concept', 'summary', 'report', 'slides', 'image', 'index', 'note')),
      content_hash TEXT NOT NULL,
      compiler_metadata_json TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, path)
    );

    CREATE TABLE IF NOT EXISTS workspace_artifact_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      section_title TEXT NOT NULL,
      chunk_order INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      FOREIGN KEY(workspace_id, artifact_path)
        REFERENCES workspace_artifacts(workspace_id, path)
        ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_artifact_chunks_fts USING fts5(
      artifact_path,
      section_title,
      markdown,
      content=workspace_artifact_chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS workspace_artifact_chunks_ai AFTER INSERT ON workspace_artifact_chunks BEGIN
      INSERT INTO workspace_artifact_chunks_fts(rowid, artifact_path, section_title, markdown)
      VALUES (new.id, new.artifact_path, new.section_title, new.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS workspace_artifact_chunks_ad AFTER DELETE ON workspace_artifact_chunks BEGIN
      INSERT INTO workspace_artifact_chunks_fts(workspace_artifact_chunks_fts, rowid, artifact_path, section_title, markdown)
      VALUES ('delete', old.id, old.artifact_path, old.section_title, old.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS workspace_artifact_chunks_au AFTER UPDATE ON workspace_artifact_chunks BEGIN
      INSERT INTO workspace_artifact_chunks_fts(workspace_artifact_chunks_fts, rowid, artifact_path, section_title, markdown)
      VALUES ('delete', old.id, old.artifact_path, old.section_title, old.markdown);
      INSERT INTO workspace_artifact_chunks_fts(rowid, artifact_path, section_title, markdown)
      VALUES (new.id, new.artifact_path, new.section_title, new.markdown);
    END;

    CREATE TABLE IF NOT EXISTS workspace_artifact_provenance (
      workspace_id TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      chunk_ids_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id, artifact_path, source_id, snapshot_id),
      FOREIGN KEY(workspace_id, artifact_path)
        REFERENCES workspace_artifacts(workspace_id, path)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_compile_runs_workspace
      ON workspace_compile_runs(workspace_id, finished_at);

    CREATE INDEX IF NOT EXISTS idx_workspace_artifact_provenance_workspace
      ON workspace_artifact_provenance(workspace_id, artifact_path);
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

  const pageColumns = db.prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>;
  if (!pageColumns.some((column) => column.name === 'page_kind')) {
    db.exec(`ALTER TABLE pages ADD COLUMN page_kind TEXT NOT NULL DEFAULT 'document'`);
  }
  if (!pageColumns.some((column) => column.name === 'file_path')) {
    db.exec('ALTER TABLE pages ADD COLUMN file_path TEXT');
  }
  if (!pageColumns.some((column) => column.name === 'language')) {
    db.exec('ALTER TABLE pages ADD COLUMN language TEXT');
  }

  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
  if (!chunkColumns.some((column) => column.name === 'page_kind')) {
    db.exec(`ALTER TABLE chunks ADD COLUMN page_kind TEXT NOT NULL DEFAULT 'document'`);
  }
  if (!chunkColumns.some((column) => column.name === 'file_path')) {
    db.exec('ALTER TABLE chunks ADD COLUMN file_path TEXT');
  }
  if (!chunkColumns.some((column) => column.name === 'language')) {
    db.exec('ALTER TABLE chunks ADD COLUMN language TEXT');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function addHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function resolveCanaryEveryHours(spec: SourceSpec): number {
  return spec.canary?.everyHours ?? Math.max(1, Math.min(spec.schedule.everyHours, 6));
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

function normalizePatternFilters(patterns?: string[]): string[] | null {
  if (!patterns || patterns.length === 0) {
    return null;
  }

  const normalized = [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}

function normalizeLanguageFilters(languages?: string[]): string[] | null {
  if (!languages || languages.length === 0) {
    return null;
  }

  const normalized = [...new Set(languages.map((language) => language.trim().toLowerCase()).filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
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

  const getWorkspaceRow = (workspaceId: string): WorkspaceRow | undefined =>
    db.prepare(`
      SELECT
        w.id,
        w.label,
        w.purpose,
        w.compiler_profile_json,
        w.default_output_formats_json,
        w.created_at,
        w.updated_at,
        w.last_compile_run_id,
        w.last_compile_status,
        w.last_compiled_at,
        (
          SELECT COUNT(*)
          FROM workspace_source_bindings wb
          WHERE wb.workspace_id = w.id
        ) AS binding_count,
        (
          SELECT COUNT(*)
          FROM workspace_artifacts wa
          WHERE wa.workspace_id = w.id
        ) AS artifact_count
      FROM workspaces w
      WHERE w.id = ?
    `).get(workspaceId) as WorkspaceRow | undefined;

  const mapWorkspaceRow = (row: WorkspaceRow): WorkspaceRecord => ({
    id: row.id,
    label: row.label,
    purpose: row.purpose,
    compilerProfile: JSON.parse(row.compiler_profile_json) as WorkspaceCompilerProfile,
    defaultOutputFormats: JSON.parse(row.default_output_formats_json) as WorkspaceOutputFormat[],
    bindingCount: row.binding_count,
    artifactCount: row.artifact_count,
    lastCompileRunId: row.last_compile_run_id,
    lastCompileStatus: row.last_compile_status,
    lastCompiledAt: row.last_compiled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const assertWorkspaceExists = (workspaceId: string): WorkspaceRow => {
    const row = getWorkspaceRow(workspaceId);
    if (!row) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceNotFound,
        `Unknown workspace '${workspaceId}'`,
      );
    }
    return row;
  };

  const getWorkspaceArtifactRow = (workspaceId: string, artifactPath: string): WorkspaceArtifactRow | undefined =>
    db.prepare(`
      SELECT
        wa.workspace_id,
        wa.path,
        wa.kind,
        wa.content_hash,
        wa.compiler_metadata_json,
        wa.stale,
        wa.created_at,
        wa.updated_at,
        (
          SELECT COUNT(*)
          FROM workspace_artifact_chunks wac
          WHERE wac.workspace_id = wa.workspace_id
            AND wac.artifact_path = wa.path
        ) AS chunk_count
      FROM workspace_artifacts wa
      WHERE wa.workspace_id = ?
        AND wa.path = ?
    `).get(workspaceId, artifactPath) as WorkspaceArtifactRow | undefined;

  const mapWorkspaceArtifactRow = (row: WorkspaceArtifactRow) => ({
    workspaceId: row.workspace_id,
    path: row.path,
    kind: row.kind,
    contentHash: row.content_hash,
    compilerMetadata: JSON.parse(row.compiler_metadata_json) as Record<string, unknown>,
    stale: row.stale === 1,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const resolveSearchScope = (input: SearchInput): SearchScope => {
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
        limit,
        offset,
        sourceIds: null,
        snapshotIds: [],
        pathPatterns: normalizePatternFilters(input.pathPatterns),
        languages: normalizeLanguageFilters(input.languages),
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

    return {
      limit,
      offset,
      sourceIds: filterSourceIds,
      snapshotIds: latestSnapshotIds,
      pathPatterns: normalizePatternFilters(input.pathPatterns),
      languages: normalizeLanguageFilters(input.languages),
    };
  };

  const searchLexicalByScope = (input: {
    query: string;
    scope: SearchScope;
    limit?: number;
    offset?: number;
  }): SearchResult => {
    const normalized = normalizeQuery(input.query);
    const limit = assertPaginationValue(input.limit, 'limit', input.scope.limit);
    const offset = assertPaginationValue(input.offset, 'offset', input.scope.offset);

    if (!normalized || input.scope.snapshotIds.length === 0) {
      return {
        total: 0,
        limit,
        offset,
        hasMore: false,
        results: [],
      };
    }

    const whereSnapshotPlaceholders = input.scope.snapshotIds.map(() => '?').join(',');
    const sourceSql = input.scope.sourceIds
      ? `AND c.source_id IN (${input.scope.sourceIds.map(() => '?').join(',')})`
      : '';
    const pathSql = input.scope.pathPatterns
      ? `AND c.file_path IS NOT NULL AND (${input.scope.pathPatterns.map(() => 'c.file_path GLOB ?').join(' OR ')})`
      : '';
    const languageSql = input.scope.languages
      ? `AND c.language IN (${input.scope.languages.map(() => '?').join(',')})`
      : '';
    const queryArgs = [
      normalized,
      ...input.scope.snapshotIds,
      ...(input.scope.sourceIds ?? []),
      ...((input.scope.pathPatterns ?? []).map((pattern) => toSqliteGlob(pattern))),
      ...(input.scope.languages ?? []),
    ];

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
        AND c.snapshot_id IN (${whereSnapshotPlaceholders})
        ${sourceSql}
        ${pathSql}
        ${languageSql}
    `).get(...queryArgs) as { total: number };

    const rows = db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.source_id,
        c.snapshot_id,
        c.page_url,
        c.page_title,
        c.section_title,
        c.markdown,
        c.page_kind,
        c.file_path,
        c.language
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
        AND c.snapshot_id IN (${whereSnapshotPlaceholders})
        ${sourceSql}
        ${pathSql}
        ${languageSql}
      ORDER BY bm25(chunks_fts), c.id
      LIMIT ?
      OFFSET ?
    `).all(...queryArgs, limit, offset) as Array<{
      chunk_id: number;
      source_id: string;
      snapshot_id: string;
      page_url: string;
      page_title: string;
      section_title: string;
      markdown: string;
      page_kind: 'document' | 'file';
      file_path: string | null;
      language: string | null;
    }>;

    const results = rows.map((row) => ({
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      snapshotId: row.snapshot_id,
      pageUrl: row.page_url,
      pageTitle: row.page_title,
      sectionTitle: row.section_title,
      markdown: row.markdown,
      pageKind: row.page_kind,
      filePath: row.file_path,
      language: row.language,
    }));

    return {
      total: totalRow.total,
      limit,
      offset,
      hasMore: offset + results.length < totalRow.total,
      results,
    };
  };

  const listLatestSnapshots = (sourceIds?: string[]): Array<{ sourceId: string; snapshotId: string }> => {
    const filterSourceIds = sourceIds && sourceIds.length > 0 ? [...new Set(sourceIds)] : null;
    const rows = db.prepare(`
      SELECT id AS source_id, last_successful_snapshot_id AS snapshot_id
      FROM sources
      WHERE last_successful_snapshot_id IS NOT NULL
      ${filterSourceIds ? `AND id IN (${filterSourceIds.map(() => '?').join(',')})` : ''}
      ORDER BY id
    `).all(...(filterSourceIds ?? [])) as Array<{
      source_id: string;
      snapshot_id: string;
    }>;

    return rows.map((row) => ({
      sourceId: row.source_id,
      snapshotId: row.snapshot_id,
    }));
  };

  const queueEmbeddingJobForSnapshot = (
    sourceId: string,
    snapshotId: string,
    previousLatestSnapshotId?: string | null,
  ): void => {
    const timestamp = nowIso();

    if (previousLatestSnapshotId && previousLatestSnapshotId !== snapshotId) {
      db.prepare(`
        UPDATE embedding_state
        SET
          status = 'stale',
          vector_point_id = NULL,
          indexed_at = NULL,
          error_message = NULL
        WHERE source_id = ?
          AND snapshot_id = ?
      `).run(sourceId, previousLatestSnapshotId);

      db.prepare(`
        DELETE FROM embedding_jobs
        WHERE source_id = ?
          AND snapshot_id = ?
      `).run(sourceId, previousLatestSnapshotId);
    }

    const chunkRows = db.prepare(`
      SELECT id, markdown
      FROM chunks
      WHERE source_id = ?
        AND snapshot_id = ?
      ORDER BY id
    `).all(sourceId, snapshotId) as Array<{
      id: number;
      markdown: string;
    }>;

    const upsertState = db.prepare(`
      INSERT INTO embedding_state (
        chunk_id,
        source_id,
        snapshot_id,
        content_hash,
        model_key,
        status,
        vector_point_id,
        last_attempted_at,
        indexed_at,
        error_message
      ) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, NULL)
      ON CONFLICT(chunk_id) DO UPDATE SET
        source_id = excluded.source_id,
        snapshot_id = excluded.snapshot_id,
        content_hash = excluded.content_hash,
        model_key = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN embedding_state.model_key
          ELSE NULL
        END,
        status = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN 'indexed'
          ELSE 'pending'
        END,
        vector_point_id = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN embedding_state.vector_point_id
          ELSE NULL
        END,
        last_attempted_at = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN embedding_state.last_attempted_at
          ELSE NULL
        END,
        indexed_at = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN embedding_state.indexed_at
          ELSE NULL
        END,
        error_message = CASE
          WHEN embedding_state.status = 'indexed' AND embedding_state.content_hash = excluded.content_hash
            THEN embedding_state.error_message
          ELSE NULL
        END
    `);

    const transaction = db.transaction(() => {
      for (const chunk of chunkRows) {
        upsertState.run(
          chunk.id,
          sourceId,
          snapshotId,
          sha256(chunk.markdown),
        );
      }
    });
    transaction();

    const pendingRow = db.prepare(`
      SELECT COUNT(*) AS pending_count
      FROM embedding_state
      WHERE source_id = ?
        AND snapshot_id = ?
        AND status != 'indexed'
    `).get(sourceId, snapshotId) as { pending_count: number };

    if (pendingRow.pending_count === 0) {
      db.prepare(`
        INSERT INTO embedding_jobs (
          source_id,
          snapshot_id,
          status,
          attempt_count,
          chunk_count,
          created_at,
          updated_at,
          claimed_at,
          completed_at,
          error_message
        ) VALUES (?, ?, 'succeeded', 0, ?, ?, ?, NULL, ?, NULL)
        ON CONFLICT(source_id, snapshot_id) DO UPDATE SET
          status = 'succeeded',
          chunk_count = excluded.chunk_count,
          updated_at = excluded.updated_at,
          claimed_at = NULL,
          completed_at = excluded.completed_at,
          error_message = NULL
      `).run(sourceId, snapshotId, chunkRows.length, timestamp, timestamp, timestamp);
      return;
    }

    db.prepare(`
      INSERT INTO embedding_jobs (
        source_id,
        snapshot_id,
        status,
        attempt_count,
        chunk_count,
        created_at,
        updated_at,
        claimed_at,
        completed_at,
        error_message
      ) VALUES (?, ?, 'pending', 0, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(source_id, snapshot_id) DO UPDATE SET
        status = 'pending',
        chunk_count = excluded.chunk_count,
        updated_at = excluded.updated_at,
        claimed_at = NULL,
        completed_at = NULL,
        error_message = NULL
    `).run(sourceId, snapshotId, chunkRows.length, timestamp, timestamp);
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
      const resolvedSpecPath = options?.specPath ? canonicalizeManagedSpecPath(options.specPath) : null;
      const nextDueAt = !existing
        ? timestamp
        : existing.config_hash === configHash
          ? existing.next_due_at
          : timestamp;
      const canaryEveryHours = resolveCanaryEveryHours(spec);
      const nextCanaryDueAt = !existing
        ? timestamp
        : existing.config_hash === configHash
          ? (existing.next_canary_due_at ?? addHoursIso(canaryEveryHours))
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
      kind: SourceSpec['kind'];
      label: string;
      specPath: string | null;
      nextDueAt: string;
      isDue: boolean;
      nextCanaryDueAt: string | null;
      isCanaryDue: boolean;
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
          spec_json,
          spec_path,
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
        spec_json: string;
        spec_path: string | null;
        next_due_at: string;
        next_canary_due_at: string | null;
        last_checked_at: string | null;
        last_successful_snapshot_at: string | null;
        last_successful_snapshot_id: string | null;
        last_canary_checked_at: string | null;
        last_successful_canary_at: string | null;
        last_canary_status: 'pass' | 'fail' | null;
      }>;

      return rows.map((row) => {
        const storedSpec = parseSourceSpecObject(JSON.parse(row.spec_json));

        return {
          id: row.id,
          kind: storedSpec.kind,
          label: row.label,
          specPath: row.spec_path ? canonicalizeManagedSpecPath(row.spec_path) : null,
          nextDueAt: row.next_due_at,
          isDue: Date.parse(row.next_due_at) <= Date.now(),
          nextCanaryDueAt: row.next_canary_due_at,
          isCanaryDue: row.next_canary_due_at ? Date.parse(row.next_canary_due_at) <= Date.now() : false,
          lastCheckedAt: row.last_checked_at,
          lastSuccessfulSnapshotAt: row.last_successful_snapshot_at,
          lastSuccessfulSnapshotId: row.last_successful_snapshot_id,
          lastCanaryCheckedAt: row.last_canary_checked_at,
          lastSuccessfulCanaryAt: row.last_successful_canary_at,
          lastCanaryStatus: row.last_canary_status,
        };
      });
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

    createWorkspace(input: {
      id: string;
      label: string;
      purpose?: string | null;
      compilerProfile: WorkspaceCompilerProfile;
      defaultOutputFormats: WorkspaceOutputFormat[];
    }): WorkspaceRecord {
      const timestamp = nowIso();
      db.prepare(`
        INSERT INTO workspaces (
          id,
          label,
          purpose,
          compiler_profile_json,
          default_output_formats_json,
          created_at,
          updated_at,
          last_compile_run_id,
          last_compile_status,
          last_compiled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          purpose = excluded.purpose,
          compiler_profile_json = excluded.compiler_profile_json,
          default_output_formats_json = excluded.default_output_formats_json,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.label,
        input.purpose ?? null,
        stableStringify(input.compilerProfile),
        stableStringify(input.defaultOutputFormats),
        timestamp,
        timestamp,
      );

      return mapWorkspaceRow(assertWorkspaceExists(input.id));
    },

    listWorkspaces(): WorkspaceRecord[] {
      const rows = db.prepare(`
        SELECT
          w.id,
          w.label,
          w.purpose,
          w.compiler_profile_json,
          w.default_output_formats_json,
          w.created_at,
          w.updated_at,
          w.last_compile_run_id,
          w.last_compile_status,
          w.last_compiled_at,
          (
            SELECT COUNT(*)
            FROM workspace_source_bindings wb
            WHERE wb.workspace_id = w.id
          ) AS binding_count,
          (
            SELECT COUNT(*)
            FROM workspace_artifacts wa
            WHERE wa.workspace_id = w.id
          ) AS artifact_count
        FROM workspaces w
        ORDER BY w.id
      `).all() as WorkspaceRow[];

      return rows.map(mapWorkspaceRow);
    },

    getWorkspace(workspaceId: string): WorkspaceRecord | null {
      const row = getWorkspaceRow(workspaceId);
      return row ? mapWorkspaceRow(row) : null;
    },

    bindWorkspaceSources(workspaceId: string, sourceIds: string[]): void {
      assertWorkspaceExists(workspaceId);
      const normalizedSourceIds = [...new Set(sourceIds)];
      if (normalizedSourceIds.length === 0) {
        return;
      }

      const sourceLookup = db.prepare('SELECT id FROM sources WHERE id = ?');
      const timestamp = nowIso();
      const insert = db.prepare(`
        INSERT INTO workspace_source_bindings (workspace_id, source_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(workspace_id, source_id) DO NOTHING
      `);

      const transaction = db.transaction((ids: string[]) => {
        for (const sourceId of ids) {
          const exists = sourceLookup.get(sourceId) as { id: string } | undefined;
          if (!exists) {
            throw new AiocsError(
              AIOCS_ERROR_CODES.sourceNotFound,
              `Unknown source '${sourceId}'`,
            );
          }
          insert.run(workspaceId, sourceId, timestamp);
        }
      });

      transaction(normalizedSourceIds);
    },

    unbindWorkspaceSources(workspaceId: string, sourceIds?: string[]): void {
      assertWorkspaceExists(workspaceId);
      if (!sourceIds || sourceIds.length === 0) {
        db.prepare('DELETE FROM workspace_source_bindings WHERE workspace_id = ?').run(workspaceId);
        return;
      }

      const statement = db.prepare('DELETE FROM workspace_source_bindings WHERE workspace_id = ? AND source_id = ?');
      const transaction = db.transaction((ids: string[]) => {
        for (const sourceId of ids) {
          statement.run(workspaceId, sourceId);
        }
      });
      transaction([...new Set(sourceIds)]);
    },

    listWorkspaceSourceBindings(workspaceId: string): WorkspaceSourceBindingRecord[] {
      assertWorkspaceExists(workspaceId);
      const rows = db.prepare(`
        SELECT workspace_id, source_id, created_at
        FROM workspace_source_bindings
        WHERE workspace_id = ?
        ORDER BY source_id
      `).all(workspaceId) as WorkspaceSourceBindingRow[];

      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        sourceId: row.source_id,
        createdAt: row.created_at,
      }));
    },

    recordWorkspaceCompileRun(input: {
      workspaceId: string;
      status: WorkspaceCompileRunStatus;
      sourceFingerprint: string;
      artifactCount: number;
      errorMessage?: string | null;
      startedAt?: string;
      finishedAt?: string;
    }): WorkspaceCompileRunRecord {
      assertWorkspaceExists(input.workspaceId);
      const startedAt = input.startedAt ?? nowIso();
      const finishedAt = input.finishedAt ?? startedAt;
      const runId = `wrkcmp_${finishedAt.replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`;

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO workspace_compile_runs (
            id,
            workspace_id,
            status,
            source_fingerprint,
            artifact_count,
            error_message,
            started_at,
            finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          input.workspaceId,
          input.status,
          input.sourceFingerprint,
          input.artifactCount,
          input.errorMessage ?? null,
          startedAt,
          finishedAt,
        );

        db.prepare(`
          UPDATE workspaces
          SET
            last_compile_run_id = ?,
            last_compile_status = ?,
            last_compiled_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          runId,
          input.status,
          finishedAt,
          finishedAt,
          input.workspaceId,
        );
      });

      transaction();

      return {
        runId,
        workspaceId: input.workspaceId,
        status: input.status,
        sourceFingerprint: input.sourceFingerprint,
        artifactCount: input.artifactCount,
        errorMessage: input.errorMessage ?? null,
        startedAt,
        finishedAt,
      };
    },

    listWorkspaceCompileRuns(workspaceId: string): WorkspaceCompileRunRecord[] {
      assertWorkspaceExists(workspaceId);
      const rows = db.prepare(`
        SELECT id, workspace_id, status, source_fingerprint, artifact_count, error_message, started_at, finished_at
        FROM workspace_compile_runs
        WHERE workspace_id = ?
        ORDER BY finished_at DESC, id DESC
      `).all(workspaceId) as WorkspaceCompileRunRow[];

      return rows.map((row) => ({
        runId: row.id,
        workspaceId: row.workspace_id,
        status: row.status,
        sourceFingerprint: row.source_fingerprint,
        artifactCount: row.artifact_count,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }));
    },

    upsertWorkspaceArtifact(input: {
      workspaceId: string;
      path: string;
      kind: WorkspaceArtifactKind;
      contentHash: string;
      compilerMetadata: Record<string, unknown>;
      stale: boolean;
      chunks: WorkspaceArtifactChunkInput[];
      provenance: WorkspaceArtifactProvenanceInput[];
    }): WorkspaceArtifactRow {
      assertWorkspaceExists(input.workspaceId);
      const timestamp = nowIso();
      const normalizedChunks = input.chunks.map((chunk, index) => ({
        sectionTitle: chunk.sectionTitle,
        markdown: chunk.markdown.trim(),
        contentHash: sha256(chunk.markdown.trim()),
        chunkOrder: index,
      }));

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO workspace_artifacts (
            workspace_id,
            path,
            kind,
            content_hash,
            compiler_metadata_json,
            stale,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, path) DO UPDATE SET
            kind = excluded.kind,
            content_hash = excluded.content_hash,
            compiler_metadata_json = excluded.compiler_metadata_json,
            stale = excluded.stale,
            updated_at = excluded.updated_at
        `).run(
          input.workspaceId,
          input.path,
          input.kind,
          input.contentHash,
          stableStringify(input.compilerMetadata),
          input.stale ? 1 : 0,
          timestamp,
          timestamp,
        );

        db.prepare(`
          DELETE FROM workspace_artifact_chunks
          WHERE workspace_id = ?
            AND artifact_path = ?
        `).run(input.workspaceId, input.path);

        const insertChunk = db.prepare(`
          INSERT INTO workspace_artifact_chunks (
            workspace_id,
            artifact_path,
            section_title,
            chunk_order,
            markdown,
            content_hash
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const chunk of normalizedChunks) {
          insertChunk.run(
            input.workspaceId,
            input.path,
            chunk.sectionTitle,
            chunk.chunkOrder,
            chunk.markdown,
            chunk.contentHash,
          );
        }

        db.prepare(`
          DELETE FROM workspace_artifact_provenance
          WHERE workspace_id = ?
            AND artifact_path = ?
        `).run(input.workspaceId, input.path);

        const insertProvenance = db.prepare(`
          INSERT INTO workspace_artifact_provenance (
            workspace_id,
            artifact_path,
            source_id,
            snapshot_id,
            chunk_ids_json
          ) VALUES (?, ?, ?, ?, ?)
        `);

        for (const provenance of input.provenance) {
          insertProvenance.run(
            input.workspaceId,
            input.path,
            provenance.sourceId,
            provenance.snapshotId,
            stableStringify([...new Set(provenance.chunkIds)]),
          );
        }
      });

      transaction();

      const row = getWorkspaceArtifactRow(input.workspaceId, input.path);
      if (!row) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.workspaceArtifactNotFound,
          `Workspace artifact '${input.path}' not found in '${input.workspaceId}'`,
        );
      }

      return row;
    },

    listWorkspaceArtifacts(workspaceId: string) {
      assertWorkspaceExists(workspaceId);
      const rows = db.prepare(`
        SELECT
          wa.workspace_id,
          wa.path,
          wa.kind,
          wa.content_hash,
          wa.compiler_metadata_json,
          wa.stale,
          wa.created_at,
          wa.updated_at,
          (
            SELECT COUNT(*)
            FROM workspace_artifact_chunks wac
            WHERE wac.workspace_id = wa.workspace_id
              AND wac.artifact_path = wa.path
          ) AS chunk_count
        FROM workspace_artifacts wa
        WHERE wa.workspace_id = ?
        ORDER BY wa.path
      `).all(workspaceId) as WorkspaceArtifactRow[];

      return rows.map(mapWorkspaceArtifactRow);
    },

    setWorkspaceArtifactsStale(input: {
      workspaceId: string;
      artifactPaths: string[];
      stale: boolean;
    }): { updatedCount: number } {
      assertWorkspaceExists(input.workspaceId);
      const uniquePaths = [...new Set(input.artifactPaths)];
      if (uniquePaths.length === 0) {
        return { updatedCount: 0 };
      }

      const timestamp = nowIso();
      const result = db.prepare(`
        UPDATE workspace_artifacts
        SET stale = ?, updated_at = ?
        WHERE workspace_id = ?
          AND path IN (${uniquePaths.map(() => '?').join(',')})
      `).run(
        input.stale ? 1 : 0,
        timestamp,
        input.workspaceId,
        ...uniquePaths,
      );

      return {
        updatedCount: result.changes,
      };
    },

    deleteWorkspaceArtifacts(input: {
      workspaceId: string;
      artifactPaths: string[];
    }): { deletedCount: number } {
      assertWorkspaceExists(input.workspaceId);
      const uniquePaths = [...new Set(input.artifactPaths)];
      if (uniquePaths.length === 0) {
        return { deletedCount: 0 };
      }

      const result = db.prepare(`
        DELETE FROM workspace_artifacts
        WHERE workspace_id = ?
          AND path IN (${uniquePaths.map(() => '?').join(',')})
      `).run(
        input.workspaceId,
        ...uniquePaths,
      );

      return {
        deletedCount: result.changes,
      };
    },

    searchWorkspaceArtifacts(input: {
      workspaceId: string;
      query: string;
      limit?: number;
      offset?: number;
      kinds?: WorkspaceArtifactKind[];
    }): {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      results: WorkspaceArtifactChunkSearchRow[];
    } {
      assertWorkspaceExists(input.workspaceId);
      const normalized = normalizeQuery(input.query);
      const limit = assertPaginationValue(input.limit, 'limit', 10);
      const offset = assertPaginationValue(input.offset, 'offset', 0);
      const normalizedKinds = input.kinds && input.kinds.length > 0 ? [...new Set(input.kinds)] : null;

      if (!normalized) {
        return {
          total: 0,
          limit,
          offset,
          hasMore: false,
          results: [],
        };
      }

      const kindSql = normalizedKinds
        ? `AND wa.kind IN (${normalizedKinds.map(() => '?').join(',')})`
        : '';
      const args = [normalized, input.workspaceId, ...(normalizedKinds ?? [])];

      const totalRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM workspace_artifact_chunks_fts
        JOIN workspace_artifact_chunks wac ON wac.rowid = workspace_artifact_chunks_fts.rowid
        JOIN workspace_artifacts wa
          ON wa.workspace_id = wac.workspace_id
         AND wa.path = wac.artifact_path
        WHERE workspace_artifact_chunks_fts MATCH ?
          AND wac.workspace_id = ?
          ${kindSql}
      `).get(...args) as { total: number };

      const rows = db.prepare(`
        SELECT
          wac.artifact_path,
          wa.kind,
          wac.section_title,
          wac.markdown,
          wa.stale,
          bm25(workspace_artifact_chunks_fts) AS rank
        FROM workspace_artifact_chunks_fts
        JOIN workspace_artifact_chunks wac ON wac.rowid = workspace_artifact_chunks_fts.rowid
        JOIN workspace_artifacts wa
          ON wa.workspace_id = wac.workspace_id
         AND wa.path = wac.artifact_path
        WHERE workspace_artifact_chunks_fts MATCH ?
          AND wac.workspace_id = ?
          ${kindSql}
        ORDER BY bm25(workspace_artifact_chunks_fts), wac.rowid
        LIMIT ?
        OFFSET ?
      `).all(...args, limit, offset) as Array<{
        artifact_path: string;
        kind: WorkspaceArtifactKind;
        section_title: string;
        markdown: string;
        stale: number;
        rank: number;
      }>;

      return {
        total: totalRow.total,
        limit,
        offset,
        hasMore: offset + rows.length < totalRow.total,
        results: rows.map((row) => ({
          artifactPath: row.artifact_path,
          kind: row.kind,
          sectionTitle: row.section_title,
          markdown: row.markdown,
          stale: row.stale === 1,
          score: typeof row.rank === 'number' ? Math.abs(row.rank) : 0,
        })),
      };
    },

    getWorkspaceArtifact(workspaceId: string, artifactPath: string) {
      assertWorkspaceExists(workspaceId);
      const row = getWorkspaceArtifactRow(workspaceId, artifactPath);
      return row ? mapWorkspaceArtifactRow(row) : null;
    },

    listWorkspaceArtifactProvenance(workspaceId: string, artifactPath: string) {
      assertWorkspaceExists(workspaceId);
      if (!getWorkspaceArtifactRow(workspaceId, artifactPath)) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.workspaceArtifactNotFound,
          `Workspace artifact '${artifactPath}' not found in '${workspaceId}'`,
        );
      }

      const rows = db.prepare(`
        SELECT workspace_id, artifact_path, source_id, snapshot_id, chunk_ids_json
        FROM workspace_artifact_provenance
        WHERE workspace_id = ?
          AND artifact_path = ?
        ORDER BY source_id, snapshot_id
      `).all(workspaceId, artifactPath) as WorkspaceArtifactProvenanceRow[];

      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        path: row.artifact_path,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        chunkIds: JSON.parse(row.chunk_ids_json) as number[],
      }));
    },

    recordSuccessfulSnapshot(input: RecordSuccessfulSnapshotInput): { snapshotId: string; reused: boolean } {
      const sourceRow = db
        .prepare('SELECT config_hash, spec_json, last_successful_snapshot_id FROM sources WHERE id = ?')
        .get(input.sourceId) as {
          config_hash: string;
          spec_json: string;
          last_successful_snapshot_id: string | null;
        } | undefined;

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
        pageKind: page.pageKind ?? 'document',
        filePath: page.filePath ?? null,
        language: detectLanguage(page.filePath, page.language),
      }));

      const fingerprint = buildSnapshotFingerprint({
        sourceId: input.sourceId,
        configHash: sourceRow.config_hash,
        ...(input.revisionKey ? { revisionKey: input.revisionKey } : {}),
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

        queueEmbeddingJobForSnapshot(
          input.sourceId,
          existing.id,
          sourceRow.last_successful_snapshot_id,
        );

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
        INSERT INTO pages (snapshot_id, url, title, markdown, content_hash, page_kind, file_path, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (
          source_id, snapshot_id, page_id, page_url, page_title, section_title, chunk_order, markdown, page_kind, file_path, language
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          const pageInsert = insertPage.run(
            snapshotId,
            page.url,
            page.title,
            page.markdown,
            page.contentHash,
            page.pageKind,
            page.filePath,
            page.language,
          );
          const pageId = Number(pageInsert.lastInsertRowid);
          const chunks = chunkContent({
            title: page.title,
            content: page.markdown,
            filePath: page.filePath,
            language: page.language,
          });
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
              page.pageKind,
              page.filePath,
              page.language,
            );
          }
        }

        db.prepare(`
          UPDATE sources
          SET last_checked_at = ?, last_successful_snapshot_at = ?, last_successful_snapshot_id = ?, next_due_at = ?, updated_at = ?
          WHERE id = ?
        `).run(checkedAt, checkedAt, snapshotId, nextDueAt, checkedAt, input.sourceId);

        queueEmbeddingJobForSnapshot(
          input.sourceId,
          snapshotId,
          sourceRow.last_successful_snapshot_id,
        );

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
        addHoursIso(resolveCanaryEveryHours(spec)),
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
        input.activeSources.map((source) =>
          `${source.sourceId}::${canonicalizeManagedSpecPath(source.specPath)}`),
      );
      const normalizedManagedRoots = input.managedRoots.map((managedRoot) =>
        canonicalizeManagedSpecPath(managedRoot));
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

          const normalizedSpecPath = canonicalizeManagedSpecPath(row.spec_path);
          return normalizedManagedRoots.some((managedRoot) =>
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
      addedPages: Array<{ url: string; title: string; pageKind: 'document' | 'file'; filePath: string | null; language: string | null }>;
      removedPages: Array<{ url: string; title: string; pageKind: 'document' | 'file'; filePath: string | null; language: string | null }>;
      changedPages: Array<{
        url: string;
        beforeTitle: string;
        afterTitle: string;
        pageKind: 'document' | 'file';
        filePath: string | null;
        language: string | null;
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
          SELECT url, title, markdown, content_hash, page_kind, file_path, language
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
          pageKind: page.page_kind,
          filePath: page.file_path,
          language: page.language,
        }));

      const removedPages = beforePages
        .filter((page) => !afterMap.has(page.url))
        .map((page) => ({
          url: page.url,
          title: page.title,
          pageKind: page.page_kind,
          filePath: page.file_path,
          language: page.language,
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
          pageKind: after.page_kind,
          filePath: after.file_path,
          language: after.language,
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

    resolveSearchScope(input: SearchInput): SearchScope {
      return resolveSearchScope(input);
    },

    searchLexical(input: {
      query: string;
      scope: SearchScope;
      limit?: number;
      offset?: number;
    }): SearchResult {
      return searchLexicalByScope(input);
    },

    search(input: SearchInput): SearchResult {
      return searchLexicalByScope({
        query: input.query,
        scope: resolveSearchScope(input),
      });
    },

    listLatestSnapshots(sourceIds?: string[]): Array<{ sourceId: string; snapshotId: string }> {
      return listLatestSnapshots(sourceIds);
    },

    listSnapshotChunks(input: {
      sourceId: string;
      snapshotId: string;
    }): EmbeddingChunkRecord[] {
      const rows = db.prepare(`
        SELECT
          c.id AS chunk_id,
          c.source_id,
          c.snapshot_id,
          c.page_url,
          c.page_title,
          c.section_title,
          c.markdown,
          c.page_kind,
          c.file_path,
          c.language
        FROM chunks c
        WHERE c.source_id = ?
          AND c.snapshot_id = ?
      ORDER BY c.id
      `).all(input.sourceId, input.snapshotId) as Array<{
        chunk_id: number;
        source_id: string;
        snapshot_id: string;
        page_url: string;
        page_title: string;
        section_title: string;
        markdown: string;
        page_kind: 'document' | 'file';
        file_path: string | null;
        language: string | null;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        sectionTitle: row.section_title,
        markdown: row.markdown,
        pageKind: row.page_kind,
        filePath: row.file_path,
        language: row.language,
        contentHash: sha256(row.markdown),
      }));
    },

    getSnapshotEmbeddingState(input: {
      sourceId: string;
      snapshotId: string;
    }): Array<{
      chunkId: number;
      status: 'pending' | 'indexed' | 'failed' | 'stale';
      modelKey: string | null;
      contentHash: string;
    }> {
      const rows = db.prepare(`
        SELECT chunk_id, status, model_key, content_hash
        FROM embedding_state
        WHERE source_id = ?
          AND snapshot_id = ?
        ORDER BY chunk_id
      `).all(input.sourceId, input.snapshotId) as Array<{
        chunk_id: number;
        status: 'pending' | 'indexed' | 'failed' | 'stale';
        model_key: string | null;
        content_hash: string;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        status: row.status,
        modelKey: row.model_key,
        contentHash: row.content_hash,
      }));
    },

    listStaleEmbeddingChunkIds(sourceId: string): number[] {
      const rows = db.prepare(`
        SELECT chunk_id
        FROM embedding_state
        WHERE source_id = ?
          AND status = 'stale'
        ORDER BY chunk_id
      `).all(sourceId) as Array<{ chunk_id: number }>;

      return rows.map((row) => row.chunk_id);
    },

    listEmbeddingChunkIds(sourceIds?: string[]): number[] {
      const filterSourceIds = sourceIds && sourceIds.length > 0 ? [...new Set(sourceIds)] : null;
      const rows = db.prepare(`
        SELECT chunk_id
        FROM embedding_state
        ${filterSourceIds ? `WHERE source_id IN (${filterSourceIds.map(() => '?').join(',')})` : ''}
        ORDER BY chunk_id
      `).all(...(filterSourceIds ?? [])) as Array<{ chunk_id: number }>;

      return rows.map((row) => row.chunk_id);
    },

    getChunksByIds(chunkIds: number[]): ChunkRecord[] {
      if (chunkIds.length === 0) {
        return [];
      }

      const rows = db.prepare(`
        SELECT
          c.id AS chunk_id,
          c.source_id,
          c.snapshot_id,
          c.page_url,
          c.page_title,
          c.section_title,
          c.markdown,
          c.page_kind,
          c.file_path,
          c.language
        FROM chunks c
        WHERE c.id IN (${chunkIds.map(() => '?').join(',')})
      `).all(...chunkIds) as Array<{
        chunk_id: number;
        source_id: string;
        snapshot_id: string;
        page_url: string;
        page_title: string;
        section_title: string;
        markdown: string;
        page_kind: 'document' | 'file';
        file_path: string | null;
        language: string | null;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        snapshotId: row.snapshot_id,
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        sectionTitle: row.section_title,
        markdown: row.markdown,
        pageKind: row.page_kind,
        filePath: row.file_path,
        language: row.language,
      }));
    },

    queueLatestEmbeddingJobs(sourceIds?: string[]): { queuedJobs: number } {
      const latestSnapshots = listLatestSnapshots(sourceIds);
      const transaction = db.transaction((snapshots: Array<{ sourceId: string; snapshotId: string }>) => {
        for (const snapshot of snapshots) {
          queueEmbeddingJobForSnapshot(snapshot.sourceId, snapshot.snapshotId);
        }
      });
      transaction(latestSnapshots);
      return {
        queuedJobs: latestSnapshots.length,
      };
    },

    requeueLatestEmbeddingJobs(sourceIds?: string[]): { queuedJobs: number } {
      const latestSnapshots = listLatestSnapshots(sourceIds);
      const transaction = db.transaction((snapshots: Array<{ sourceId: string; snapshotId: string }>) => {
        for (const snapshot of snapshots) {
          db.prepare(`
            UPDATE embedding_state
            SET
              status = 'pending',
              model_key = NULL,
              vector_point_id = NULL,
              last_attempted_at = NULL,
              indexed_at = NULL,
              error_message = NULL
            WHERE source_id = ?
              AND snapshot_id = ?
          `).run(snapshot.sourceId, snapshot.snapshotId);

          queueEmbeddingJobForSnapshot(snapshot.sourceId, snapshot.snapshotId);
        }
      });
      transaction(latestSnapshots);

      return {
        queuedJobs: latestSnapshots.length,
      };
    },

    resetEmbeddingsAfterImport(): { queuedJobs: number } {
      const transaction = db.transaction(() => {
        db.prepare('DELETE FROM embedding_jobs').run();
        db.prepare('DELETE FROM embedding_state').run();
      });
      transaction();
      const latestSnapshots = listLatestSnapshots();
      const queueTransaction = db.transaction((snapshots: Array<{ sourceId: string; snapshotId: string }>) => {
        for (const snapshot of snapshots) {
          queueEmbeddingJobForSnapshot(snapshot.sourceId, snapshot.snapshotId);
        }
      });
      queueTransaction(latestSnapshots);
      return {
        queuedJobs: latestSnapshots.length,
      };
    },

    resetRunningEmbeddingJobs(): number {
      const result = db.prepare(`
        UPDATE embedding_jobs
        SET
          status = 'pending',
          updated_at = ?,
          claimed_at = NULL,
          error_message = NULL
        WHERE status = 'running'
      `).run(nowIso());
      return result.changes;
    },

    claimEmbeddingJobs(limit: number): EmbeddingJobRecord[] {
      const normalizedLimit = assertPaginationValue(limit, 'limit', limit);
      if (normalizedLimit === 0) {
        return [];
      }

      const claimedAt = nowIso();
      const transaction = db.transaction(() => {
        const pending = db.prepare(`
          SELECT
            source_id,
            snapshot_id,
            status,
            attempt_count,
            chunk_count,
            created_at,
            updated_at,
            claimed_at,
            completed_at,
            error_message
          FROM embedding_jobs
          WHERE status = 'pending'
          ORDER BY updated_at, source_id, snapshot_id
          LIMIT ?
        `).all(normalizedLimit) as Array<{
          source_id: string;
          snapshot_id: string;
          status: EmbeddingJobStatus;
          attempt_count: number;
          chunk_count: number;
          created_at: string;
          updated_at: string;
          claimed_at: string | null;
          completed_at: string | null;
          error_message: string | null;
        }>;

        const claim = db.prepare(`
          UPDATE embedding_jobs
          SET
            status = 'running',
            attempt_count = attempt_count + 1,
            updated_at = ?,
            claimed_at = ?,
            error_message = NULL
          WHERE source_id = ?
            AND snapshot_id = ?
        `);

        for (const job of pending) {
          claim.run(claimedAt, claimedAt, job.source_id, job.snapshot_id);
        }

        return pending.map((job) => ({
          sourceId: job.source_id,
          snapshotId: job.snapshot_id,
          status: 'running' as const,
          attemptCount: job.attempt_count + 1,
          chunkCount: job.chunk_count,
          createdAt: job.created_at,
          updatedAt: claimedAt,
          claimedAt,
          completedAt: job.completed_at,
          errorMessage: null,
        }));
      });

      return transaction();
    },

    markEmbeddingJobSucceeded(input: {
      sourceId: string;
      snapshotId: string;
      modelKey: string;
      indexedChunkIds: number[];
      staleChunkIds?: number[];
    }): void {
      const timestamp = nowIso();
      const staleChunkIds = [...new Set(input.staleChunkIds ?? [])];
      const indexedChunkIds = [...new Set(input.indexedChunkIds)];
      const indexedPlaceholders = indexedChunkIds.length > 0
        ? indexedChunkIds.map(() => '?').join(',')
        : null;
      const stalePlaceholders = staleChunkIds.length > 0
        ? staleChunkIds.map(() => '?').join(',')
        : null;

      const transaction = db.transaction(() => {
        if (indexedPlaceholders) {
          db.prepare(`
            UPDATE embedding_state
            SET
              status = 'indexed',
              model_key = ?,
              vector_point_id = CAST(chunk_id AS TEXT),
              last_attempted_at = ?,
              indexed_at = ?,
              error_message = NULL
            WHERE chunk_id IN (${indexedPlaceholders})
          `).run(input.modelKey, timestamp, timestamp, ...indexedChunkIds);
        }

        db.prepare(`
          UPDATE embedding_state
          SET
            status = 'failed',
            model_key = NULL,
            vector_point_id = NULL,
            last_attempted_at = ?,
            indexed_at = NULL,
            error_message = 'Chunk was not indexed during the latest embedding run'
          WHERE source_id = ?
            AND snapshot_id = ?
            AND status != 'indexed'
        `).run(timestamp, input.sourceId, input.snapshotId);

        if (stalePlaceholders) {
          db.prepare(`
            DELETE FROM embedding_state
            WHERE chunk_id IN (${stalePlaceholders})
          `).run(...staleChunkIds);
        }

        db.prepare(`
          UPDATE embedding_jobs
          SET
            status = 'succeeded',
            updated_at = ?,
            completed_at = ?,
            claimed_at = NULL,
            error_message = NULL
          WHERE source_id = ?
            AND snapshot_id = ?
        `).run(timestamp, timestamp, input.sourceId, input.snapshotId);
      });

      transaction();
    },

    markEmbeddingJobFailed(input: {
      sourceId: string;
      snapshotId: string;
      errorMessage: string;
    }): void {
      const timestamp = nowIso();
      const transaction = db.transaction(() => {
        db.prepare(`
          UPDATE embedding_state
          SET
            status = 'failed',
            model_key = NULL,
            vector_point_id = NULL,
            last_attempted_at = ?,
            indexed_at = NULL,
            error_message = ?
          WHERE source_id = ?
            AND snapshot_id = ?
            AND status != 'indexed'
        `).run(timestamp, input.errorMessage, input.sourceId, input.snapshotId);

        db.prepare(`
          UPDATE embedding_jobs
          SET
            status = 'failed',
            updated_at = ?,
            completed_at = ?,
            claimed_at = NULL,
            error_message = ?
          WHERE source_id = ?
            AND snapshot_id = ?
        `).run(timestamp, timestamp, input.errorMessage, input.sourceId, input.snapshotId);
      });

      transaction();
    },

    clearEmbeddings(sourceIds?: string[]): { clearedSources: string[] } {
      const latestSnapshots = listLatestSnapshots(sourceIds);
      const clearedSources = latestSnapshots.map((snapshot) => snapshot.sourceId);
      const filterSourceIds = sourceIds && sourceIds.length > 0 ? [...new Set(sourceIds)] : null;

      const transaction = db.transaction(() => {
        if (filterSourceIds && filterSourceIds.length > 0) {
          db.prepare(`
            DELETE FROM embedding_jobs
            WHERE source_id IN (${filterSourceIds.map(() => '?').join(',')})
          `).run(...filterSourceIds);

          db.prepare(`
            DELETE FROM embedding_state
            WHERE source_id IN (${filterSourceIds.map(() => '?').join(',')})
          `).run(...filterSourceIds);
        } else {
          db.prepare('DELETE FROM embedding_jobs').run();
          db.prepare('DELETE FROM embedding_state').run();
        }
      });
      transaction();

      return {
        clearedSources,
      };
    },

    getEmbeddingOverview(): {
      queue: {
        pendingJobs: number;
        runningJobs: number;
        failedJobs: number;
      };
      sources: Array<{
        sourceId: string;
        snapshotId: string | null;
        totalChunks: number;
        indexedChunks: number;
        pendingChunks: number;
        failedChunks: number;
        staleChunks: number;
        coverageRatio: number;
      }>;
    } {
      const queueCounts = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_jobs,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs
        FROM embedding_jobs
      `).get() as {
        pending_jobs: number | null;
        running_jobs: number | null;
        failed_jobs: number | null;
      };

      const rows = db.prepare(`
        SELECT
          s.id AS source_id,
          s.last_successful_snapshot_id AS snapshot_id,
          COUNT(c.id) AS total_chunks,
          SUM(CASE WHEN es.status = 'indexed' THEN 1 ELSE 0 END) AS indexed_chunks,
          SUM(CASE WHEN es.status = 'pending' THEN 1 ELSE 0 END) AS pending_chunks,
          SUM(CASE WHEN es.status = 'failed' THEN 1 ELSE 0 END) AS failed_chunks,
          SUM(CASE WHEN es.status = 'stale' THEN 1 ELSE 0 END) AS stale_chunks
        FROM sources s
        LEFT JOIN chunks c
          ON c.snapshot_id = s.last_successful_snapshot_id
        LEFT JOIN embedding_state es
          ON es.chunk_id = c.id
        GROUP BY s.id, s.last_successful_snapshot_id
        ORDER BY s.id
      `).all() as EmbeddingOverviewRow[];

      return {
        queue: {
          pendingJobs: queueCounts.pending_jobs ?? 0,
          runningJobs: queueCounts.running_jobs ?? 0,
          failedJobs: queueCounts.failed_jobs ?? 0,
        },
        sources: rows.map((row) => ({
          sourceId: row.source_id,
          snapshotId: row.snapshot_id,
          totalChunks: row.total_chunks,
          indexedChunks: row.indexed_chunks,
          pendingChunks: row.pending_chunks,
          failedChunks: row.failed_chunks,
          staleChunks: row.stale_chunks,
          coverageRatio: row.total_chunks === 0 ? 0 : row.indexed_chunks / row.total_chunks,
        })),
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
          c.markdown,
          c.page_kind,
          c.file_path,
          c.language
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
            page_kind: 'document' | 'file';
            file_path: string | null;
            language: string | null;
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
        pageKind: row.page_kind,
        filePath: row.file_path,
        language: row.language,
      };
    },
  };
}

export type Catalog = ReturnType<typeof openCatalog>;
