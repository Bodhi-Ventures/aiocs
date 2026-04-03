import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startDocsServer } from '../helpers/docs-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcMcpPath = `${repoRoot}/src/mcp-server.ts`;

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

describe('workspace MCP tools', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-mcp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exposes workspace operations over MCP', async () => {
    const docsServer = await startDocsServer();
    const specPath = join(root, 'workspace-mcp.yaml');

    writeFileSync(specPath, `
id: workspace-mcp
label: Workspace MCP
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

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', srcMcpPath],
      cwd: repoRoot,
      env: stringEnv({
        AIOCS_DATA_DIR: join(root, 'data'),
        AIOCS_CONFIG_DIR: join(root, 'config'),
      }),
      stderr: 'pipe',
    });
    const client = new Client({
      name: 'aiocs-workspace-test-client',
      version: '0.0.0-test',
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'workspace_create',
        'workspace_list',
        'workspace_bind',
        'workspace_status',
        'workspace_search',
        'workspace_artifact_list',
        'workspace_lint',
      ]));

      await client.callTool({
        name: 'source_upsert',
        arguments: {
          specFile: specPath,
        },
      });
      await client.callTool({
        name: 'refresh_due',
        arguments: {
          sourceIdOrAll: 'workspace-mcp',
        },
      });

      const create = await client.callTool({
        name: 'workspace_create',
        arguments: {
          workspaceId: 'mcp-research',
          label: 'MCP Research',
        },
      });
      expect(toolData<{ workspace: { id: string } }>(create)).toEqual({
        workspace: expect.objectContaining({
          id: 'mcp-research',
        }),
      });

      await client.callTool({
        name: 'workspace_bind',
        arguments: {
          workspaceId: 'mcp-research',
          sourceIds: ['workspace-mcp'],
        },
      });

      const status = await client.callTool({
        name: 'workspace_status',
        arguments: {
          workspaceId: 'mcp-research',
        },
      });
      expect(toolData<{ workspace: { id: string }; artifacts: Array<{ path: string }> }>(status)).toMatchObject({
        workspace: {
          id: 'mcp-research',
        },
        artifacts: [],
      });

      const search = await client.callTool({
        name: 'workspace_search',
        arguments: {
          workspaceId: 'mcp-research',
          query: 'maker flow',
          scope: 'source',
        },
      });
      expect(toolData<{ workspaceId: string; results: Array<{ scope: string }> }>(search)).toMatchObject({
        workspaceId: 'mcp-research',
        results: expect.arrayContaining([
          expect.objectContaining({
            scope: 'source',
          }),
        ]),
      });

      const lint = await client.callTool({
        name: 'workspace_lint',
        arguments: {
          workspaceId: 'mcp-research',
        },
      });
      expect(toolData<{ summary: { status: string } }>(lint)).toMatchObject({
        summary: {
          status: 'warn',
        },
      });
    } finally {
      await client.close();
      await docsServer.close();
    }
  }, 30_000);
});
