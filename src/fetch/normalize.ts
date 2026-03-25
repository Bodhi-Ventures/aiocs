import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import type { SourceSpec } from '../spec/source-spec.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.use(gfm);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

export function ensureTitle(markdown: string, title: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return `# ${title}`;
  }

  if (trimmed.startsWith('# ')) {
    return trimmed;
  }

  return `# ${title}\n\n${trimmed}`;
}

export function normalizeMarkdown(
  spec: SourceSpec,
  page: { title: string; url: string; markdown: string },
): string {
  const titled = ensureTitle(page.markdown, page.title);
  if (!spec.normalize.prependSourceComment) {
    return titled;
  }

  return `<!-- source: ${page.url} -->\n\n${titled}`;
}
