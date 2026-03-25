import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSourceSpec } from '../../src/spec/source-spec.js';

describe('built-in source specs', () => {
  it('ships the five initial source specs and all of them validate', async () => {
    const sourcesDir = '/Users/jmucha/repos/mandex/aiocs/sources';
    const entries = readdirSync(sourcesDir).filter((entry) => entry.endsWith('.yaml')).sort();

    expect(entries).toEqual([
      'ethereal.yaml',
      'hyperliquid.yaml',
      'lighter.yaml',
      'nado.yaml',
      'synthetix.yaml',
    ]);

    const specs = await Promise.all(entries.map((entry) => loadSourceSpec(join(sourcesDir, entry))));
    expect(specs.map((spec) => spec.id)).toEqual([
      'ethereal',
      'hyperliquid',
      'lighter',
      'nado',
      'synthetix',
    ]);
  });
});
