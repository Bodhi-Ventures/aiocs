import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import { parse as parseCsvSync } from 'csv-parse/sync';
import { PDFParse } from 'pdf-parse';

import { chunkContent } from '../catalog/chunking.js';
import { sha256 } from '../catalog/fingerprint.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { WorkspaceRawInputChunkInput, WorkspaceRawInputKind } from './types.js';

export type WorkspaceRawInputExtraction = {
  kind: WorkspaceRawInputKind;
  label: string;
  metadata: Record<string, unknown>;
  extractedTextPath: string | null;
  contentHash: string;
  chunks: WorkspaceRawInputChunkInput[];
};

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt']);
const TEXT_SIDECAR_EXTENSIONS = ['.md', '.txt'];
const MAX_DATASET_ROWS = 500;
const DATASET_ROWS_PER_CHUNK = 50;
const MAX_DATASET_COLUMNS = 40;
const MAX_DATASET_VALUE_CHARS = 240;
const MAX_JSON_PREVIEW_CHARS = 4_000;

async function walkFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(absolutePath);
    }
    return [absolutePath];
  }));

  return files.flat().sort((left, right) => left.localeCompare(right));
}

function normalizeMarkdownChunks(input: {
  title: string;
  content: string;
  filePath?: string | null;
}): WorkspaceRawInputChunkInput[] {
  return chunkContent({
    title: input.title,
    content: input.content,
    ...(input.filePath ? { filePath: input.filePath } : {}),
  }).map((chunk) => ({
    sectionTitle: chunk.sectionTitle,
    markdown: chunk.markdown,
    filePath: input.filePath ?? null,
  }));
}

function truncateDatasetValue(value: unknown): string {
  const rendered = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || value === null
      ? String(value)
      : JSON.stringify(value);

  if (rendered.length <= MAX_DATASET_VALUE_CHARS) {
    return rendered;
  }

  return `${rendered.slice(0, MAX_DATASET_VALUE_CHARS - 16).trimEnd()} … [truncated]`;
}

function normalizeDatasetColumns(records: Array<Record<string, unknown>>): string[] {
  const columnSet = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      columnSet.add(key);
      if (columnSet.size >= MAX_DATASET_COLUMNS) {
        break;
      }
    }
    if (columnSet.size >= MAX_DATASET_COLUMNS) {
      break;
    }
  }

  return [...columnSet].sort((left, right) => left.localeCompare(right));
}

function buildDatasetOverviewChunk(input: {
  title: string;
  kind: 'csv' | 'json' | 'jsonl';
  columns: string[];
  rowCount?: number;
  extraLines?: string[];
  filePath?: string | null;
}): WorkspaceRawInputChunkInput[] {
  const lines = [
    `# ${input.title}`,
    '',
    `Dataset kind: ${input.kind.toUpperCase()}`,
    ...(typeof input.rowCount === 'number' ? [`Row count: ${input.rowCount}`] : []),
    `Column count: ${input.columns.length}`,
    ...(input.columns.length > 0 ? ['', '## Columns', ...input.columns.map((column) => `- ${column}`)] : []),
    ...(input.extraLines && input.extraLines.length > 0 ? ['', ...input.extraLines] : []),
  ];

  return normalizeMarkdownChunks({
    title: input.title,
    content: lines.join('\n'),
    ...(input.filePath ? { filePath: input.filePath } : {}),
  });
}

function buildDatasetRowChunks(input: {
  title: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  filePath: string;
}): WorkspaceRawInputChunkInput[] {
  const chunks: WorkspaceRawInputChunkInput[] = [];

  for (let start = 0; start < input.rows.length; start += DATASET_ROWS_PER_CHUNK) {
    const slice = input.rows.slice(start, start + DATASET_ROWS_PER_CHUNK);
    const rowLines = slice.flatMap((row, index) => [
      `### Row ${start + index + 1}`,
      ...input.columns.map((column) => `- ${column}: ${truncateDatasetValue(row[column] ?? null)}`),
      '',
    ]);

    chunks.push(...normalizeMarkdownChunks({
      title: `${input.title} rows ${start + 1}-${start + slice.length}`,
      content: [
        `# ${input.title}`,
        '',
        `## Rows ${start + 1}-${start + slice.length}`,
        '',
        ...rowLines,
      ].join('\n'),
      filePath: input.filePath,
    }));
  }

  return chunks;
}

function ensureStructuredRecord(value: unknown, rowIndex: number): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value,
    rowIndex: rowIndex + 1,
  };
}

function renderJsonPreview(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  if (!rendered) {
    return 'null';
  }

  if (rendered.length <= MAX_JSON_PREVIEW_CHARS) {
    return rendered;
  }

  return `${rendered.slice(0, MAX_JSON_PREVIEW_CHARS - 16).trimEnd()}\n… [truncated]`;
}

async function readOptionalSidecar(absolutePath: string): Promise<{
  text: string | null;
  sidecarPath: string | null;
}> {
  const parsed = absolutePath.replace(extname(absolutePath), '');
  for (const extension of TEXT_SIDECAR_EXTENSIONS) {
    const sidecarPath = `${parsed}${extension}`;
    try {
      const content = await readFile(sidecarPath, 'utf8');
      const text = content.trim();
      if (text.length > 0) {
        return {
          text,
          sidecarPath,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    text: null,
    sidecarPath: null,
  };
}

export async function extractMarkdownDirectoryInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const filePaths = (await walkFiles(absolutePath))
    .filter((filePath) => MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase()));

  if (filePaths.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Markdown directory '${absolutePath}' contains no markdown or text files`,
    );
  }

  const chunks: WorkspaceRawInputChunkInput[] = [];
  const fileSummaries: Array<{ path: string; byteLength: number }> = [];
  const hashParts: string[] = [];

  for (const filePath of filePaths) {
    const content = (await readFile(filePath, 'utf8')).trim();
    if (!content) {
      continue;
    }
    const relativePath = relative(absolutePath, filePath).replace(/\\/g, '/');
    fileSummaries.push({
      path: relativePath,
      byteLength: Buffer.byteLength(content, 'utf8'),
    });
    hashParts.push(`${relativePath}:${sha256(content)}`);
    chunks.push(...normalizeMarkdownChunks({
      title: basename(relativePath),
      content,
      filePath: relativePath,
    }));
  }

  return {
    kind: 'markdown-dir',
    label: input.label ?? basename(absolutePath),
    metadata: {
      absolutePath,
      fileCount: fileSummaries.length,
      files: fileSummaries,
    },
    extractedTextPath: null,
    contentHash: sha256(hashParts.join('\n')),
    chunks,
  };
}

export async function extractPdfInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const fileBuffer = await readFile(absolutePath);
  const parser = new PDFParse({ data: fileBuffer });

  try {
    const text = await parser.getText();
    const normalizedText = text.text.trim();
    const fileStats = await stat(absolutePath);
    if (!normalizedText) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.invalidArgument,
        `PDF '${absolutePath}' did not yield searchable text`,
      );
    }

    return {
      kind: 'pdf',
      label: input.label ?? basename(absolutePath),
      metadata: {
        absolutePath,
        pageCount: text.total,
        sizeBytes: fileStats.size,
      },
      extractedTextPath: `${basename(absolutePath)}.txt`,
      contentHash: sha256(normalizedText),
      chunks: normalizeMarkdownChunks({
        title: basename(absolutePath),
        content: `# ${basename(absolutePath)}\n\n${normalizedText}`,
        filePath: basename(absolutePath),
      }),
    };
  } finally {
    await parser.destroy();
  }
}

export async function extractImageInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const imageStats = await stat(absolutePath);
  const sidecar = await readOptionalSidecar(absolutePath);
  const fileName = basename(absolutePath);
  const content = [
    `# ${fileName}`,
    '',
    `Image file: ${fileName}`,
    `Size bytes: ${imageStats.size}`,
    ...(sidecar.text ? ['', '## Extracted Notes', sidecar.text] : []),
  ].join('\n');

  return {
    kind: 'image',
    label: input.label ?? fileName,
    metadata: {
      absolutePath,
      sizeBytes: imageStats.size,
      sidecarPath: sidecar.sidecarPath,
    },
    extractedTextPath: sidecar.sidecarPath ? basename(sidecar.sidecarPath) : null,
    contentHash: sha256(content),
    chunks: normalizeMarkdownChunks({
      title: fileName,
      content,
      filePath: fileName,
    }),
  };
}

export async function extractCsvInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const fileStats = await stat(absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  const rows = parseCsvSync(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Array<Record<string, unknown>>;
  const sampledRows = rows.slice(0, MAX_DATASET_ROWS);
  const columns = normalizeDatasetColumns(sampledRows);
  const fileName = basename(absolutePath);

  if (rows.length === 0 || columns.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `CSV '${absolutePath}' did not yield any structured rows`,
    );
  }

  return {
    kind: 'csv',
    label: input.label ?? fileName,
    metadata: {
      absolutePath,
      sizeBytes: fileStats.size,
      rowCount: rows.length,
      sampledRowCount: sampledRows.length,
      truncatedRows: rows.length > sampledRows.length,
      columnCount: columns.length,
      columns,
    },
    extractedTextPath: `${fileName}.txt`,
    contentHash: sha256(content),
    chunks: [
      ...buildDatasetOverviewChunk({
        title: input.label ?? fileName,
        kind: 'csv',
        columns,
        rowCount: rows.length,
        extraLines: rows.length > sampledRows.length
          ? [`Rows are truncated to the first ${sampledRows.length} rows for workspace chunking.`]
          : [],
        filePath: fileName,
      }),
      ...buildDatasetRowChunks({
        title: input.label ?? fileName,
        rows: sampledRows,
        columns,
        filePath: fileName,
      }),
    ],
  };
}

export async function extractJsonInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const fileStats = await stat(absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  const fileName = basename(absolutePath);

  if (Array.isArray(parsed)) {
    const sampledRows = parsed.slice(0, MAX_DATASET_ROWS).map((entry, index) => ensureStructuredRecord(entry, index));
    const columns = normalizeDatasetColumns(sampledRows);
    return {
      kind: 'json',
      label: input.label ?? fileName,
      metadata: {
        absolutePath,
        sizeBytes: fileStats.size,
        topLevelType: 'array',
        rowCount: parsed.length,
        sampledRowCount: sampledRows.length,
        truncatedRows: parsed.length > sampledRows.length,
        columnCount: columns.length,
        columns,
      },
      extractedTextPath: `${fileName}.txt`,
      contentHash: sha256(content),
      chunks: [
        ...buildDatasetOverviewChunk({
          title: input.label ?? fileName,
          kind: 'json',
          columns,
          rowCount: parsed.length,
          extraLines: parsed.length > sampledRows.length
            ? [`Rows are truncated to the first ${sampledRows.length} rows for workspace chunking.`]
            : [],
          filePath: fileName,
        }),
        ...buildDatasetRowChunks({
          title: input.label ?? fileName,
          rows: sampledRows,
          columns,
          filePath: fileName,
        }),
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `JSON '${absolutePath}' must contain an object or array at the top level`,
    );
  }

  const objectValue = parsed as Record<string, unknown>;
  const topLevelKeys = Object.keys(objectValue).sort((left, right) => left.localeCompare(right));
  const preview = renderJsonPreview(objectValue);

  return {
    kind: 'json',
    label: input.label ?? fileName,
    metadata: {
      absolutePath,
      sizeBytes: fileStats.size,
      topLevelType: 'object',
      keyCount: topLevelKeys.length,
      keys: topLevelKeys,
    },
    extractedTextPath: `${fileName}.txt`,
    contentHash: sha256(content),
    chunks: normalizeMarkdownChunks({
      title: input.label ?? fileName,
      content: [
        `# ${input.label ?? fileName}`,
        '',
        'Manifest kind: JSON object',
        `Top-level key count: ${topLevelKeys.length}`,
        '',
        '## Keys',
        ...topLevelKeys.map((key) => `- ${key}`),
        '',
        '## Preview',
        '```json',
        preview,
        '```',
      ].join('\n'),
      filePath: fileName,
    }),
  };
}

export async function extractJsonlInput(input: {
  absolutePath: string;
  label?: string;
}): Promise<WorkspaceRawInputExtraction> {
  const absolutePath = resolve(input.absolutePath);
  const fileStats = await stat(absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.map((line, index) => ensureStructuredRecord(JSON.parse(line), index));
  const sampledRows = rows.slice(0, MAX_DATASET_ROWS);
  const columns = normalizeDatasetColumns(sampledRows);
  const fileName = basename(absolutePath);

  if (rows.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `JSONL '${absolutePath}' did not contain any rows`,
    );
  }

  return {
    kind: 'jsonl',
    label: input.label ?? fileName,
    metadata: {
      absolutePath,
      sizeBytes: fileStats.size,
      topLevelType: 'jsonl',
      rowCount: rows.length,
      sampledRowCount: sampledRows.length,
      truncatedRows: rows.length > sampledRows.length,
      columnCount: columns.length,
      columns,
    },
    extractedTextPath: `${fileName}.txt`,
    contentHash: sha256(content),
    chunks: [
      ...buildDatasetOverviewChunk({
        title: input.label ?? fileName,
        kind: 'jsonl',
        columns,
        rowCount: rows.length,
        extraLines: rows.length > sampledRows.length
          ? [`Rows are truncated to the first ${sampledRows.length} rows for workspace chunking.`]
          : [],
        filePath: fileName,
      }),
      ...buildDatasetRowChunks({
        title: input.label ?? fileName,
        rows: sampledRows,
        columns,
        filePath: fileName,
      }),
    ],
  };
}
