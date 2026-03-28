import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium, type BrowserContext, type Page } from 'playwright';

import type { Catalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { resolveSourceCanary, type SourceSpec } from '../spec/source-spec.js';
import { extractPage } from './extract.js';
import { normalizeMarkdown } from './normalize.js';
import { matchesPatterns } from './url-patterns.js';

type FetchSourceInput = {
  catalog: Catalog;
  sourceId: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
};

type CanarySourceInput = {
  catalog: Catalog;
  sourceId: string;
  env?: NodeJS.ProcessEnv;
};

type FetchedPage = {
  url: string;
  title: string;
  markdown: string;
};

type ExtractedFetchedPage = FetchedPage & {
  markdownLength: number;
};

type NavigationResponse = Awaited<ReturnType<import('playwright').Page['goto']>>;

export type CanaryCheckResult = {
  url: string;
  status: 'pass' | 'fail';
  title?: string;
  markdownLength?: number;
  errorMessage?: string;
};

export type CanaryRunResult = {
  sourceId: string;
  status: 'pass' | 'fail';
  checkedAt: string;
  summary: {
    checkCount: number;
    passCount: number;
    failCount: number;
  };
  checks: CanaryCheckResult[];
};

type ResolvedAuthHeader = {
  name: string;
  value: string;
  hosts: string[];
  include?: string[];
};

const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

function nowIso(): string {
  return new Date().toISOString();
}

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

function resolveEnvValue(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.authEnvMissing,
      `Missing required environment variable '${name}' for authenticated source access`,
      {
        envVar: name,
      },
    );
  }

  return value;
}

function resolveSourceAuth(spec: SourceSpec, env: NodeJS.ProcessEnv): {
  scopedHeaders: ResolvedAuthHeader[];
  cookies: Parameters<BrowserContext['addCookies']>[0];
} {
  const scopedHeaders = (spec.auth?.headers ?? []).map((header) => ({
    name: header.name,
    value: resolveEnvValue(header.valueFromEnv, env),
    hosts: header.hosts ?? spec.allowedHosts,
    ...(header.include ? { include: header.include } : {}),
  }));

  const cookies = (spec.auth?.cookies ?? []).map((cookie) => ({
    name: cookie.name,
    value: resolveEnvValue(cookie.valueFromEnv, env),
    domain: cookie.domain,
    path: cookie.path,
    ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
    ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
  }));

  return {
    scopedHeaders,
    cookies,
  };
}

export function applyScopedAuthHeaders(
  requestUrl: string,
  headers: Record<string, string>,
  scopedHeaders: ResolvedAuthHeader[],
): Record<string, string> {
  if (scopedHeaders.length === 0) {
    return headers;
  }

  const hostname = new URL(requestUrl).hostname;
  const nextHeaders = { ...headers };
  for (const header of scopedHeaders) {
    if (!header.hosts.includes(hostname)) {
      continue;
    }
    if (header.include && !matchesPatterns(requestUrl, header.include)) {
      continue;
    }
    nextHeaders[header.name] = header.value;
  }

  return nextHeaders;
}

async function createSourceContext(spec: SourceSpec, env: NodeJS.ProcessEnv): Promise<{
  page: Page;
  close(): Promise<void>;
}> {
  const { scopedHeaders, cookies } = resolveSourceAuth(spec, env);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1200,
    },
  });

  if (scopedHeaders.length > 0) {
    await context.route('**/*', async (route) => {
      await route.continue({
        headers: applyScopedAuthHeaders(route.request().url(), route.request().headers(), scopedHeaders),
      });
    });
  }

  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const uniqueOrigins = [...new Set(spec.startUrls.map((url) => new URL(url).origin))];
  for (const origin of uniqueOrigins) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  }

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  return {
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

async function discoverLinks(page: Page): Promise<string[]> {
  return page.locator('a[href]').evaluateAll((anchors) =>
    anchors
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter((href) => typeof href === 'string' && href.length > 0),
  );
}

async function extractFetchedPage(
  spec: SourceSpec,
  page: Page,
  url: string,
  response: NavigationResponse,
): Promise<ExtractedFetchedPage> {
  if (response && isRawMarkdownResponse(url, response)) {
    const extracted = await extractRawMarkdownPage(url, response);
    const markdown = normalizeMarkdown(spec, extracted);
    return {
      ...extracted,
      markdown,
      markdownLength: markdown.trim().length,
    };
  }

  await page.waitForTimeout(150);
  const extracted = await extractPage(page, spec.extract);
  const markdown = normalizeMarkdown(spec, {
    title: extracted.title,
    url,
    markdown: extracted.markdown,
  });
  return {
    url,
    title: extracted.title,
    markdown,
    markdownLength: markdown.trim().length,
  };
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

  const session = await createSourceContext(spec, input.env ?? process.env);
  const { page } = session;

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

      let fetchedPage: FetchedPage;

      try {
        fetchedPage = await extractFetchedPage(spec, page, url, response);
      } catch (error) {
        const pendingRawFallback = pendingRawFallbacks.get(crawlKey);
        if (!isRawMarkdownUrl && pendingRawFallback && !seen.has(pendingRawFallback)) {
          queue.unshift(pendingRawFallback);
          continue;
        }
        throw error;
      }

      const isRawMarkdown = response !== null && isRawMarkdownResponse(url, response);
      if (!existing) {
        pageOrder.push(crawlKey);
        pagesByCrawlKey.set(crawlKey, { page: fetchedPage, isRawMarkdown });
      } else if (existing.isRawMarkdown && !isRawMarkdown) {
        pagesByCrawlKey.set(crawlKey, { page: fetchedPage, isRawMarkdown });
      }
      if (!isRawMarkdown) {
        pendingRawFallbacks.delete(crawlKey);
      }

      if (!isRawMarkdown) {
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
      .filter((pageEntry): pageEntry is FetchedPage => pageEntry !== undefined);

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
    await session.close();
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

async function runSourceCanaryOnce(input: CanarySourceInput): Promise<CanaryRunResult> {
  const spec = input.catalog.getSourceSpec(input.sourceId);
  if (!spec) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.sourceNotFound,
      `Unknown source '${input.sourceId}'`,
    );
  }

  const canary = resolveSourceCanary(spec);
  const session = await createSourceContext(spec, input.env ?? process.env);
  const { page } = session;
  const checks: CanaryCheckResult[] = [];

  try {
    for (const check of canary.checks) {
      const url = canonicalizeUrl(check.url);
      try {
        if (!isAllowed(url, spec.allowedHosts, spec.discovery.include, spec.discovery.exclude)) {
          throw new AiocsError(
            AIOCS_ERROR_CODES.invalidArgument,
            `Canary URL '${url}' is outside the allowed source scope`,
          );
        }

        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (response && response.status() >= 400) {
          throw new Error(`Canary request failed with HTTP ${response.status()}`);
        }

        const extracted = await extractFetchedPage(spec, page, url, response);

        if (check.expectedTitle && !extracted.title.includes(check.expectedTitle)) {
          throw new Error(`Expected title to include '${check.expectedTitle}'`);
        }
        if (check.expectedText && !extracted.markdown.includes(check.expectedText)) {
          throw new Error(`Expected markdown to include '${check.expectedText}'`);
        }
        if (extracted.markdownLength < check.minMarkdownLength) {
          throw new Error(
            `Expected markdown length to be at least ${check.minMarkdownLength}, received ${extracted.markdownLength}`,
          );
        }

        checks.push({
          url,
          status: 'pass',
          title: extracted.title,
          markdownLength: extracted.markdownLength,
        });
      } catch (error) {
        checks.push({
          url,
          status: 'fail',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await session.close();
  }

  const result: CanaryRunResult = {
    sourceId: input.sourceId,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checkedAt: nowIso(),
    summary: {
      checkCount: checks.length,
      passCount: checks.filter((check) => check.status === 'pass').length,
      failCount: checks.filter((check) => check.status === 'fail').length,
    },
    checks,
  };

  input.catalog.recordCanaryRun({
    sourceId: input.sourceId,
    status: result.status,
    checkedAt: result.checkedAt,
    details: result,
  });

  if (result.status === 'fail') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.canaryFailed,
      `Canary failed for source '${input.sourceId}'`,
      result,
    );
  }

  return result;
}

export async function runSourceCanary(input: CanarySourceInput): Promise<CanaryRunResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await runSourceCanaryOnce(input);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_FETCH_ATTEMPTS) {
        if (error instanceof AiocsError && error.code === AIOCS_ERROR_CODES.canaryFailed) {
          return error.details as CanaryRunResult;
        }
        throw error;
      }

      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
