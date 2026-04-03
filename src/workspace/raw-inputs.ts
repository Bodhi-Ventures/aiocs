import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

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
