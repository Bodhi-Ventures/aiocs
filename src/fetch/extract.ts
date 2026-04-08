import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { Page } from 'playwright';

import type { ExtractStrategy } from '../spec/source-spec.js';
import { htmlToMarkdown } from './normalize.js';

type ExtractedPage = {
  title: string;
  markdown: string;
};

const CLIPBOARD_INTERACTION_DEFAULT_TIMEOUT_MS = 1_000;

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function writeClipboard(page: Page, value: string): Promise<boolean> {
  return page.evaluate(async (nextValue) => {
    try {
      await navigator.clipboard.writeText(nextValue);
      return true;
    } catch {
      return false;
    }
  }, value);
}

async function waitForClipboardChange(
  page: Page,
  previousText: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = (await readClipboard(page)).trim();
    if (current && current !== previousText.trim()) {
      return current;
    }
    await page.waitForTimeout(100);
  }

  throw new Error('Timed out waiting for clipboard content to change');
}

async function performClipboardInteractions(
  page: Page,
  strategy: ExtractStrategy & { strategy: 'clipboardButton' },
  deadlineAt: number,
): Promise<void> {
  for (const interaction of strategy.interactions) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out before clipboard copy controls became ready');
    }

    if (interaction.action === 'hover') {
      const locator = page.locator(interaction.selector).first();
      const interactionTimeout = Math.min(
        interaction.timeoutMs ?? CLIPBOARD_INTERACTION_DEFAULT_TIMEOUT_MS,
        remainingMs,
      );
      await locator.waitFor({
        state: 'visible',
        timeout: interactionTimeout,
      });
      await locator.hover({
        timeout: interactionTimeout,
      });
      continue;
    }

    if (interaction.action === 'click') {
      const locator = page.locator(interaction.selector).first();
      const interactionTimeout = Math.min(
        interaction.timeoutMs ?? CLIPBOARD_INTERACTION_DEFAULT_TIMEOUT_MS,
        remainingMs,
      );
      await locator.waitFor({
        state: 'visible',
        timeout: interactionTimeout,
      });
      await locator.click({
        timeout: interactionTimeout,
      });
      continue;
    }

    if (interaction.action === 'press') {
      await page.keyboard.press(interaction.key);
      continue;
    }

    await page.waitForTimeout(Math.min(interaction.timeoutMs, remainingMs));
  }
}

async function runClipboardStrategy(page: Page, strategy: ExtractStrategy & { strategy: 'clipboardButton' }): Promise<ExtractedPage> {
  const sentinel = `__aiocs_clipboard_marker__${Date.now()}__${Math.random().toString(36).slice(2)}__`;
  const before = (await writeClipboard(page, sentinel).catch(() => false))
    ? sentinel
    : await readClipboard(page).catch(() => '');
  const deadlineAt = Date.now() + strategy.clipboardTimeoutMs;
  let lastError: Error | null = null;
  let markdown: string | null = null;

  while (Date.now() < deadlineAt && !markdown) {
    try {
      await performClipboardInteractions(page, strategy, deadlineAt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    try {
      markdown = await waitForClipboardChange(page, before, Math.min(400, remainingMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!markdown) {
    throw lastError ?? new Error('Timed out waiting for clipboard content to change');
  }

  const title = extractTitleFromMarkdown(markdown) ?? (await page.title());

  return {
    title,
    markdown: markdown.trim(),
  };
}

async function runSelectorStrategy(page: Page, selector: string): Promise<ExtractedPage> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const html = await locator.innerHTML();
  const heading = await locator.locator('h1').first().textContent().catch(() => null);
  const title = (heading ?? (await page.title())).trim();

  return {
    title,
    markdown: htmlToMarkdown(html),
  };
}

async function runReadabilityStrategy(page: Page): Promise<ExtractedPage> {
  const html = await page.content();
  const dom = new JSDOM(html, { url: page.url() });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.content) {
    throw new Error(`Readability could not extract content for ${page.url()}`);
  }

  return {
    title: article.title?.trim() || (await page.title()),
    markdown: htmlToMarkdown(article.content),
  };
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

export async function extractPage(page: Page, strategy: ExtractStrategy): Promise<ExtractedPage> {
  if (strategy.strategy === 'clipboardButton') {
    try {
      return await runClipboardStrategy(page, strategy);
    } catch (error) {
      if (strategy.fallback?.strategy === 'readability') {
        return runReadabilityStrategy(page);
      }
      throw error;
    }
  }

  if (strategy.strategy === 'selector') {
    return runSelectorStrategy(page, strategy.selector);
  }

  return runReadabilityStrategy(page);
}
