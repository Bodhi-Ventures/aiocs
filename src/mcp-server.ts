#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AiocsError, AIOCS_ERROR_CODES, toAiocsError } from './errors.js';
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
  verifyCoverage,
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

const mcpErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

const coverageVerificationSchema = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  complete: z.boolean(),
  summary: z.object({
    fileCount: z.number().int().nonnegative(),
    headingCount: z.number().int().nonnegative(),
    matchedHeadingCount: z.number().int().nonnegative(),
    missingHeadingCount: z.number().int().nonnegative(),
    matchCounts: z.object({
      pageTitle: z.number().int().nonnegative(),
      sectionTitle: z.number().int().nonnegative(),
      body: z.number().int().nonnegative(),
    }),
  }),
  files: z.array(z.object({
    referenceFile: z.string(),
    headingCount: z.number().int().nonnegative(),
    matchedHeadingCount: z.number().int().nonnegative(),
    missingHeadingCount: z.number().int().nonnegative(),
    missingHeadings: z.array(z.string()),
    matchCounts: z.object({
      pageTitle: z.number().int().nonnegative(),
      sectionTitle: z.number().int().nonnegative(),
      body: z.number().int().nonnegative(),
    }),
  })),
});

const server = new McpServer({
  name: packageName,
  version: packageVersion,
  title: 'aiocs MCP server',
}, {
  instructions: `${packageDescription} Use the MCP tools for machine-readable local docs operations.`,
});

const toolInputSchemas = new Map<string, z.ZodTypeAny | undefined>();

function asToolResult<TData extends Record<string, unknown>>(data: TData) {
  const structuredContent = {
    ok: true as const,
    data,
  };

  return {
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
  };
}

function asToolError(error: unknown) {
  const normalized = toAiocsError(error);
  const structuredContent = {
    ok: false as const,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(typeof normalized.details !== 'undefined' ? { details: normalized.details } : {}),
    },
  };

  return {
    isError: true as const,
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
  };
}

type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>;

const toolHandlers: Record<string, ToolHandler> = {
  version: async () => ({
    name: packageName,
    version: packageVersion,
  }),
  doctor: async () => getDoctorReport(),
  init: async (args = {}) => initBuiltInSources({
    ...(typeof args.fetch === 'boolean' ? { fetch: args.fetch } : {}),
  }),
  source_upsert: async (args = {}) => upsertSourceFromSpecFile(args.specFile as string),
  source_list: async () => listSources(),
  fetch: async (args = {}) => fetchSources(args.sourceIdOrAll as string),
  refresh_due: async () => refreshDueSources(),
  snapshot_list: async (args = {}) => listSnapshotsForSource(args.sourceId as string),
  project_link: async (args = {}) =>
    linkProjectSources(args.projectPath as string, args.sourceIds as string[]),
  project_unlink: async (args = {}) =>
    unlinkProjectSources(args.projectPath as string, (args.sourceIds as string[] | undefined) ?? []),
  search: async (args = {}) => searchCatalog(args.query as string, {
    source: (args.sourceIds as string[] | undefined) ?? [],
    ...(typeof args.snapshotId === 'string' ? { snapshot: args.snapshotId } : {}),
    ...(typeof args.all === 'boolean' ? { all: args.all } : {}),
    ...(typeof args.project === 'string' ? { project: args.project } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
  }),
  show: async (args = {}) => showChunk(args.chunkId as number),
  verify_coverage: async (args = {}) =>
    verifyCoverage({
      sourceId: args.sourceId as string,
      referenceFiles: args.referenceFiles as string[],
      ...(typeof args.snapshotId === 'string' ? { snapshotId: args.snapshotId } : {}),
    }),
};

type ToolHandlerName = keyof typeof toolHandlers;
const batchableToolNames = Object.keys(toolHandlers) as ToolHandlerName[];

async function runToolHandler(
  name: ToolHandlerName,
  args: Record<string, unknown> | undefined,
) {
  return toolHandlers[name]!(args);
}

function registerAiocsTool<TArgs extends Record<string, unknown>, TData extends Record<string, unknown>>(
  name: ToolHandlerName,
  config: {
    title: string;
    description: string;
    inputSchema?: z.ZodType<TArgs>;
    outputSchema: z.ZodType<TData>;
  },
) {
  toolInputSchemas.set(name, config.inputSchema);

  server.registerTool(
    name,
    {
      ...config,
      outputSchema: z.object({
        ok: z.boolean(),
        data: config.outputSchema.optional(),
        error: mcpErrorSchema.optional(),
      }),
    },
    async (args) => {
      try {
        return asToolResult(await runToolHandler(name, args as Record<string, unknown> | undefined));
      } catch (error) {
        return asToolError(error);
      }
    },
  );
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function validateBatchOperationArguments(
  tool: ToolHandlerName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = toolInputSchemas.get(tool);
  if (!schema) {
    return args;
  }

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Invalid arguments for tool ${tool}: ${formatZodIssues(parsed.error)}`,
      {
        issues: parsed.error.issues,
      },
    );
  }

  return parsed.data as Record<string, unknown>;
}

registerAiocsTool(
  'version',
  {
    title: 'Version',
    description: 'Return the current aiocs package name and version.',
    outputSchema: z.object({
      name: z.string(),
      version: z.string(),
    }),
  },
);

registerAiocsTool(
  'doctor',
  {
    title: 'Doctor',
    description: 'Validate catalog, Playwright, daemon config, source-spec directories, and Docker readiness.',
    outputSchema: doctorReportSchema,
  },
);

registerAiocsTool(
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
);

registerAiocsTool(
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
);

registerAiocsTool(
  'source_list',
  {
    title: 'Source list',
    description: 'List all registered documentation sources.',
    outputSchema: z.object({
      sources: z.array(sourceSchema),
    }),
  },
);

registerAiocsTool(
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
);

registerAiocsTool(
  'refresh_due',
  {
    title: 'Refresh due',
    description: 'Fetch all sources whose schedule is currently due.',
    outputSchema: z.object({
      results: z.array(fetchResultSchema),
    }),
  },
);

registerAiocsTool(
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
);

registerAiocsTool(
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
);

registerAiocsTool(
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
);

registerAiocsTool(
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
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    outputSchema: z.object({
      query: z.string(),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      results: z.array(searchResultSchema),
    }),
  },
);

registerAiocsTool(
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
);

registerAiocsTool(
  'verify_coverage',
  {
    title: 'Verify coverage',
    description: 'Verify a fetched source snapshot against one or more reference markdown files.',
    inputSchema: z.object({
      sourceId: z.string(),
      referenceFiles: z.array(z.string()).min(1),
      snapshotId: z.string().optional(),
    }),
    outputSchema: coverageVerificationSchema,
  },
);

server.registerTool(
  'batch',
  {
    title: 'Batch',
    description: 'Execute multiple aiocs MCP operations in one call and return per-operation success or error results.',
    inputSchema: z.object({
      operations: z.array(z.object({
        tool: z.string().refine(
          (value): value is ToolHandlerName => batchableToolNames.includes(value as ToolHandlerName),
          {
            message: `tool must be one of: ${batchableToolNames.join(', ')}`,
          },
        ),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(25),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      data: z.object({
        results: z.array(z.object({
          index: z.number().int().nonnegative(),
          tool: z.string(),
          ok: z.boolean(),
          data: z.unknown().optional(),
          error: z.object({
            code: z.string(),
            message: z.string(),
            details: z.unknown().optional(),
          }).optional(),
        })),
      }).optional(),
      error: mcpErrorSchema.optional(),
    }),
  },
  async ({ operations }) => {
    try {
      const results = [];
      for (const [index, operation] of operations.entries()) {
        try {
          const validatedArgs = validateBatchOperationArguments(
            operation.tool,
            (operation.arguments ?? {}) as Record<string, unknown>,
          );
          const data = await runToolHandler(
            operation.tool,
            validatedArgs,
          );
          results.push({
            index,
            tool: operation.tool,
            ok: true,
            data,
          });
        } catch (error) {
          const normalized = toAiocsError(error);
          results.push({
            index,
            tool: operation.tool,
            ok: false,
            error: {
              code: normalized.code,
              message: normalized.message,
              ...(typeof normalized.details !== 'undefined' ? { details: normalized.details } : {}),
            },
          });
        }
      }

      return asToolResult({ results });
    } catch (error) {
      return asToolError(error);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
