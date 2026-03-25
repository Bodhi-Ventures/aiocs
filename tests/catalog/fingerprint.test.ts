import { describe, expect, it } from 'vitest';

import { buildSnapshotFingerprint } from '../../src/catalog/fingerprint.js';

describe('buildSnapshotFingerprint', () => {
  it('is stable regardless of page order', () => {
    const first = buildSnapshotFingerprint({
      sourceId: 'hyperliquid',
      configHash: 'config-a',
      pages: [
        { url: 'https://example.com/b', contentHash: 'b' },
        { url: 'https://example.com/a', contentHash: 'a' },
      ],
    });

    const second = buildSnapshotFingerprint({
      sourceId: 'hyperliquid',
      configHash: 'config-a',
      pages: [
        { url: 'https://example.com/a', contentHash: 'a' },
        { url: 'https://example.com/b', contentHash: 'b' },
      ],
    });

    expect(first).toBe(second);
  });

  it('changes when config or page content changes', () => {
    const baseline = buildSnapshotFingerprint({
      sourceId: 'hyperliquid',
      configHash: 'config-a',
      pages: [{ url: 'https://example.com/a', contentHash: 'a' }],
    });

    const changedConfig = buildSnapshotFingerprint({
      sourceId: 'hyperliquid',
      configHash: 'config-b',
      pages: [{ url: 'https://example.com/a', contentHash: 'a' }],
    });

    const changedPage = buildSnapshotFingerprint({
      sourceId: 'hyperliquid',
      configHash: 'config-a',
      pages: [{ url: 'https://example.com/a', contentHash: 'b' }],
    });

    expect(changedConfig).not.toBe(baseline);
    expect(changedPage).not.toBe(baseline);
  });
});
