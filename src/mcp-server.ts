#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AiocsError, AIOCS_ERROR_CODES, toAiocsError } from './errors.js';
import { packageDescription, packageName, packageVersion } from './runtime/package-metadata.js';
import {
  describeSource,
  backfillEmbeddings,
  clearEmbeddings,
  diffSnapshotsForSource,
  exportCatalogBackup,
  fetchSources,
  getEmbeddingStatus,
  getDoctorReport,
  importCatalogBackup,
  initManagedSources,
  linkProjectSources,
  listRoutingLearningsForQuery,
  listSourcePages,
  listSnapshotsForSource,
  listSources,
  retrieveContext,
  refreshDueSources,
  runSourceCanaries,
  runEmbeddingWorker,
  saveRoutingLearning,
  searchCatalog,
  showPage,
  showChunk,
  upsertSourceContextFromFile,
  unlinkProjectSources,
  upsertSourceFromSpecFile,
  verifyCoverage,
  getSourceContextForSource,
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
  kind: z.enum(['web', 'git']),
  label: z.string(),
  specPath: z.string().nullable(),
  nextDueAt: z.string(),
  isDue: z.boolean(),
  nextCanaryDueAt: z.string().nullable(),
  isCanaryDue: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessfulSnapshotAt: z.string().nullable(),
  lastSuccessfulSnapshotId: z.string().nullable(),
  lastCanaryCheckedAt: z.string().nullable(),
  lastSuccessfulCanaryAt: z.string().nullable(),
  lastCanaryStatus: z.enum(['pass', 'fail']).nullable(),
});

const sourceContextSchema = z.object({
  purpose: z.string().optional(),
  summary: z.string().optional(),
  topicHints: z.array(z.string()),
  commonLocations: z.array(z.object({
    label: z.string(),
    url: z.string().optional(),
    filePath: z.string().optional(),
    note: z.string().optional(),
  })),
  gotchas: z.array(z.string()),
  authNotes: z.array(z.string()),
});

const routingLearningSchema = z.object({
  learningId: z.string(),
  sourceId: z.string(),
  snapshotId: z.string().nullable(),
  learningType: z.enum(['discovery', 'negative']),
  intent: z.string(),
  pageUrl: z.string().nullable(),
  filePath: z.string().nullable(),
  title: z.string().nullable(),
  note: z.string().nullable(),
  searchTerms: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const pageSchema = z.object({
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  pageKind: z.enum(['document', 'file']),
  filePath: z.string().nullable(),
  language: z.string().nullable(),
});

const pageListingSchema = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  pages: z.array(pageSchema.omit({ markdown: true }).extend({
    markdownLength: z.number().int().nonnegative(),
  })),
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
  pageKind: z.enum(['document', 'file']),
  filePath: z.string().nullable(),
  language: z.string().nullable(),
  score: z.number().optional(),
  signals: z.array(z.enum(['lexical', 'vector'])).optional(),
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

const canaryResultSchema = z.object({
  sourceId: z.string(),
  status: z.enum(['pass', 'fail']),
  checkedAt: z.string(),
  summary: z.object({
    checkCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    failCount: z.number().int().nonnegative(),
  }),
  checks: z.array(z.object({
    url: z.string().optional(),
    path: z.string().optional(),
    status: z.enum(['pass', 'fail']),
    title: z.string().optional(),
    markdownLength: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
  })),
});

const snapshotDiffSchema = z.object({
  sourceId: z.string(),
  fromSnapshotId: z.string(),
  toSnapshotId: z.string(),
  summary: z.object({
    addedPageCount: z.number().int().nonnegative(),
    removedPageCount: z.number().int().nonnegative(),
    changedPageCount: z.number().int().nonnegative(),
    unchangedPageCount: z.number().int().nonnegative(),
  }),
  addedPages: z.array(z.object({
    url: z.string(),
    title: z.string(),
    pageKind: z.enum(['document', 'file']),
    filePath: z.string().nullable(),
    language: z.string().nullable(),
  })),
  removedPages: z.array(z.object({
    url: z.string(),
    title: z.string(),
    pageKind: z.enum(['document', 'file']),
    filePath: z.string().nullable(),
    language: z.string().nullable(),
  })),
  changedPages: z.array(z.object({
    url: z.string(),
    beforeTitle: z.string(),
    afterTitle: z.string(),
    pageKind: z.enum(['document', 'file']),
    filePath: z.string().nullable(),
    language: z.string().nullable(),
    lineSummary: z.object({
      addedLineCount: z.number().int().nonnegative(),
      removedLineCount: z.number().int().nonnegative(),
    }),
  })),
});

const backupManifestSchema = z.object({
  formatVersion: z.literal(1),
  createdAt: z.string(),
  packageVersion: z.string(),
  entries: z.array(z.object({
    relativePath: z.string(),
    type: z.enum(['file', 'directory']),
    size: z.number().int().nonnegative(),
  })),
});

const embeddingStatusSchema = z.object({
  queue: z.object({
    pendingJobs: z.number().int().nonnegative(),
    runningJobs: z.number().int().nonnegative(),
    failedJobs: z.number().int().nonnegative(),
  }),
  sources: z.array(z.object({
    sourceId: z.string(),
    snapshotId: z.string().nullable(),
    totalChunks: z.number().int().nonnegative(),
    indexedChunks: z.number().int().nonnegative(),
    pendingChunks: z.number().int().nonnegative(),
    failedChunks: z.number().int().nonnegative(),
    staleChunks: z.number().int().nonnegative(),
    coverageRatio: z.number(),
  })),
});

const server = new McpServer({
  name: packageName,
  version: packageVersion,
  title: 'aiocs MCP server',
}, {
  instructions: `${packageDescription} Prefer these tools before live browsing when supported or already-fetched docs may exist locally. Check source_list before assuming a source is missing or stale. Use search mode auto by default, lexical for exact identifiers, and refresh_due for targeted freshness checks before force fetch. Avoid fetch all as a normal answering path, use batch to reduce repeated round trips, and cite sourceId, snapshotId, and pageUrl when returning results.`,
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
  init: async (args = {}) => initManagedSources({
    ...(typeof args.fetch === 'boolean' ? { fetch: args.fetch } : {}),
  }),
  source_upsert: async (args = {}) => upsertSourceFromSpecFile(args.specFile as string),
  source_list: async () => listSources(),
  source_describe: async (args = {}) => describeSource(args.sourceId as string),
  source_context_show: async (args = {}) => getSourceContextForSource(args.sourceId as string),
  source_context_upsert: async (args = {}) =>
    upsertSourceContextFromFile(args.sourceId as string, args.contextFile as string),
  fetch: async (args = {}) => fetchSources(args.sourceIdOrAll as string),
  canary: async (args = {}) => runSourceCanaries(args.sourceIdOrAll as string),
  refresh_due: async (args = {}) => refreshDueSources((args.sourceIdOrAll as string | undefined) ?? 'all'),
  snapshot_list: async (args = {}) => listSnapshotsForSource(args.sourceId as string),
  page_list: async (args = {}) => listSourcePages(args.sourceId as string, {
    ...(typeof args.snapshotId === 'string' ? { snapshot: args.snapshotId } : {}),
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(Array.isArray(args.pathPatterns) ? { path: args.pathPatterns as string[] } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
  }),
  page_show: async (args = {}) => showPage({
    sourceId: args.sourceId as string,
    ...(typeof args.snapshotId === 'string' ? { snapshotId: args.snapshotId } : {}),
    ...(typeof args.url === 'string' ? { url: args.url } : {}),
    ...(typeof args.filePath === 'string' ? { filePath: args.filePath } : {}),
  }),
  diff_snapshots: async (args = {}) => diffSnapshotsForSource({
    sourceId: args.sourceId as string,
    ...(typeof args.fromSnapshotId === 'string' ? { fromSnapshotId: args.fromSnapshotId } : {}),
    ...(typeof args.toSnapshotId === 'string' ? { toSnapshotId: args.toSnapshotId } : {}),
  }),
  project_link: async (args = {}) =>
    linkProjectSources(args.projectPath as string, args.sourceIds as string[]),
  project_unlink: async (args = {}) =>
    unlinkProjectSources(args.projectPath as string, (args.sourceIds as string[] | undefined) ?? []),
  search: async (args = {}) => searchCatalog(args.query as string, {
    source: (args.sourceIds as string[] | undefined) ?? [],
    ...(typeof args.snapshotId === 'string' ? { snapshot: args.snapshotId } : {}),
    ...(typeof args.all === 'boolean' ? { all: args.all } : {}),
    ...(typeof args.project === 'string' ? { project: args.project } : {}),
    ...(Array.isArray(args.pathPatterns) ? { path: args.pathPatterns as string[] } : {}),
    ...(Array.isArray(args.languages) ? { language: args.languages as string[] } : {}),
    ...(typeof args.mode === 'string' ? { mode: args.mode as 'auto' | 'lexical' | 'hybrid' | 'semantic' } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
  }),
  retrieve_context: async (args = {}) => retrieveContext(args.query as string, {
    source: (args.sourceIds as string[] | undefined) ?? [],
    ...(typeof args.snapshotId === 'string' ? { snapshot: args.snapshotId } : {}),
    ...(typeof args.all === 'boolean' ? { all: args.all } : {}),
    ...(typeof args.project === 'string' ? { project: args.project } : {}),
    ...(Array.isArray(args.pathPatterns) ? { path: args.pathPatterns as string[] } : {}),
    ...(Array.isArray(args.languages) ? { language: args.languages as string[] } : {}),
    ...(typeof args.mode === 'string' ? { mode: args.mode as 'auto' | 'lexical' | 'hybrid' | 'semantic' } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
    ...(typeof args.pageLimit === 'number' ? { pageLimit: args.pageLimit } : {}),
  }),
  learning_save: async (args = {}) => saveRoutingLearning({
    sourceId: args.sourceId as string,
    learningType: args.learningType as 'discovery' | 'negative',
    intent: args.intent as string,
    ...(typeof args.snapshotId === 'string' ? { snapshotId: args.snapshotId } : {}),
    ...(typeof args.pageUrl === 'string' ? { pageUrl: args.pageUrl } : {}),
    ...(typeof args.filePath === 'string' ? { filePath: args.filePath } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
    ...(Array.isArray(args.searchTerms) ? { searchTerms: args.searchTerms as string[] } : {}),
  }),
  learning_list: async (args = {}) => listRoutingLearningsForQuery({
    ...(typeof args.sourceId === 'string' ? { sourceId: args.sourceId } : {}),
    ...(typeof args.learningType === 'string' ? { learningType: args.learningType as 'discovery' | 'negative' } : {}),
    ...(typeof args.intentQuery === 'string' ? { intentQuery: args.intentQuery } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  }),
  show: async (args = {}) => showChunk(args.chunkId as number),
  embeddings_status: async () => getEmbeddingStatus(),
  embeddings_backfill: async (args = {}) => backfillEmbeddings(args.sourceIdOrAll as string),
  embeddings_clear: async (args = {}) => clearEmbeddings(args.sourceIdOrAll as string),
  embeddings_run: async () => runEmbeddingWorker(),
  backup_export: async (args = {}) =>
    exportCatalogBackup({
      outputDir: args.outputDir as string,
      ...(typeof args.replaceExisting === 'boolean' ? { replaceExisting: args.replaceExisting } : {}),
    }),
  backup_import: async (args = {}) =>
    importCatalogBackup({
      inputDir: args.inputDir as string,
      ...(typeof args.replaceExisting === 'boolean' ? { replaceExisting: args.replaceExisting } : {}),
    }),
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
    description: 'Validate catalog, Playwright, daemon config, source-spec directories, freshness, embeddings, Qdrant, Ollama, and Docker readiness.',
    outputSchema: doctorReportSchema,
  },
);

registerAiocsTool(
  'init',
  {
    title: 'Init',
    description: 'Bootstrap managed source specs from the bundled repo directory and ~/.aiocs/sources, then optionally fetch them.',
    inputSchema: z.object({
      fetch: z.boolean().optional(),
    }),
    outputSchema: z.object({
      sourceSpecDirs: z.array(z.string()),
      userSourceDir: z.string(),
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
  'source_describe',
  {
    title: 'Source describe',
    description: 'Describe one source with latest snapshot info, curated source context, and recent routing learnings.',
    inputSchema: z.object({
      sourceId: z.string(),
    }),
    outputSchema: z.object({
      source: sourceSchema,
      context: z.object({
        sourceId: z.string(),
        context: sourceContextSchema.nullable(),
        createdAt: z.string().nullable(),
        updatedAt: z.string().nullable(),
      }),
      latestSnapshot: z.object({
        snapshotId: z.string(),
        detectedVersion: z.string().nullable(),
        createdAt: z.string(),
        pageCount: z.number().int().nonnegative(),
      }).nullable(),
      recentLearnings: z.array(routingLearningSchema),
    }),
  },
);

registerAiocsTool(
  'source_context_show',
  {
    title: 'Source context show',
    description: 'Show curated local source context for a source.',
    inputSchema: z.object({
      sourceId: z.string(),
    }),
    outputSchema: z.object({
      sourceId: z.string(),
      context: sourceContextSchema.nullable(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    }),
  },
);

registerAiocsTool(
  'source_context_upsert',
  {
    title: 'Source context upsert',
    description: 'Load or update curated local source context from a JSON or YAML file.',
    inputSchema: z.object({
      sourceId: z.string(),
      contextFile: z.string(),
    }),
    outputSchema: z.object({
      sourceId: z.string(),
      context: sourceContextSchema,
      contextFile: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
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
  'canary',
  {
    title: 'Canary',
    description: 'Run lightweight source extraction canaries without creating snapshots.',
    inputSchema: z.object({
      sourceIdOrAll: z.string(),
    }),
    outputSchema: z.object({
      results: z.array(canaryResultSchema),
    }),
  },
);

registerAiocsTool(
  'refresh_due',
  {
    title: 'Refresh due',
    description: 'Fetch all due sources, or refresh one specific source only if it is currently due.',
    inputSchema: z.object({
      sourceIdOrAll: z.string().optional(),
    }),
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
  'page_list',
  {
    title: 'Page list',
    description: 'List stored pages for a source snapshot with optional query and path filtering.',
    inputSchema: z.object({
      sourceId: z.string(),
      snapshotId: z.string().optional(),
      query: z.string().optional(),
      pathPatterns: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    outputSchema: pageListingSchema,
  },
);

registerAiocsTool(
  'page_show',
  {
    title: 'Page show',
    description: 'Read a full stored page by URL or file path.',
    inputSchema: z.object({
      sourceId: z.string(),
      snapshotId: z.string().optional(),
      url: z.string().optional(),
      filePath: z.string().optional(),
    }),
    outputSchema: z.object({
      sourceId: z.string(),
      snapshotId: z.string(),
      page: pageSchema,
    }),
  },
);

registerAiocsTool(
  'diff_snapshots',
  {
    title: 'Diff snapshots',
    description: 'Compare two source snapshots and report added, removed, and changed pages.',
    inputSchema: z.object({
      sourceId: z.string(),
      fromSnapshotId: z.string().optional(),
      toSnapshotId: z.string().optional(),
    }),
    outputSchema: snapshotDiffSchema,
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
      pathPatterns: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      mode: z.enum(['auto', 'lexical', 'hybrid', 'semantic']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    outputSchema: z.object({
      query: z.string(),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      modeRequested: z.enum(['auto', 'lexical', 'hybrid', 'semantic']),
      modeUsed: z.enum(['lexical', 'hybrid', 'semantic']),
      results: z.array(searchResultSchema),
    }),
  },
);

registerAiocsTool(
  'retrieve_context',
  {
    title: 'Retrieve context',
    description: 'Run aiocs awareness, learned routing hints, search, and full-page reads to assemble grounded answer context.',
    inputSchema: z.object({
      query: z.string(),
      sourceIds: z.array(z.string()).optional(),
      snapshotId: z.string().optional(),
      all: z.boolean().optional(),
      project: z.string().optional(),
      pathPatterns: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      mode: z.enum(['auto', 'lexical', 'hybrid', 'semantic']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      pageLimit: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      query: z.string(),
      modeRequested: z.enum(['auto', 'lexical', 'hybrid', 'semantic']),
      modeUsed: z.enum(['lexical', 'hybrid', 'semantic']),
      sourceScope: z.array(z.string()),
      sourceHints: z.array(z.object({
        sourceId: z.string(),
        score: z.number(),
        context: sourceContextSchema,
        matchedCommonLocations: z.array(z.object({
          label: z.string(),
          url: z.string().optional(),
          filePath: z.string().optional(),
          note: z.string().optional(),
        })),
      })),
      matchedLearnings: z.array(routingLearningSchema.extend({ score: z.number() })),
      avoidedLearnings: z.array(routingLearningSchema.extend({ score: z.number() })),
      search: z.object({
        total: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        results: z.array(searchResultSchema),
      }),
      pages: z.array(pageSchema.extend({
        sourceId: z.string(),
        snapshotId: z.string(),
      })),
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
  'learning_save',
  {
    title: 'Learning save',
    description: 'Save a discovery or negative routing learning for future retrieval hints.',
    inputSchema: z.object({
      sourceId: z.string(),
      learningType: z.enum(['discovery', 'negative']),
      intent: z.string(),
      snapshotId: z.string().optional(),
      pageUrl: z.string().optional(),
      filePath: z.string().optional(),
      title: z.string().optional(),
      note: z.string().optional(),
      searchTerms: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      learning: routingLearningSchema,
    }),
  },
);

registerAiocsTool(
  'learning_list',
  {
    title: 'Learning list',
    description: 'List saved routing learnings, optionally filtered by source, type, or intent substring.',
    inputSchema: z.object({
      sourceId: z.string().optional(),
      learningType: z.enum(['discovery', 'negative']).optional(),
      intentQuery: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      learnings: z.array(routingLearningSchema),
    }),
  },
);

registerAiocsTool(
  'embeddings_status',
  {
    title: 'Embeddings status',
    description: 'Return embedding backlog and latest-snapshot coverage details.',
    outputSchema: embeddingStatusSchema,
  },
);

registerAiocsTool(
  'embeddings_backfill',
  {
    title: 'Embeddings backfill',
    description: 'Queue latest snapshots for embedding rebuild for one source or all sources.',
    inputSchema: z.object({
      sourceIdOrAll: z.string(),
    }),
    outputSchema: z.object({
      queuedJobs: z.number().int().nonnegative(),
    }),
  },
);

registerAiocsTool(
  'embeddings_clear',
  {
    title: 'Embeddings clear',
    description: 'Clear derived embedding state for one source or all sources.',
    inputSchema: z.object({
      sourceIdOrAll: z.string(),
    }),
    outputSchema: z.object({
      clearedSources: z.array(z.string()),
    }),
  },
);

registerAiocsTool(
  'embeddings_run',
  {
    title: 'Embeddings run',
    description: 'Process queued embedding jobs immediately.',
    outputSchema: z.object({
      processedJobs: z.number().int().nonnegative(),
      succeededJobs: z.array(z.object({
        sourceId: z.string(),
        snapshotId: z.string(),
        chunkCount: z.number().int().nonnegative(),
      })),
      failedJobs: z.array(z.object({
        sourceId: z.string(),
        snapshotId: z.string(),
        errorMessage: z.string(),
      })),
    }),
  },
);

registerAiocsTool(
  'backup_export',
  {
    title: 'Backup export',
    description: 'Export the local aiocs data and config into a manifest-backed backup directory.',
    inputSchema: z.object({
      outputDir: z.string(),
      replaceExisting: z.boolean().optional(),
    }),
    outputSchema: z.object({
      outputDir: z.string(),
      manifestPath: z.string(),
      manifest: backupManifestSchema,
    }),
  },
);

registerAiocsTool(
  'backup_import',
  {
    title: 'Backup import',
    description: 'Import a manifest-backed aiocs backup into the local data and config directories.',
    inputSchema: z.object({
      inputDir: z.string(),
      replaceExisting: z.boolean().optional(),
    }),
    outputSchema: z.object({
      inputDir: z.string(),
      dataDir: z.string(),
      configDir: z.string().optional(),
      manifest: backupManifestSchema,
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
