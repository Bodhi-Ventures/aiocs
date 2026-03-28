import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { loadSourceSpec } from '../../src/spec/source-spec.js';

describe('loadSourceSpec', () => {
  it('loads and validates a YAML source spec', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiocs-source-spec-'));
    const specPath = join(root, 'hyperliquid.yaml');

    writeFileSync(specPath, `
id: hyperliquid
label: Hyperliquid Docs
startUrls:
  - https://hyperliquid.gitbook.io/hyperliquid-docs
allowedHosts:
  - hyperliquid.gitbook.io
discovery:
  include:
    - https://hyperliquid.gitbook.io/hyperliquid-docs/**
  exclude:
    - https://hyperliquid.gitbook.io/hyperliquid-docs/changelog/**
  maxPages: 250
extract:
  strategy: clipboardButton
  interactions:
    - action: click
      selector: button[aria-label="Copy page"]
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
`);

    try {
      const spec = await loadSourceSpec(specPath);

      expect(spec.id).toBe('hyperliquid');
      expect(spec.extract.strategy).toBe('clipboardButton');
      expect(spec.discovery.maxPages).toBe(250);
      expect(spec.schedule.everyHours).toBe(24);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid schedule and missing crawl bounds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiocs-source-spec-invalid-'));
    const specPath = join(root, 'broken.yaml');

    writeFileSync(specPath, `
id: broken
label: Broken
startUrls:
  - https://example.com/docs
allowedHosts:
  - example.com
discovery:
  include:
    - https://example.com/docs/**
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 0
`);

    try {
      await expect(loadSourceSpec(specPath)).rejects.toThrow(/everyHours|maxPages/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads authenticated fetch and canary configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiocs-source-spec-auth-'));
    const specPath = join(root, 'private-docs.yaml');

    writeFileSync(specPath, `
id: private-docs
label: Private Docs
startUrls:
  - https://docs.example.com/start
allowedHosts:
  - docs.example.com
discovery:
  include:
    - https://docs.example.com/**
  exclude: []
  maxPages: 50
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
auth:
  headers:
    - name: authorization
      valueFromEnv: AIOCS_DOCS_TOKEN
      hosts:
        - docs.example.com
      include:
        - https://docs.example.com/private/**
  cookies:
    - name: session
      valueFromEnv: AIOCS_DOCS_SESSION
      domain: docs.example.com
      path: /
      httpOnly: true
canary:
  everyHours: 6
  checks:
    - url: https://docs.example.com/start
      expectedTitle: Private Docs Start
      expectedText: Secret market structure docs
      minMarkdownLength: 40
`);

    try {
      const spec = await loadSourceSpec(specPath);

      expect(spec.auth).toEqual({
        headers: [
          {
            name: 'authorization',
            valueFromEnv: 'AIOCS_DOCS_TOKEN',
            hosts: ['docs.example.com'],
            include: ['https://docs.example.com/private/**'],
          },
        ],
        cookies: [
          {
            name: 'session',
            valueFromEnv: 'AIOCS_DOCS_SESSION',
            domain: 'docs.example.com',
            path: '/',
            httpOnly: true,
          },
        ],
      });
      expect(spec.canary).toEqual({
        everyHours: 6,
        checks: [
          {
            url: 'https://docs.example.com/start',
            expectedTitle: 'Private Docs Start',
            expectedText: 'Secret market structure docs',
            minMarkdownLength: 40,
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects authenticated header hosts that are outside the source allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiocs-source-spec-auth-invalid-'));
    const specPath = join(root, 'private-docs.yaml');

    writeFileSync(specPath, `
id: private-docs
label: Private Docs
startUrls:
  - https://docs.example.com/start
allowedHosts:
  - docs.example.com
discovery:
  include:
    - https://docs.example.com/**
  exclude: []
  maxPages: 50
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
auth:
  headers:
    - name: authorization
      valueFromEnv: AIOCS_DOCS_TOKEN
      hosts:
        - cdn.example.com
`);

    try {
      await expect(loadSourceSpec(specPath)).rejects.toThrow(/must be included in allowedHosts/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
