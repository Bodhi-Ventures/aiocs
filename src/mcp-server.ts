#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { packageDescription, packageName, packageVersion } from './runtime/package-metadata.js';
import {
  fetchSources,
  getDoctorReport,
  initBuiltInSources,
  linkProjectSources,
  listSnapshotsForSource,
  listSources,
  refreshDueSources,
  searchCatalog,
  showChunk,
  unlinkProjectSources,
  upsertSourceFromSpecFile,
} from './services.js';

const doctorCheckSchema = z.object({
  id: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const doctorReportSchema = z.object({
  summary: z.object({
    status: z.enum(['healthy', 'degraded', 'unhealthy']),
    checkCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    warnCount: z.number().int().nonnegative(),
    failCount: z.number().int().nonnegative(),
  }),
  checks: z.array(doctorCheckSchema),
});

const sourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  nextDueAt: z.string(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessfulSnapshotId: z.string().nullable(),
});

const fetchResultSchema = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  pageCount: z.number().int().nonnegative(),
  reused: z.boolean(),
});

const searchResultSchema = z.object({
  chunkId: z.number().int().nonnegative(),
  sourceId: z.string(),
  snapshotId: z.string(),
  pageUrl: z.string(),
  pageTitle: z.string(),
  sectionTitle: z.string(),
  markdown: z.string(),
});

const server = new McpServer({
  name: packageName,
  version: packageVersion,
  title: 'aiocs MCP server',
}, {
  instructions: `${packageDescription} Use the MCP tools for machine-readable local docs operations.`,
});

function asToolResult<TData extends Record<string, unknown>>(data: TData) {
  return {
    structuredContent: data,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

server.registerTool(
  'version',
  {
    title: 'Version',
    description: 'Return the current aiocs package name and version.',
    outputSchema: z.object({
      name: z.string(),
      version: z.string(),
    }),
  },
  async () => asToolResult({
    name: packageName,
    version: packageVersion,
  }),
);

server.registerTool(
  'doctor',
  {
    title: 'Doctor',
    description: 'Validate catalog, Playwright, daemon config, source-spec directories, and Docker readiness.',
    outputSchema: doctorReportSchema,
  },
  async () => asToolResult(await getDoctorReport()),
);

server.registerTool(
  'init',
  {
    title: 'Init',
    description: 'Bootstrap the bundled built-in source specs and optionally fetch them.',
    inputSchema: z.object({
      fetch: z.boolean().optional(),
    }),
    outputSchema: z.object({
      sourceSpecDir: z.string(),
      fetched: z.boolean(),
      initializedSources: z.array(z.object({
        sourceId: z.string(),
        specPath: z.string(),
        configHash: z.string(),
        configChanged: z.boolean(),
      })),
      removedSourceIds: z.array(z.string()),
      fetchResults: z.array(fetchResultSchema),
    }),
  },
  async ({ fetch = false }) => asToolResult(await initBuiltInSources({ fetch })),
);

server.registerTool(
  'source_upsert',
  {
    title: 'Source upsert',
    description: 'Load or update a source spec file in the local catalog.',
    inputSchema: z.object({
      specFile: z.string(),
    }),
    outputSchema: z.object({
      sourceId: z.string(),
      configHash: z.string(),
      specPath: z.string(),
    }),
  },
  async ({ specFile }) => asToolResult(await upsertSourceFromSpecFile(specFile)),
);

server.registerTool(
  'source_list',
  {
    title: 'Source list',
    description: 'List all registered documentation sources.',
    outputSchema: z.object({
      sources: z.array(sourceSchema),
    }),
  },
  async () => asToolResult(await listSources()),
);

server.registerTool(
  'fetch',
  {
    title: 'Fetch',
    description: 'Fetch one source or all registered sources and record a snapshot.',
    inputSchema: z.object({
      sourceIdOrAll: z.string(),
    }),
    outputSchema: z.object({
      results: z.array(fetchResultSchema),
    }),
  },
  async ({ sourceIdOrAll }) => asToolResult(await fetchSources(sourceIdOrAll)),
);

server.registerTool(
  'refresh_due',
  {
    title: 'Refresh due',
    description: 'Fetch all sources whose schedule is currently due.',
    outputSchema: z.object({
      results: z.array(fetchResultSchema),
    }),
  },
  async () => asToolResult(await refreshDueSources()),
);

server.registerTool(
  'snapshot_list',
  {
    title: 'Snapshot list',
    description: 'List recorded snapshots for a source.',
    inputSchema: z.object({
      sourceId: z.string(),
    }),
    outputSchema: z.object({
      sourceId: z.string(),
      snapshots: z.array(z.object({
        snapshotId: z.string(),
        sourceId: z.string(),
        detectedVersion: z.string().nullable(),
        createdAt: z.string(),
        pageCount: z.number().int().nonnegative(),
      })),
    }),
  },
  async ({ sourceId }) => asToolResult(await listSnapshotsForSource(sourceId)),
);

server.registerTool(
  'project_link',
  {
    title: 'Project link',
    description: 'Link one or more sources to a project path for scoped search.',
    inputSchema: z.object({
      projectPath: z.string(),
      sourceIds: z.array(z.string()).min(1),
    }),
    outputSchema: z.object({
      projectPath: z.string(),
      sourceIds: z.array(z.string()),
    }),
  },
  async ({ projectPath, sourceIds }) => asToolResult(await linkProjectSources(projectPath, sourceIds)),
);

server.registerTool(
  'project_unlink',
  {
    title: 'Project unlink',
    description: 'Remove one or more source links from a project path.',
    inputSchema: z.object({
      projectPath: z.string(),
      sourceIds: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      projectPath: z.string(),
      sourceIds: z.array(z.string()),
    }),
  },
  async ({ projectPath, sourceIds }) => asToolResult(await unlinkProjectSources(projectPath, sourceIds ?? [])),
);

server.registerTool(
  'search',
  {
    title: 'Search',
    description: 'Search the shared aiocs catalog by query and optional scope filters.',
    inputSchema: z.object({
      query: z.string(),
      sourceIds: z.array(z.string()).optional(),
      snapshotId: z.string().optional(),
      all: z.boolean().optional(),
      project: z.string().optional(),
    }),
    outputSchema: z.object({
      query: z.string(),
      results: z.array(searchResultSchema),
    }),
  },
  async ({ query, sourceIds, snapshotId, all, project }) => asToolResult(await searchCatalog(query, {
    source: sourceIds ?? [],
    ...(snapshotId ? { snapshot: snapshotId } : {}),
    ...(all !== undefined ? { all } : {}),
    ...(project ? { project } : {}),
  })),
);

server.registerTool(
  'show',
  {
    title: 'Show',
    description: 'Return a specific chunk by numeric chunk id.',
    inputSchema: z.object({
      chunkId: z.number().int().nonnegative(),
    }),
    outputSchema: z.object({
      chunk: searchResultSchema,
    }),
  },
  async ({ chunkId }) => asToolResult(await showChunk(chunkId)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
