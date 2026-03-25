import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

import type { Catalog } from '../catalog/catalog.js';
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

function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function isAllowed(url: string, allowedHosts: string[], include: string[], exclude: string[]): boolean {
  const parsed = new URL(url);
  if (!allowedHosts.includes(parsed.hostname)) {
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

export async function fetchSource(input: FetchSourceInput): Promise<{
  snapshotId: string;
  pageCount: number;
  reused: boolean;
}> {
  const spec = input.catalog.getSourceSpec(input.sourceId);
  if (!spec) {
    throw new Error(`Unknown source '${input.sourceId}'`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const uniqueOrigins = [...new Set(spec.startUrls.map((url) => new URL(url).origin))];
  for (const origin of uniqueOrigins) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  }

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const queue = spec.startUrls.map((url) => canonicalizeUrl(url));
  const seen = new Set<string>();
  const pages: FetchedPage[] = [];

  try {
    while (queue.length > 0 && pages.length < spec.discovery.maxPages) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      const url = canonicalizeUrl(next);
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);

      if (!isAllowed(url, spec.allowedHosts, spec.discovery.include, spec.discovery.exclude)) {
        continue;
      }

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      const extracted = await extractPage(page, spec.extract);
      const markdown = normalizeMarkdown(spec, {
        title: extracted.title,
        url,
        markdown: extracted.markdown,
      });

      pages.push({
        url,
        title: extracted.title,
        markdown,
      });

      const links = await discoverLinks(page);
      for (const link of links) {
        const canonical = canonicalizeUrl(link);
        if (!seen.has(canonical) && isAllowed(canonical, spec.allowedHosts, spec.discovery.include, spec.discovery.exclude)) {
          queue.push(canonical);
        }
      }
    }

    if (pages.length === 0) {
      throw new Error(`No pages fetched for source '${input.sourceId}'`);
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
  } catch (error) {
    input.catalog.recordFailedFetchRun({
      sourceId: input.sourceId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
