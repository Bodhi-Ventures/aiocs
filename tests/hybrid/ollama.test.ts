import { afterEach, describe, expect, it, vi } from 'vitest';

import { embedTexts, prepareTextForEmbedding } from '../../src/hybrid/ollama.js';
import type { HybridRuntimeConfig } from '../../src/runtime/hybrid-config.js';

const baseConfig: HybridRuntimeConfig = {
  defaultSearchMode: 'auto',
  qdrantUrl: 'http://127.0.0.1:6333',
  qdrantCollection: 'aiocs_docs_chunks',
  qdrantTimeoutMs: 1_000,
  embeddingProvider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  ollamaTimeoutMs: 1_000,
  ollamaMaxInputChars: 4_000,
  embeddingBatchSize: 16,
  embeddingJobsPerCycle: 2,
  lexicalCandidateWindow: 20,
  vectorCandidateWindow: 20,
  rrfK: 60,
};

describe('ollama embedding client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes and truncates markdown before sending it to Ollama', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[0.1, 0.2, 0.3]],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const longMarkdown = [
      '<!-- source: https://example.com/docs -->',
      '# Orders',
      '',
      '[Reference](https://example.com) and `inline code`.',
      '',
      '```ts',
      'const maker = true;',
      '```',
      '',
      'x'.repeat(5_000),
    ].join('\n');

    await embedTexts(baseConfig, [longMarkdown]);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(request?.body)) as { input: string[] };
    expect(payload.input).toHaveLength(1);
    expect(payload.input[0]).not.toContain('<!-- source:');
    expect(payload.input[0]).not.toContain('[Reference]');
    expect(payload.input[0]).toContain('Reference and inline code.');
    expect(payload.input[0]?.length).toBeLessThanOrEqual(4_000);
  });

  it('prepares text with portable truncation boundaries', () => {
    const prepared = prepareTextForEmbedding(`# Title\n\n${'word '.repeat(2_000)}`, 4_000);
    expect(prepared.length).toBeLessThanOrEqual(4_000);
    expect(prepared).toContain('# Title');
    expect(prepared.endsWith(' ')).toBe(false);
  });
});
