import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadSourceSpec } from '../../src/spec/source-spec.js';

describe('built-in source specs', () => {
  it('ships the bundled hyperliquid source spec and it validates', async () => {
    const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sources');
    const entries = readdirSync(sourcesDir).filter((entry) => entry.endsWith('.yaml')).sort();

    expect(entries).toEqual([
      'hyperliquid.yaml',
      'nktkas-hyperliquid.yaml',
    ]);

    const specs = await Promise.all(entries.map((entry) => loadSourceSpec(join(sourcesDir, entry))));
    expect(specs.map((spec) => spec.id)).toEqual([
      'hyperliquid',
      'nktkas-hyperliquid',
    ]);
  });
});
