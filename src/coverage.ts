import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AiocsError, AIOCS_ERROR_CODES } from './errors.js';

type CoverageEntry = {
  pageTitle: string;
  sectionTitle: string;
  markdown: string;
};

type CoverageCorpus = {
  sourceId: string;
  snapshotId: string;
  entries: CoverageEntry[];
};

type CoverageMatchType = 'page_title' | 'section_title' | 'body';

export type CoverageVerificationResult = {
  sourceId: string;
  snapshotId: string;
  complete: boolean;
  summary: {
    fileCount: number;
    headingCount: number;
    matchedHeadingCount: number;
    missingHeadingCount: number;
    matchCounts: {
      pageTitle: number;
      sectionTitle: number;
      body: number;
    };
  };
  files: Array<{
    referenceFile: string;
    headingCount: number;
    matchedHeadingCount: number;
    missingHeadingCount: number;
    missingHeadings: string[];
    matchCounts: {
      pageTitle: number;
      sectionTitle: number;
      body: number;
    };
  }>;
};

function normalizeText(value: string): string {
  return value
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractHeadings(markdown: string): string[] {
  const matches = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)];
  return matches
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function extractComparableLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}|\d+\.\s+|[-*+]\s+)/, '').trim())
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function classifyHeading(
  heading: string,
  pageTitles: Set<string>,
  sectionTitles: Set<string>,
  comparableMarkdownLines: Set<string>,
): CoverageMatchType | null {
  const normalizedHeading = normalizeText(heading);
  if (!normalizedHeading) {
    return null;
  }

  if (pageTitles.has(normalizedHeading)) {
    return 'page_title';
  }

  if (sectionTitles.has(normalizedHeading)) {
    return 'section_title';
  }

  if (comparableMarkdownLines.has(normalizedHeading)) {
    return 'body';
  }

  return null;
}

export async function verifyCoverageAgainstReferences(
  corpus: CoverageCorpus,
  referenceFiles: string[],
): Promise<CoverageVerificationResult> {
  if (referenceFiles.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      'At least one reference file is required for coverage verification.',
    );
  }

  const pageTitles = new Set(corpus.entries.map((entry) => normalizeText(entry.pageTitle)).filter(Boolean));
  const sectionTitles = new Set(corpus.entries.map((entry) => normalizeText(entry.sectionTitle)).filter(Boolean));
  const comparableMarkdownLines = new Set(
    corpus.entries.flatMap((entry) => extractComparableLines(entry.markdown)),
  );

  const files = [];
  let headingCount = 0;
  let matchedHeadingCount = 0;
  let missingHeadingCount = 0;
  const matchCounts = {
    pageTitle: 0,
    sectionTitle: 0,
    body: 0,
  };

  for (const referenceFile of referenceFiles) {
    const resolvedReferenceFile = resolve(referenceFile);
    let raw: string;
    try {
      raw = await readFile(resolvedReferenceFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new AiocsError(
          AIOCS_ERROR_CODES.referenceFileNotFound,
          `Reference file not found: ${resolvedReferenceFile}`,
        );
      }
      throw error;
    }

    const headings = extractHeadings(raw);
    if (headings.length === 0) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.invalidReferenceFile,
        `Reference file does not contain any markdown headings: ${resolvedReferenceFile}`,
      );
    }

    const fileMatchCounts = {
      pageTitle: 0,
      sectionTitle: 0,
      body: 0,
    };
    const missingHeadings: string[] = [];

    for (const heading of headings) {
      const matchType = classifyHeading(heading, pageTitles, sectionTitles, comparableMarkdownLines);
      if (matchType === 'page_title') {
        fileMatchCounts.pageTitle += 1;
        matchCounts.pageTitle += 1;
        matchedHeadingCount += 1;
      } else if (matchType === 'section_title') {
        fileMatchCounts.sectionTitle += 1;
        matchCounts.sectionTitle += 1;
        matchedHeadingCount += 1;
      } else if (matchType === 'body') {
        fileMatchCounts.body += 1;
        matchCounts.body += 1;
        matchedHeadingCount += 1;
      } else {
        missingHeadings.push(heading);
        missingHeadingCount += 1;
      }
    }

    headingCount += headings.length;
    files.push({
      referenceFile: resolvedReferenceFile,
      headingCount: headings.length,
      matchedHeadingCount: headings.length - missingHeadings.length,
      missingHeadingCount: missingHeadings.length,
      missingHeadings,
      matchCounts: fileMatchCounts,
    });
  }

  return {
    sourceId: corpus.sourceId,
    snapshotId: corpus.snapshotId,
    complete: missingHeadingCount === 0,
    summary: {
      fileCount: files.length,
      headingCount,
      matchedHeadingCount,
      missingHeadingCount,
      matchCounts,
    },
    files,
  };
}
