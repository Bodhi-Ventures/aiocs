import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium } from 'playwright';

import type { Catalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { matchesPatterns } from './url-patterns.js';
import { extractPage } from './extract.js';
import { normalizeMarkdown } from './normalize.js';

type FetchSourceInput = {
  catalog: Catalog;
  sourceId: string;
  dataDir: string;
};

type FetchedPage = {
  url: string;
  title: string;
  markdown: string;
};

type NavigationResponse = Awaited<ReturnType<import('playwright').Page['goto']>>;

const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function getCrawlKey(raw: string): string {
  const url = new URL(canonicalizeUrl(raw));
  if (/\.(md|markdown)$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\.(md|markdown)$/i, '');
  }
  return url.toString();
}

function isAllowed(url: string, allowedHosts: string[], include: string[], exclude: string[]): boolean {
  const parsed = new URL(url);
  if (!allowedHosts.includes(parsed.hostname)) {
    return false;
  }
  if (parsed.pathname.startsWith('/~gitbook/')) {
    return false;
  }
  if (!matchesPatterns(url, include)) {
    return false;
  }
  if (exclude.length > 0 && matchesPatterns(url, exclude)) {
    return false;
  }
  return true;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

function extractTitleFromMarkdown(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }

  return null;
}

function deriveTitleFromUrl(url: string): string {
  const pathname = new URL(url).pathname;
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? 'page';
  return lastSegment
    .replace(/\.(md|markdown)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'page';
}

function isRawMarkdownResponse(url: string, response: NavigationResponse): boolean {
  if (!response) {
    return false;
  }

  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  if (contentType.includes('text/markdown') || contentType.includes('text/x-markdown')) {
    return true;
  }

  return contentType.includes('text/plain') && /\.(md|markdown)$/i.test(new URL(url).pathname);
}

async function extractRawMarkdownPage(url: string, response: Exclude<NavigationResponse, null>): Promise<FetchedPage> {
  const markdown = (await response.text()).trim();
  return {
    url,
    title: extractTitleFromMarkdown(markdown) ?? deriveTitleFromUrl(url),
    markdown,
  };
}

function persistSnapshotPages(
  input: FetchSourceInput,
  snapshotId: string,
  pages: FetchedPage[],
): void {
  const snapshotDir = join(input.dataDir, 'sources', input.sourceId, 'snapshots', snapshotId, 'pages');
  mkdirSync(snapshotDir, { recursive: true });

  pages.forEach((page, index) => {
    const filename = `${String(index + 1).padStart(3, '0')}-${slugify(page.title)}.md`;
    writeFileSync(join(snapshotDir, filename), page.markdown, 'utf8');
  });
}

async function discoverLinks(page: import('playwright').Page): Promise<string[]> {
  return page.locator('a[href]').evaluateAll((anchors) =>
    anchors
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter((href) => typeof href === 'string' && href.length > 0),
  );
}

async function fetchSourceOnce(input: FetchSourceInput): Promise<{
  snapshotId: string;
  pageCount: number;
  reused: boolean;
}> {
  const spec = input.catalog.getSourceSpec(input.sourceId);
  if (!spec) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.sourceNotFound,
      `Unknown source '${input.sourceId}'`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1200,
    },
  });
  const uniqueOrigins = [...new Set(spec.startUrls.map((url) => new URL(url).origin))];
  for (const origin of uniqueOrigins) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  }

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const queue = spec.startUrls.map((url) => canonicalizeUrl(url));
  const seen = new Set<string>();
  const pageOrder: string[] = [];
  const pagesByCrawlKey = new Map<string, { page: FetchedPage; isRawMarkdown: boolean }>();
  const pendingRawFallbacks = new Map<string, string>();

  try {
    while (queue.length > 0 && pagesByCrawlKey.size < spec.discovery.maxPages) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      const url = canonicalizeUrl(next);
      const crawlKey = getCrawlKey(url);
      const isRawMarkdownUrl = crawlKey !== url;
      const existing = pagesByCrawlKey.get(crawlKey);

      if (isRawMarkdownUrl) {
        if (existing && !existing.isRawMarkdown) {
          continue;
        }

        if (!seen.has(crawlKey) && !existing) {
          pendingRawFallbacks.set(crawlKey, url);
          const canonicalQueued = queue.some((queuedUrl) => canonicalizeUrl(queuedUrl) === crawlKey);
          if (!canonicalQueued) {
            queue.unshift(crawlKey);
          }
          continue;
        }
      }

      if (seen.has(url)) {
        continue;
      }
      seen.add(url);

      if (!isAllowed(url, spec.allowedHosts, spec.discovery.include, spec.discovery.exclude)) {
        continue;
      }

      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400) {
        const pendingRawFallback = pendingRawFallbacks.get(crawlKey);
        if (!isRawMarkdownUrl && pendingRawFallback && !seen.has(pendingRawFallback)) {
          queue.unshift(pendingRawFallback);
        }
        continue;
      }

      const rawMarkdownResponse = response && isRawMarkdownResponse(url, response)
        ? response
        : null;
      let fetchedPage: FetchedPage;

      try {
        if (rawMarkdownResponse) {
          const extracted = await extractRawMarkdownPage(url, rawMarkdownResponse);
          fetchedPage = {
            ...extracted,
            markdown: normalizeMarkdown(spec, extracted),
          };
        } else {
          await page.waitForTimeout(150);

          const extracted = await extractPage(page, spec.extract);
          fetchedPage = {
            url,
            title: extracted.title,
            markdown: normalizeMarkdown(spec, {
              title: extracted.title,
              url,
              markdown: extracted.markdown,
            }),
          };
        }
      } catch (error) {
        const pendingRawFallback = pendingRawFallbacks.get(crawlKey);
        if (!isRawMarkdownUrl && pendingRawFallback && !seen.has(pendingRawFallback)) {
          queue.unshift(pendingRawFallback);
          continue;
        }
        throw error;
      }

      const isRawMarkdown = rawMarkdownResponse !== null;
      if (!existing) {
        pageOrder.push(crawlKey);
        pagesByCrawlKey.set(crawlKey, { page: fetchedPage, isRawMarkdown });
      } else if (existing.isRawMarkdown && !isRawMarkdown) {
        pagesByCrawlKey.set(crawlKey, { page: fetchedPage, isRawMarkdown });
      }
      if (!isRawMarkdown) {
        pendingRawFallbacks.delete(crawlKey);
      }

      if (!rawMarkdownResponse) {
        const links = await discoverLinks(page);
        for (const link of links) {
          const canonical = canonicalizeUrl(link);
          if (!seen.has(canonical) && isAllowed(canonical, spec.allowedHosts, spec.discovery.include, spec.discovery.exclude)) {
            queue.push(canonical);
          }
        }
      }
    }

    const pages = pageOrder
      .map((crawlKey) => pagesByCrawlKey.get(crawlKey)?.page)
      .filter((page): page is FetchedPage => page !== undefined);

    if (pages.length === 0) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.noPagesFetched,
        `No pages fetched for source '${input.sourceId}'`,
      );
    }

    const result = input.catalog.recordSuccessfulSnapshot({
      sourceId: input.sourceId,
      pages,
    });

    if (!result.reused) {
      persistSnapshotPages(input, result.snapshotId, pages);
    }

    return {
      snapshotId: result.snapshotId,
      pageCount: pages.length,
      reused: result.reused,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function fetchSource(input: FetchSourceInput): Promise<{
  snapshotId: string;
  pageCount: number;
  reused: boolean;
}> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSourceOnce(input);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_FETCH_ATTEMPTS) {
        input.catalog.recordFailedFetchRun({
          sourceId: input.sourceId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
