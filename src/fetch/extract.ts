import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { Page } from 'playwright';

import type { ExtractStrategy } from '../spec/source-spec.js';
import { htmlToMarkdown } from './normalize.js';

type ExtractedPage = {
  title: string;
  markdown: string;
};

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
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

async function runClipboardStrategy(page: Page, strategy: ExtractStrategy & { strategy: 'clipboardButton' }): Promise<ExtractedPage> {
  const before = await readClipboard(page).catch(() => '');

  for (const interaction of strategy.interactions) {
    if (interaction.action === 'click') {
      const locator = page.locator(interaction.selector).first();
      await locator.waitFor({ state: 'visible', timeout: interaction.timeoutMs ?? 10_000 });
      await locator.click();
      continue;
    }

    if (interaction.action === 'press') {
      await page.keyboard.press(interaction.key);
      continue;
    }

    await page.waitForTimeout(interaction.timeoutMs);
  }

  const markdown = await waitForClipboardChange(page, before, strategy.clipboardTimeoutMs);
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
    return runClipboardStrategy(page, strategy);
  }

  if (strategy.strategy === 'selector') {
    return runSelectorStrategy(page, strategy.selector);
  }

  return runReadabilityStrategy(page);
}
