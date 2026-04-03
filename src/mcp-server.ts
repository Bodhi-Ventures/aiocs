#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AiocsError, AIOCS_ERROR_CODES, toAiocsError } from './errors.js';
import { packageDescription, packageName, packageVersion } from './runtime/package-metadata.js';
import {
  backfillEmbeddings,
  clearEmbeddings,
  compileWorkspaceArtifacts,
  createWorkspace,
  diffSnapshotsForSource,
  exportCatalogBackup,
  fetchSources,
  generateWorkspaceArtifactOutput,
  getEmbeddingStatus,
  getDoctorReport,
  getWorkspaceStatus,
  importCatalogBackup,
  initManagedSources,
  linkProjectSources,
  listWorkspaceArtifacts,
  listWorkspaceRecords,
  listSnapshotsForSource,
  listSources,
  lintWorkspaceArtifacts,
  refreshDueSources,
  runSourceCanaries,
  runEmbeddingWorker,
  searchCatalog,
  searchWorkspaceCatalog,
  showChunk,
  showWorkspaceArtifact,
  unlinkProjectSources,
  unbindWorkspaceSources,
  upsertSourceFromSpecFile,
  verifyCoverage,
  bindWorkspaceSources,
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

const workspaceSchema = z.object({
  id: z.string(),
  label: z.string(),
  purpose: z.string().nullable(),
  compilerProfile: z.object({
    provider: z.literal('lmstudio'),
    model: z.string(),
    temperature: z.number(),
    topP: z.number(),
    maxInputChars: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    concurrency: z.number().int().positive(),
  }),
  defaultOutputFormats: z.array(z.enum(['report', 'slides', 'summary'])),
  bindingCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  lastCompileRunId: z.string().nullable(),
  lastCompileStatus: z.enum(['success', 'failed']).nullable(),
  lastCompiledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const workspaceBindingSchema = z.object({
  workspaceId: z.string(),
  sourceId: z.string(),
  createdAt: z.string(),
});

const workspaceArtifactSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  kind: z.enum(['concept', 'summary', 'report', 'slides', 'image', 'index', 'note']),
  contentHash: z.string(),
  compilerMetadata: z.record(z.string(), z.unknown()),
  stale: z.boolean(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const workspaceArtifactProvenanceSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  sourceId: z.string(),
  snapshotId: z.string(),
  chunkIds: z.array(z.number().int().nonnegative()),
});

const workspaceLintSchema = z.object({
  workspaceId: z.string(),
  summary: z.object({
    status: z.enum(['pass', 'warn']),
    findingCount: z.number().int().nonnegative(),
    staleArtifactCount: z.number().int().nonnegative(),
    missingProvenanceCount: z.number().int().nonnegative(),
    missingArtifactCount: z.number().int().nonnegative(),
  }),
  findings: z.array(z.object({
    kind: z.enum(['stale-artifact', 'missing-provenance', 'missing-artifact']),
    severity: z.literal('warn'),
    summary: z.string(),
    artifactPath: z.string().optional(),
    sourceId: z.string().optional(),
  })),
});

const workspaceSearchResultSchema = z.union([
  z.object({
    kind: z.literal('source'),
    scope: z.literal('source'),
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
    score: z.number(),
    signals: z.array(z.enum(['lexical', 'vector'])),
  }),
  z.object({
    kind: z.literal('derived'),
    scope: z.literal('derived'),
    artifactPath: z.string(),
    artifactKind: z.string(),
    sectionTitle: z.string(),
    markdown: z.string(),
    stale: z.boolean(),
    score: z.number(),
  }),
]);

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
  fetch: async (args = {}) => fetchSources(args.sourceIdOrAll as string),
  canary: async (args = {}) => runSourceCanaries(args.sourceIdOrAll as string),
  refresh_due: async (args = {}) => refreshDueSources((args.sourceIdOrAll as string | undefined) ?? 'all'),
  snapshot_list: async (args = {}) => listSnapshotsForSource(args.sourceId as string),
  diff_snapshots: async (args = {}) => diffSnapshotsForSource({
    sourceId: args.sourceId as string,
    ...(typeof args.fromSnapshotId === 'string' ? { fromSnapshotId: args.fromSnapshotId } : {}),
    ...(typeof args.toSnapshotId === 'string' ? { toSnapshotId: args.toSnapshotId } : {}),
  }),
  project_link: async (args = {}) =>
    linkProjectSources(args.projectPath as string, args.sourceIds as string[]),
  project_unlink: async (args = {}) =>
    unlinkProjectSources(args.projectPath as string, (args.sourceIds as string[] | undefined) ?? []),
  workspace_create: async (args = {}) => createWorkspace({
    workspaceId: args.workspaceId as string,
    label: args.label as string,
    ...(typeof args.purpose === 'string' ? { purpose: args.purpose } : {}),
    ...(Array.isArray(args.defaultOutputFormats) ? { defaultOutputFormats: args.defaultOutputFormats as Array<'report' | 'slides' | 'summary'> } : {}),
  }),
  workspace_list: async () => listWorkspaceRecords(),
  workspace_bind: async (args = {}) => bindWorkspaceSources({
    workspaceId: args.workspaceId as string,
    sourceIds: args.sourceIds as string[],
  }),
  workspace_unbind: async (args = {}) => unbindWorkspaceSources({
    workspaceId: args.workspaceId as string,
    ...(Array.isArray(args.sourceIds) ? { sourceIds: args.sourceIds as string[] } : {}),
  }),
  workspace_compile: async (args = {}) => compileWorkspaceArtifacts(args.workspaceId as string),
  workspace_status: async (args = {}) => getWorkspaceStatus(args.workspaceId as string),
  workspace_search: async (args = {}) => searchWorkspaceCatalog(
    args.workspaceId as string,
    args.query as string,
    {
      ...(typeof args.scope === 'string' ? { scope: args.scope as 'source' | 'derived' | 'mixed' } : {}),
      ...(Array.isArray(args.pathPatterns) ? { path: args.pathPatterns as string[] } : {}),
      ...(Array.isArray(args.languages) ? { language: args.languages as string[] } : {}),
      ...(typeof args.mode === 'string' ? { mode: args.mode as 'auto' | 'lexical' | 'hybrid' | 'semantic' } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
    },
  ),
  workspace_artifact_list: async (args = {}) => listWorkspaceArtifacts(args.workspaceId as string),
  workspace_artifact_show: async (args = {}) => showWorkspaceArtifact(args.workspaceId as string, args.artifactPath as string),
  workspace_lint: async (args = {}) => lintWorkspaceArtifacts(args.workspaceId as string),
  workspace_output: async (args = {}) => generateWorkspaceArtifactOutput({
    workspaceId: args.workspaceId as string,
    format: args.format as 'report' | 'slides' | 'summary',
    ...(typeof args.name === 'string' ? { name: args.name } : {}),
    ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
  }),
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
  'workspace_create',
  {
    title: 'Workspace create',
    description: 'Create or update a research workspace with the default LM Studio compiler profile.',
    inputSchema: z.object({
      workspaceId: z.string(),
      label: z.string(),
      purpose: z.string().optional(),
      defaultOutputFormats: z.array(z.enum(['report', 'slides', 'summary'])).optional(),
    }),
    outputSchema: z.object({
      workspace: workspaceSchema,
    }),
  },
);

registerAiocsTool(
  'workspace_list',
  {
    title: 'Workspace list',
    description: 'List all research workspaces in the local aiocs catalog.',
    outputSchema: z.object({
      workspaces: z.array(workspaceSchema),
    }),
  },
);

registerAiocsTool(
  'workspace_bind',
  {
    title: 'Workspace bind',
    description: 'Bind one or more existing aiocs sources to a research workspace.',
    inputSchema: z.object({
      workspaceId: z.string(),
      sourceIds: z.array(z.string()).min(1),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      sourceIds: z.array(z.string()),
    }),
  },
);

registerAiocsTool(
  'workspace_unbind',
  {
    title: 'Workspace unbind',
    description: 'Unbind one or more sources from a research workspace.',
    inputSchema: z.object({
      workspaceId: z.string(),
      sourceIds: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      sourceIds: z.array(z.string()),
    }),
  },
);

registerAiocsTool(
  'workspace_compile',
  {
    title: 'Workspace compile',
    description: 'Compile or refresh derived workspace wiki artifacts from bound canonical sources.',
    inputSchema: z.object({
      workspaceId: z.string(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      skipped: z.boolean(),
      sourceFingerprint: z.string(),
      changedSourceIds: z.array(z.string()),
      updatedArtifactPaths: z.array(z.string()),
      artifactCount: z.number().int().nonnegative(),
      compileRunId: z.string().nullable(),
    }),
  },
);

registerAiocsTool(
  'workspace_status',
  {
    title: 'Workspace status',
    description: 'Show workspace metadata, bindings, artifacts, and recent compile runs.',
    inputSchema: z.object({
      workspaceId: z.string(),
    }),
    outputSchema: z.object({
      workspace: workspaceSchema,
      bindings: z.array(workspaceBindingSchema),
      artifacts: z.array(workspaceArtifactSchema),
      compileRuns: z.array(z.object({
        runId: z.string(),
        workspaceId: z.string(),
        status: z.enum(['success', 'failed']),
        sourceFingerprint: z.string(),
        artifactCount: z.number().int().nonnegative(),
        errorMessage: z.string().nullable(),
        startedAt: z.string(),
        finishedAt: z.string(),
      })),
    }),
  },
);

registerAiocsTool(
  'workspace_search',
  {
    title: 'Workspace search',
    description: 'Search canonical source evidence, derived artifacts, or both within a research workspace.',
    inputSchema: z.object({
      workspaceId: z.string(),
      query: z.string(),
      scope: z.enum(['source', 'derived', 'mixed']).optional(),
      pathPatterns: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      mode: z.enum(['auto', 'lexical', 'hybrid', 'semantic']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      query: z.string(),
      scope: z.enum(['source', 'derived', 'mixed']),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      modeRequested: z.enum(['auto', 'lexical', 'hybrid', 'semantic']),
      modeUsed: z.union([z.enum(['auto', 'lexical', 'hybrid', 'semantic']), z.literal('derived')]),
      total: z.number().int().nonnegative(),
      results: z.array(workspaceSearchResultSchema),
    }),
  },
);

registerAiocsTool(
  'workspace_artifact_list',
  {
    title: 'Workspace artifact list',
    description: 'List derived artifacts recorded for a workspace.',
    inputSchema: z.object({
      workspaceId: z.string(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      artifacts: z.array(workspaceArtifactSchema),
    }),
  },
);

registerAiocsTool(
  'workspace_artifact_show',
  {
    title: 'Workspace artifact show',
    description: 'Read a workspace artifact file together with its provenance metadata.',
    inputSchema: z.object({
      workspaceId: z.string(),
      artifactPath: z.string(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      artifact: workspaceArtifactSchema,
      content: z.string(),
      provenance: z.array(workspaceArtifactProvenanceSchema),
    }),
  },
);

registerAiocsTool(
  'workspace_lint',
  {
    title: 'Workspace lint',
    description: 'Lint a workspace for stale artifacts, missing provenance, and missing expected artifacts.',
    inputSchema: z.object({
      workspaceId: z.string(),
    }),
    outputSchema: workspaceLintSchema,
  },
);

registerAiocsTool(
  'workspace_output',
  {
    title: 'Workspace output',
    description: 'Generate a report, slide deck, or summary artifact from a compiled workspace.',
    inputSchema: z.object({
      workspaceId: z.string(),
      format: z.enum(['report', 'slides', 'summary']),
      name: z.string().optional(),
      prompt: z.string().optional(),
    }),
    outputSchema: z.object({
      workspaceId: z.string(),
      format: z.enum(['report', 'slides', 'summary']),
      path: z.string(),
      artifactCount: z.number().int().nonnegative(),
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
