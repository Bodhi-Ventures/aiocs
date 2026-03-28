import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyCoverageAgainstReferences } from '../../src/coverage.js';

describe('coverage verification', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-coverage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not treat body substrings as complete heading matches', async () => {
    const referencePath = join(root, 'reference.md');
    writeFileSync(referencePath, '# API\n', 'utf8');

    const result = await verifyCoverageAgainstReferences(
      {
        sourceId: 'example',
        snapshotId: 'snapshot-1',
        entries: [
          {
            pageTitle: 'Capabilities',
            sectionTitle: 'Overview',
            markdown: '# Capabilities\n\nThis page explains capability limits.',
          },
        ],
      },
      [referencePath],
    );

    expect(result.complete).toBe(false);
    expect(result.summary.missingHeadingCount).toBe(1);
    expect(result.files[0]?.missingHeadings).toEqual(['API']);
  });
});
