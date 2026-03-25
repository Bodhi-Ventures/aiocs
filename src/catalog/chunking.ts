const MAX_CHUNK_BYTES = 16_384;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

export type MarkdownChunk = {
  sectionTitle: string;
  markdown: string;
  chunkOrder: number;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function splitLargeSection(sectionTitle: string, markdown: string, startOrder: number): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const chunks: MarkdownChunk[] = [];
  let current = '';
  let order = startOrder;

  const flush = (): void => {
    const trimmed = current.trim();
    if (!trimmed) {
      current = '';
      return;
    }

    chunks.push({
      sectionTitle,
      markdown: trimmed,
      chunkOrder: order,
    });
    order += 1;
    current = '';
  };

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (current && byteLength(next) > MAX_CHUNK_BYTES) {
      flush();
    }
    current = current ? `${current}\n${line}` : line;
  }

  flush();
  return chunks;
}

export function chunkMarkdown(pageTitle: string, markdown: string): MarkdownChunk[] {
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
