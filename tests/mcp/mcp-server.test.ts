import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { startDocsServer } from '../helpers/docs-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distMcpPath = `${repoRoot}/dist/mcp-server.js`;

function writeSourceSpec(specPath: string, id: string, label: string) {
  writeFileSync(specPath, `
id: ${id}
label: ${label}
startUrls:
  - https://example.test/${id}
allowedHosts:
  - example.test
discovery:
  include:
    - https://example.test/${id}/**
  exclude: []
  maxPages: 5
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
`);
}

function seedUserManagedSourceSpecs(userSourceDir: string) {
  mkdirSync(userSourceDir, { recursive: true });
  writeSourceSpec(join(userSourceDir, 'ethereal.yaml'), 'ethereal', 'Ethereal Docs');
  writeSourceSpec(join(userSourceDir, 'lighter.yaml'), 'lighter', 'Lighter Docs');
  writeSourceSpec(join(userSourceDir, 'nado.yaml'), 'nado', 'Nado Docs');
  writeSourceSpec(join(userSourceDir, 'synthetix.yaml'), 'synthetix', 'Synthetix Docs');
}

function writeSourceContextFile(contextPath: string, baseUrl: string) {
  writeFileSync(contextPath, `
purpose: Selector docs for trading workflows
summary: Use these pages for maker-flow and auth style docs lookups.
topicHints:
  - maker flow
  - authentication
commonLocations:
  - label: Maker flow entry
    url: ${baseUrl}/selector/start
    note: Starts the selector documentation flow.
gotchas:
  - Read the full page before answering from isolated chunks.
authNotes:
  - Check the auth page first when the question is about API setup.
`);
}

function stringEnv(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      ...extra,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function toolData<T>(result: Record<string, unknown>): T {
  return (result.structuredContent as { ok: true; data: T }).data;
}

describe('mcp server', () => {
  let root: string;

  beforeAll(async () => {
    const { execa } = await import('execa');
    await execa('pnpm', ['build'], {
      cwd: repoRoot,
    });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-mcp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the shared aiocs operations over stdio MCP', async () => {
    const docsServer = await startDocsServer();
    const specPath = join(root, 'mcp-selector.yaml');
    const contextPath = join(root, 'mcp-selector-context.yaml');
    const projectPath = join(root, 'workspace', 'desk');
    const userSourceDir = join(root, 'user-sources');
    mkdirSync(projectPath, { recursive: true });
    seedUserManagedSourceSpecs(userSourceDir);

    writeFileSync(specPath, `
id: mcp-selector
label: MCP selector
startUrls:
  - ${docsServer.baseUrl}/selector/start
allowedHosts:
  - 127.0.0.1
discovery:
  include:
    - ${docsServer.baseUrl}/selector/**
  exclude: []
  maxPages: 10
extract:
  strategy: selector
  selector: article
normalize:
  prependSourceComment: true
schedule:
  everyHours: 24
`);
    writeSourceContextFile(contextPath, docsServer.baseUrl);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distMcpPath],
      cwd: repoRoot,
      env: stringEnv({
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
        AIOCS_SOURCES_DIR: userSourceDir,
      }),
      stderr: 'pipe',
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    const client = new Client({
      name: 'aiocs-test-client',
      version: '0.0.0-test',
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'version',
        'doctor',
        'init',
        'source_upsert',
        'source_list',
        'source_describe',
        'source_context_show',
        'source_context_upsert',
        'fetch',
        'canary',
        'refresh_due',
        'snapshot_list',
        'diff_snapshots',
        'page_list',
        'page_show',
        'project_link',
        'project_unlink',
        'search',
        'retrieve_context',
        'show',
        'learning_save',
        'learning_list',
        'backup_export',
        'backup_import',
        'verify_coverage',
        'batch',
      ]));

      const version = await client.callTool({
        name: 'version',
        arguments: {},
      });
      expect(toolData<{ name: string; version: string }>(version)).toEqual({
        name: '@bodhi-ventures/aiocs',
        version: packageJson.version,
      });

      const doctor = await client.callTool({
        name: 'doctor',
        arguments: {},
      });
      expect(toolData<{ summary: { status: string } }>(doctor)).toMatchObject({
        summary: {
          status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
        },
      });

      const init = await client.callTool({
        name: 'init',
        arguments: {
          fetch: false,
        },
      });
      expect(toolData<{ initializedSources: Array<{ sourceId: string }>; sourceSpecDirs: string[]; userSourceDir: string }>(init)).toMatchObject({
        sourceSpecDirs: expect.arrayContaining([
          join(repoRoot, 'sources'),
          userSourceDir,
        ]),
        userSourceDir,
        initializedSources: expect.arrayContaining([
          expect.objectContaining({ sourceId: 'ethereal' }),
          expect.objectContaining({ sourceId: 'hyperliquid' }),
          expect.objectContaining({ sourceId: 'lighter' }),
          expect.objectContaining({ sourceId: 'nado' }),
          expect.objectContaining({ sourceId: 'synthetix' }),
        ]),
      });

      const upsert = await client.callTool({
        name: 'source_upsert',
        arguments: {
          specFile: specPath,
        },
      });
      expect(toolData<{ sourceId: string }>(upsert)).toMatchObject({
        sourceId: 'mcp-selector',
      });

      const contextUpsert = await client.callTool({
        name: 'source_context_upsert',
        arguments: {
          sourceId: 'mcp-selector',
          contextFile: contextPath,
        },
      });
      expect(toolData<{ sourceId: string; contextFile: string }>(contextUpsert)).toMatchObject({
        sourceId: 'mcp-selector',
        contextFile: contextPath,
      });

      const sourceList = await client.callTool({
        name: 'source_list',
        arguments: {},
      });
      expect(toolData<{
        sources: Array<{
          id: string;
          specPath: string | null;
          isDue: boolean;
          isCanaryDue: boolean;
        }>;
      }>(sourceList)).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({
            id: 'mcp-selector',
            specPath,
            isDue: true,
            isCanaryDue: true,
          }),
        ]),
      });

      const sourceDescribe = await client.callTool({
        name: 'source_describe',
        arguments: {
          sourceId: 'mcp-selector',
        },
      });
      expect(toolData<{
        source: { id: string };
        context: { context: { topicHints: string[] } | null };
        recentLearnings: Array<unknown>;
      }>(sourceDescribe)).toMatchObject({
        source: {
          id: 'mcp-selector',
        },
        context: {
          context: {
            topicHints: expect.arrayContaining(['maker flow']),
          },
        },
        recentLearnings: [],
      });

      const sourceContextShow = await client.callTool({
        name: 'source_context_show',
        arguments: {
          sourceId: 'mcp-selector',
        },
      });
      expect(toolData<{
        sourceId: string;
        context: { commonLocations: Array<{ url?: string }> } | null;
      }>(sourceContextShow)).toMatchObject({
        sourceId: 'mcp-selector',
        context: {
          commonLocations: [
            expect.objectContaining({
              url: `${docsServer.baseUrl}/selector/start`,
            }),
          ],
        },
      });

      const link = await client.callTool({
        name: 'project_link',
        arguments: {
          projectPath,
          sourceIds: ['mcp-selector'],
        },
      });
      expect(toolData<{ projectPath: string; sourceIds: string[] }>(link)).toEqual({
        projectPath,
        sourceIds: ['mcp-selector'],
      });

      const refreshDue = await client.callTool({
        name: 'refresh_due',
        arguments: {
          sourceIdOrAll: 'mcp-selector',
        },
      });
      expect(toolData<{ results: Array<{ sourceId: string; pageCount: number }> }>(refreshDue)).toMatchObject({
        results: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
            pageCount: 2,
          }),
        ],
      });

      const refreshDueAgain = await client.callTool({
        name: 'refresh_due',
        arguments: {
          sourceIdOrAll: 'mcp-selector',
        },
      });
      expect(toolData<{ results: Array<unknown> }>(refreshDueAgain)).toEqual({
        results: [],
      });

      const pageList = await client.callTool({
        name: 'page_list',
        arguments: {
          sourceId: 'mcp-selector',
          query: 'selector',
          limit: 10,
          offset: 0,
        },
      });
      expect(toolData<{
        sourceId: string;
        total: number;
        pages: Array<{ url: string; title: string }>;
      }>(pageList)).toMatchObject({
        sourceId: 'mcp-selector',
        total: 2,
        pages: expect.arrayContaining([
          expect.objectContaining({
            url: `${docsServer.baseUrl}/selector/start`,
            title: 'Selector Start',
          }),
        ]),
      });

      const pageShow = await client.callTool({
        name: 'page_show',
        arguments: {
          sourceId: 'mcp-selector',
          url: `${docsServer.baseUrl}/selector/start`,
        },
      });
      expect(toolData<{
        sourceId: string;
        page: { markdown: string; title: string };
      }>(pageShow)).toMatchObject({
        sourceId: 'mcp-selector',
        page: {
          title: 'Selector Start',
          markdown: expect.stringContaining('Maker flow documentation starts here.'),
        },
      });

      const learningSave = await client.callTool({
        name: 'learning_save',
        arguments: {
          sourceId: 'mcp-selector',
          learningType: 'discovery',
          intent: 'maker flow',
          pageUrl: `${docsServer.baseUrl}/selector/start`,
          title: 'Selector Start',
          note: 'Start here for maker flow questions.',
          searchTerms: ['maker flow', 'selector'],
        },
      });
      expect(toolData<{
        learning: { sourceId: string; learningType: string; intent: string };
      }>(learningSave)).toMatchObject({
        learning: {
          sourceId: 'mcp-selector',
          learningType: 'discovery',
          intent: 'maker flow',
        },
      });

      const learningList = await client.callTool({
        name: 'learning_list',
        arguments: {
          sourceId: 'mcp-selector',
          intentQuery: 'maker',
          limit: 5,
        },
      });
      expect(toolData<{
        learnings: Array<{ sourceId: string; pageUrl: string | null; intent: string }>;
      }>(learningList)).toMatchObject({
        learnings: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
            pageUrl: `${docsServer.baseUrl}/selector/start`,
            intent: 'maker flow',
          }),
        ],
      });

      const search = await client.callTool({
        name: 'search',
        arguments: {
          query: 'selector',
          project: projectPath,
          limit: 1,
          offset: 0,
        },
      });
      const searchData = toolData<{
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        results: Array<{ chunkId: number; sourceId: string }>;
      }>(search);
      expect(searchData.total).toBe(2);
      expect(searchData.limit).toBe(1);
      expect(searchData.offset).toBe(0);
      expect(searchData.hasMore).toBe(true);
      expect(searchData.results[0]).toMatchObject({
        sourceId: 'mcp-selector',
      });

      const retrieveContextResult = await client.callTool({
        name: 'retrieve_context',
        arguments: {
          query: 'maker flow',
          project: projectPath,
          pageLimit: 2,
          limit: 5,
          offset: 0,
          mode: 'lexical',
        },
      });
      expect(toolData<{
        sourceScope: string[];
        sourceHints: Array<{ sourceId: string }>;
        matchedLearnings: Array<{ sourceId: string; intent: string }>;
        pages: Array<{ sourceId: string; url: string; markdown: string }>;
      }>(retrieveContextResult)).toMatchObject({
        sourceScope: ['mcp-selector'],
        sourceHints: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
          }),
        ],
        matchedLearnings: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
            intent: 'maker flow',
          }),
        ],
        pages: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
            url: `${docsServer.baseUrl}/selector/start`,
            markdown: expect.stringContaining('Maker flow documentation starts here.'),
          }),
        ],
      });

      const show = await client.callTool({
        name: 'show',
        arguments: {
          chunkId: searchData.results[0]?.chunkId,
        },
      });
      expect(toolData<{ chunk: { markdown: string } }>(show).chunk.markdown).toContain('Maker flow documentation starts here.');

      const canary = await client.callTool({
        name: 'canary',
        arguments: {
          sourceIdOrAll: 'mcp-selector',
        },
      });
      expect(toolData<{ results: Array<{ sourceId: string; status: string }> }>(canary)).toMatchObject({
        results: [
          expect.objectContaining({
            sourceId: 'mcp-selector',
            status: 'pass',
          }),
        ],
      });

      const diff = await client.callTool({
        name: 'diff_snapshots',
        arguments: {
          sourceId: 'mcp-selector',
        },
      });
      expect((diff.structuredContent as { ok: false; error: { code: string } }).error.code).toBe('SNAPSHOT_DIFF_BASE_NOT_FOUND');

      const backupDir = join(root, 'backup-output');
      const backupExport = await client.callTool({
        name: 'backup_export',
        arguments: {
          outputDir: backupDir,
        },
      });
      expect(toolData<{ outputDir: string; manifestPath: string }>(backupExport)).toMatchObject({
        outputDir: backupDir,
        manifestPath: `${backupDir}/manifest.json`,
      });

      const referencePath = join(root, 'mcp-reference.md');
      writeFileSync(referencePath, `
# Selector Start
# Selector Next
# Missing Heading
`);

      const verifyCoverage = await client.callTool({
        name: 'verify_coverage',
        arguments: {
          sourceId: 'mcp-selector',
          referenceFiles: [referencePath],
        },
      });
      expect(toolData<{
        sourceId: string;
        complete: boolean;
        summary: { missingHeadingCount: number };
      }>(verifyCoverage)).toMatchObject({
        sourceId: 'mcp-selector',
        complete: false,
        summary: {
          missingHeadingCount: 1,
        },
      });

      const missingShow = await client.callTool({
        name: 'show',
        arguments: {
          chunkId: 99999,
        },
      });
      expect(missingShow.isError).toBe(true);
      expect(missingShow.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: 'CHUNK_NOT_FOUND',
          message: 'Chunk 99999 not found',
        },
      });
      expect((missingShow.structuredContent as {
        ok: false;
        error: { code: string; message: string };
      }).error.code).toBe('CHUNK_NOT_FOUND');

      const batch = await client.callTool({
        name: 'batch',
        arguments: {
          operations: [
            {
              tool: 'version',
            },
            {
              tool: 'show',
              arguments: {
                chunkId: 99999,
              },
            },
            {
              tool: 'show',
              arguments: {},
            },
          ],
        },
      });
      expect(toolData<{
        results: Array<{
          tool: string;
          ok: boolean;
          data?: unknown;
          error?: { code: string; message: string };
        }>;
      }>(batch)).toMatchObject({
        results: [
          {
            tool: 'version',
            ok: true,
            data: {
              name: '@bodhi-ventures/aiocs',
              version: packageJson.version,
            },
          },
          {
            tool: 'show',
            ok: false,
            error: {
              code: 'CHUNK_NOT_FOUND',
              message: 'Chunk 99999 not found',
            },
          },
          {
            tool: 'show',
            ok: false,
            error: {
              code: 'INVALID_ARGUMENT',
            },
          },
        ],
      });
    } finally {
      await client.close();
      await docsServer.close();
    }

    expect(stderrChunks.join('')).toBe('');
  }, 30_000);
});
