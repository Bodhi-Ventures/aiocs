const MAX_CHUNK_BYTES = 16_384;
const CHUNK_OVERLAP_LINES = 6;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

export type MarkdownChunk = {
  sectionTitle: string;
  markdown: string;
  chunkOrder: number;
};

type ChunkContentInput = {
  title: string;
  content: string;
  filePath?: string | null;
  language?: string | null;
};

type SectionBoundary = {
  index: number;
  title: string;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeLanguage(filePath?: string | null, language?: string | null): string | null {
  if (language) {
    return language.toLowerCase();
  }

  if (!filePath) {
    return null;
  }

  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
    return 'markdown';
  }
  if (lower.endsWith('.ts')) {
    return 'typescript';
  }
  if (lower.endsWith('.tsx')) {
    return 'tsx';
  }
  if (lower.endsWith('.js')) {
    return 'javascript';
  }
  if (lower.endsWith('.jsx')) {
    return 'jsx';
  }
  if (lower.endsWith('.json')) {
    return 'json';
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'yaml';
  }
  if (lower.endsWith('.toml')) {
    return 'toml';
  }
  if (lower.endsWith('.py')) {
    return 'python';
  }
  if (lower.endsWith('.rs')) {
    return 'rust';
  }
  if (lower.endsWith('.go')) {
    return 'go';
  }
  if (lower.endsWith('.sql')) {
    return 'sql';
  }
  if (lower.endsWith('.sh')) {
    return 'shell';
  }

  return null;
}

function flushChunk(
  chunks: MarkdownChunk[],
  sectionTitle: string,
  current: string,
  chunkOrder: number,
): number {
  const trimmed = current.trim();
  if (!trimmed) {
    return chunkOrder;
  }

  chunks.push({
    sectionTitle,
    markdown: trimmed,
    chunkOrder,
  });

  return chunkOrder + 1;
}

function splitLargeSection(sectionTitle: string, markdown: string, startOrder: number): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const chunks: MarkdownChunk[] = [];
  let current = '';
  let order = startOrder;

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (current && byteLength(next) > MAX_CHUNK_BYTES) {
      order = flushChunk(chunks, sectionTitle, current, order);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }

  flushChunk(chunks, sectionTitle, current, order);
  return chunks;
}

function chunkMarkdownSectioned(pageTitle: string, markdown: string): MarkdownChunk[] {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return [];
  }

  if (byteLength(trimmed) <= MAX_CHUNK_BYTES) {
    return [{ sectionTitle: pageTitle, markdown: trimmed, chunkOrder: 0 }];
  }

  const lines = trimmed.split('\n');
  const sections: Array<{ title: string; markdown: string }> = [];
  let currentTitle = pageTitle;
  let currentLines: string[] = [];

  const flushSection = (): void => {
    const content = currentLines.join('\n').trim();
    if (!content) {
      currentLines = [];
      return;
    }
    sections.push({ title: currentTitle, markdown: content });
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.trim().match(HEADING_PATTERN);
    if (match && match[1]!.length >= 2) {
      flushSection();
      currentTitle = match[2]!.trim() || pageTitle;
    }
    currentLines.push(line);
  }

  flushSection();

  const chunks: MarkdownChunk[] = [];
  let order = 0;
  for (const section of sections) {
    if (byteLength(section.markdown) <= MAX_CHUNK_BYTES) {
      chunks.push({
        sectionTitle: section.title,
        markdown: section.markdown,
        chunkOrder: order,
      });
      order += 1;
      continue;
    }

    const split = splitLargeSection(section.title, section.markdown, order);
    chunks.push(...split);
    order = chunks.length;
  }

  return chunks;
}

function symbolBoundary(line: string, language: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const patterns: Array<RegExp> = [];
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      patterns.push(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
        /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/,
        /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/,
        /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/,
      );
      break;
    case 'python':
      patterns.push(/^(?:async\s+def|def|class)\s+([A-Za-z0-9_]+)/);
      break;
    case 'rust':
      patterns.push(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      break;
    case 'go':
      patterns.push(/^func\s+([A-Za-z0-9_]+)/, /^type\s+([A-Za-z0-9_]+)/);
      break;
    case 'json':
    case 'yaml':
    case 'toml':
      patterns.push(/^["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/);
      break;
    default:
      patterns.push(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, /^(?:class|interface|type|enum)\s+([A-Za-z0-9_$]+)/);
      break;
  }

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function discoverBoundaries(lines: string[], title: string, language: string): SectionBoundary[] {
  const boundaries: SectionBoundary[] = [];

  lines.forEach((line, index) => {
    const symbol = symbolBoundary(line, language);
    if (symbol) {
      boundaries.push({
        index,
        title: symbol,
      });
    }
  });

  if (boundaries.length === 0 || boundaries[0]!.index !== 0) {
    boundaries.unshift({
      index: 0,
      title,
    });
  }

  return boundaries;
}

function buildWindowTitle(title: string, startLine: number, endLine: number): string {
  return `${title} (${startLine}-${endLine})`;
}

function chunkLineWindows(
  title: string,
  content: string,
  startOrder: number,
): MarkdownChunk[] {
  const lines = content.split('\n');
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let order = startOrder;

  while (start < lines.length) {
    let end = start;
    let current = '';
    while (end < lines.length) {
      const candidate = current ? `${current}\n${lines[end]}` : lines[end]!;
      if (current && byteLength(candidate) > MAX_CHUNK_BYTES) {
        break;
      }
      current = candidate;
      end += 1;
    }

    const trimmed = current.trim();
    if (!trimmed) {
      break;
    }

    chunks.push({
      sectionTitle: buildWindowTitle(title, start + 1, end),
      markdown: trimmed,
      chunkOrder: order,
    });
    order += 1;

    if (end >= lines.length) {
      break;
    }

    start = Math.max(start + 1, end - CHUNK_OVERLAP_LINES);
  }

  return chunks;
}

function chunkByBoundaries(input: ChunkContentInput, language: string): MarkdownChunk[] {
  const trimmed = input.content.trim();
  if (!trimmed) {
    return [];
  }

  if (byteLength(trimmed) <= MAX_CHUNK_BYTES) {
    return [{ sectionTitle: input.title, markdown: trimmed, chunkOrder: 0 }];
  }

  const lines = trimmed.split('\n');
  const boundaries = discoverBoundaries(lines, input.title, language);
  const chunks: MarkdownChunk[] = [];
  let order = 0;

  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    const nextIndex = boundaries[index + 1]?.index ?? lines.length;
    const sectionLines = lines.slice(boundary.index, nextIndex);
    const sectionContent = sectionLines.join('\n').trim();
    if (!sectionContent) {
      continue;
    }

    if (byteLength(sectionContent) <= MAX_CHUNK_BYTES) {
      chunks.push({
        sectionTitle: boundary.title,
        markdown: sectionContent,
        chunkOrder: order,
      });
      order += 1;
      continue;
    }

    const splitChunks = chunkLineWindows(boundary.title, sectionContent, order);
    chunks.push(...splitChunks);
    order = chunks.length;
  }

  return chunks.length > 0 ? chunks : chunkLineWindows(input.title, trimmed, 0);
}

export function chunkMarkdown(pageTitle: string, markdown: string): MarkdownChunk[] {
  return chunkMarkdownSectioned(pageTitle, markdown);
}

export function chunkContent(input: ChunkContentInput): MarkdownChunk[] {
  const language = normalizeLanguage(input.filePath, input.language);
  if (language === 'markdown') {
    return chunkMarkdownSectioned(input.title, input.content);
  }

  if (!language) {
    return chunkLineWindows(input.title, input.content.trim(), 0);
  }

  return chunkByBoundaries(input, language);
}

export function detectLanguage(filePath?: string | null, language?: string | null): string | null {
  return normalizeLanguage(filePath, language);
}
