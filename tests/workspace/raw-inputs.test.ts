import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractCsvInput,
  extractJsonInput,
  extractJsonlInput,
} from '../../src/workspace/raw-inputs.js';

describe('workspace dataset raw input extraction', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-raw-inputs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts csv datasets into schema and row chunks', async () => {
    const csvPath = join(root, 'fills.csv');
    writeFileSync(csvPath, 'symbol,venue,volume\nBTC,hyperliquid,123\nETH,nado,45\n');

    const extraction = await extractCsvInput({
      absolutePath: csvPath,
      label: 'Fills CSV',
    });

    expect(extraction.kind).toBe('csv');
    expect(extraction.metadata).toEqual(expect.objectContaining({
      absolutePath: csvPath,
      rowCount: 2,
      columnCount: 3,
      columns: ['symbol', 'venue', 'volume'],
    }));
    expect(extraction.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('hyperliquid');
    expect(extraction.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('volume');
  });

  it('extracts json manifests and jsonl datasets into searchable chunks', async () => {
    const jsonPath = join(root, 'manifest.json');
    const jsonlPath = join(root, 'events.jsonl');
    writeFileSync(jsonPath, JSON.stringify({
      project: 'research-desk',
      bindings: ['hyperliquid', 'nado'],
      refreshHours: 24,
    }, null, 2));
    writeFileSync(jsonlPath, [
      JSON.stringify({ symbol: 'BTC', venue: 'hyperliquid', volume: 123 }),
      JSON.stringify({ symbol: 'ETH', venue: 'nado', volume: 45 }),
    ].join('\n'));

    const jsonExtraction = await extractJsonInput({
      absolutePath: jsonPath,
      label: 'Manifest JSON',
    });
    const jsonlExtraction = await extractJsonlInput({
      absolutePath: jsonlPath,
      label: 'Events JSONL',
    });

    expect(jsonExtraction.kind).toBe('json');
    expect(jsonExtraction.metadata).toEqual(expect.objectContaining({
      absolutePath: jsonPath,
      topLevelType: 'object',
    }));
    expect(jsonExtraction.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('research-desk');

    expect(jsonlExtraction.kind).toBe('jsonl');
    expect(jsonlExtraction.metadata).toEqual(expect.objectContaining({
      absolutePath: jsonlPath,
      rowCount: 2,
      topLevelType: 'jsonl',
    }));
    expect(jsonlExtraction.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('BTC');
    expect(jsonlExtraction.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('nado');
  });
});
