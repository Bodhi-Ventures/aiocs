#!/usr/bin/env node

import { Command, CommanderError } from 'commander';

import { openCatalog } from './catalog/catalog.js';
import {
  argvWantsJson,
  commandWantsJson,
  emitError,
  emitSuccess,
  inferRequestedCommand,
  type HumanOutput,
} from './cli-output.js';
import { startDaemon, parseDaemonConfig, type DaemonEvent } from './daemon.js';
import { getAiocsConfigDir, getAiocsDataDir } from './runtime/paths.js';
import { packageName, packageVersion } from './runtime/package-metadata.js';
import { type SearchMode } from './runtime/hybrid-config.js';
import {
  AiocsError,
  AIOCS_ERROR_CODES,
} from './errors.js';
import {
  backfillEmbeddings,
  clearEmbeddings,
  compileWorkspaceArtifacts,
  createWorkspace,
  diffSnapshotsForSource,
  getEmbeddingStatus,
  exportCatalogBackup,
  importCatalogBackup,
  fetchSources,
  getDoctorReport,
  initManagedSources,
  generateWorkspaceArtifactOutput,
  getWorkspaceStatus,
  ingestWorkspaceRawInput,
  linkProjectSources,
  listWorkspaceArtifacts,
  listWorkspaceRecords,
  listWorkspaceRawInputsRecord,
  listSnapshotsForSource,
  listSources,
  lintWorkspaceArtifacts,
  answerWorkspace,
  runSourceCanaries,
  runEmbeddingWorker,
  runQueuedWorkspaceCompiles,
  searchCatalog,
  searchWorkspaceRawInputCatalog,
  searchWorkspaceCatalog,
  showChunk,
  showWorkspaceArtifact,
  showWorkspaceRawInput,
  syncWorkspaceToObsidianVault,
  type SearchOptions,
  type WorkspaceSearchOptions,
  unlinkProjectSources,
  unbindWorkspaceSources,
  updateWorkspaceSettings,
  upsertSourceFromSpecFile,
  verifyCoverage,
  refreshDueSources,
  getManagedSourceSpecDirectories,
  bindWorkspaceSources,
  removeWorkspaceRawInput,
} from './services.js';

type CommandResult<TData> = {
  data: TData;
  human?: HumanOutput;
};

function renderSearchResult(result: {
  chunkId: number;
  sourceId: string;
  snapshotId: string;
  pageUrl: string;
  pageTitle: string;
  sectionTitle: string;
  markdown: string;
  pageKind?: 'document' | 'file';
  filePath?: string | null;
  language?: string | null;
  score?: number;
  signals?: Array<'lexical' | 'vector'>;
}): string {
  return [
    `Chunk ID: ${result.chunkId}`,
    `Source: ${result.sourceId}`,
    `Snapshot: ${result.snapshotId}`,
    ...(typeof result.score === 'number' ? [`Score: ${result.score.toFixed(4)}`] : []),
    ...(result.signals ? [`Signals: ${result.signals.join(', ')}`] : []),
    ...(result.pageKind ? [`Kind: ${result.pageKind}`] : []),
    ...(result.filePath ? [`Path: ${result.filePath}`] : []),
    ...(result.language ? [`Language: ${result.language}`] : []),
    `Page: ${result.pageTitle}`,
    `Section: ${result.sectionTitle}`,
    `URL: ${result.pageUrl}`,
    '',
    result.markdown,
    '',
  ].join('\n');
}

function renderWorkspaceSearchResult(
  result:
    | {
        kind: 'source';
        scope: 'source';
        chunkId: number;
        sourceId: string;
        snapshotId: string;
        pageUrl: string;
        pageTitle: string;
        sectionTitle: string;
        markdown: string;
        pageKind: 'document' | 'file';
        filePath: string | null;
        language: string | null;
        score: number;
        signals: Array<'lexical' | 'vector'>;
      }
    | {
        kind: 'derived';
        scope: 'derived';
        artifactPath: string;
        artifactKind: string;
        sectionTitle: string;
        markdown: string;
        stale: boolean;
        score: number;
      },
): string {
  if (result.kind === 'source') {
    return renderSearchResult(result);
  }

  return [
    `Artifact: ${result.artifactPath}`,
    `Kind: ${result.artifactKind}`,
    `Section: ${result.sectionTitle}`,
    `Stale: ${String(result.stale)}`,
    `Score: ${result.score.toFixed(4)}`,
    '',
    result.markdown,
    '',
  ].join('\n');
}

function parsePositiveIntegerOption(
  value: string | undefined,
  field: string,
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `${field} must be a non-negative integer`,
    );
  }

  if (field === 'limit' && parsed === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      'limit must be greater than zero',
    );
  }

  return parsed;
}

function parseSearchModeOption(value: string | undefined): SearchMode | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (value === 'auto' || value === 'lexical' || value === 'hybrid' || value === 'semantic') {
    return value;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.invalidArgument,
    'mode must be one of: auto, lexical, hybrid, semantic',
  );
}

async function executeCommand<TData>(
  command: Command,
  commandName: string,
  run: () => Promise<CommandResult<TData>> | CommandResult<TData>,
): Promise<void> {
  try {
    const result = await run();
    emitSuccess({
      json: commandWantsJson(command),
      commandName,
      data: result.data,
      human: result.human,
    });
  } catch (error) {
    emitError({
      json: commandWantsJson(command),
      commandName,
      error,
    });
    process.exitCode = 1;
  }
}

function createDaemonLogger(json: boolean): { emit(event: DaemonEvent): void } {
  if (json) {
    return {
      emit(event: DaemonEvent) {
        console.log(JSON.stringify(event));
      },
    };
  }

  return {
    emit(event: DaemonEvent) {
      switch (event.type) {
        case 'daemon.started':
          console.log([
            'Daemon started',
            `interval=${event.intervalMinutes}m`,
            `fetchOnStart=${String(event.fetchOnStart)}`,
            `sourceSpecDirs=${event.sourceSpecDirs.join(', ') || '(none)'}`,
          ].join(' | '));
          break;
        case 'daemon.stopped':
          console.log('Daemon stopped');
          break;
        case 'daemon.cycle.started':
          console.log(`Cycle started (${event.reason}) at ${event.startedAt}`);
          break;
        case 'daemon.cycle.completed':
          console.log([
            `Cycle completed (${event.reason})`,
            `bootstrapped=${event.result.bootstrapped.processedSpecCount}`,
            `removed=${event.result.bootstrapped.removedSourceIds.length}`,
            `canaries=${event.result.canaried.length}`,
            `canaryFailed=${event.result.canaryFailed.length}`,
            `due=${event.result.dueSourceIds.length}`,
            `refreshed=${event.result.refreshed.length}`,
            `failed=${event.result.failed.length}`,
            `embedded=${event.result.embedded.length}`,
            `embeddingFailed=${event.result.embeddingFailed.length}`,
          ].join(' | '));
          for (const canaried of event.result.canaried) {
            console.log([
              'Canary',
              canaried.sourceId,
              `status=${canaried.status}`,
              `checks=${canaried.summary.checkCount}`,
            ].join(' | '));
          }
          for (const failedCanary of event.result.canaryFailed) {
            console.log(`Canary failed | ${failedCanary.sourceId} | ${failedCanary.errorMessage}`);
          }
          for (const refreshed of event.result.refreshed) {
            console.log([
              refreshed.reused ? 'Reused' : 'Fetched',
              refreshed.sourceId,
              `snapshot=${refreshed.snapshotId}`,
              `pages=${refreshed.pageCount}`,
            ].join(' | '));
          }
          for (const failed of event.result.failed) {
            console.log(`Failed | ${failed.sourceId} | ${failed.errorMessage}`);
          }
          for (const embedded of event.result.embedded) {
            console.log(`Embedded | ${embedded.sourceId} | ${embedded.snapshotId} | chunks=${embedded.chunkCount}`);
          }
          for (const failedEmbedding of event.result.embeddingFailed) {
            console.log(`Embedding failed | ${failedEmbedding.sourceId} | ${failedEmbedding.snapshotId} | ${failedEmbedding.errorMessage}`);
          }
          break;
      }
    },
  };
}

const program = new Command();
program
  .name('docs')
  .description('Local-only docs fetch and search CLI for AI agents.')
  .option('-V, --version', 'emit the current aiocs version')
  .option('--json', 'emit machine-readable JSON output')
  .showHelpAfterError();

program.configureOutput({
  writeOut(output) {
    if (!argvWantsJson(process.argv)) {
      process.stdout.write(output);
    }
  },
  writeErr(output) {
    if (!argvWantsJson(process.argv)) {
      process.stderr.write(output);
    }
  },
});

program.exitOverride();

function maybeHandleRootVersionRequest(argv: string[]): boolean {
  const tokens = argv.slice(2);
  const filtered = tokens.filter((token) => token !== '--json');
  const isRootVersionRequest = filtered.length === 1 && ['--version', '-V'].includes(filtered[0] ?? '');
  if (!isRootVersionRequest) {
    return false;
  }

  if (argvWantsJson(argv)) {
    emitSuccess({
      json: true,
      commandName: 'version',
      data: {
        name: packageName,
        version: packageVersion,
      },
    });
  } else {
    console.log(packageVersion);
  }

  return true;
}

if (maybeHandleRootVersionRequest(process.argv)) {
  process.exit(0);
}

program
  .command('version')
  .description('Show the current aiocs version.')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'version', async () => ({
      data: {
        name: packageName,
        version: packageVersion,
      },
      human: packageVersion,
    }));
  });

program
  .command('init')
  .description('Register managed source specs from the bundled repo directory and ~/.aiocs/sources, then optionally fetch them.')
  .option('--fetch', 'fetch managed sources immediately')
  .option('--no-fetch', 'skip immediate fetching after bootstrapping')
  .action(async (options: { fetch?: boolean }, command: Command) => {
    await executeCommand(command, 'init', async () => {
      const result = await initManagedSources({
        fetch: options.fetch ?? false,
      });

      return {
        data: result,
        human: [
          `Initialized ${result.initializedSources.length} managed sources from ${result.sourceSpecDirs.length} directories`,
          ...result.sourceSpecDirs.map((directory) => `Managed source dir: ${directory}`),
          `User-managed source specs live under ${getManagedSourceSpecDirectories().userSourceDir}`,
          ...(result.removedSourceIds.length > 0
            ? [`Removed managed sources: ${result.removedSourceIds.join(', ')}`]
            : []),
          ...(result.fetchResults.length > 0
            ? result.fetchResults.map((entry) => {
                const verb = entry.reused ? 'Reused' : 'Fetched';
                return `${verb} ${entry.sourceId} -> ${entry.snapshotId} (${entry.pageCount} pages)`;
              })
            : [result.fetched ? 'No managed sources were fetched.' : 'Skipped fetching managed sources.']),
        ],
      };
    });
  });

program
  .command('doctor')
  .alias('health')
  .description('Validate the local aiocs runtime and optional Docker daemon path.')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'doctor', async () => {
      const report = await getDoctorReport();
      return {
        data: report,
        human: [
          `Overall status: ${report.summary.status}`,
          ...report.checks.map((check) => `${check.status.toUpperCase()} | ${check.id} | ${check.summary}`),
        ],
      };
    });
  });

const source = program.command('source');

source
  .command('upsert')
  .argument('<spec-file>')
  .action(async (specFile: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'source.upsert', async () => {
      const result = await upsertSourceFromSpecFile(specFile);
      return {
        data: result,
        human: `Upserted source ${result.sourceId}`,
      };
    });
  });

source
  .command('list')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'source.list', async () => {
      const result = await listSources();
      const sources = result.sources;
      return {
        data: result,
        human: sources.length === 0
          ? 'No sources registered.'
          : sources.map((item) => [
            item.id,
            item.kind,
            item.label,
            item.isDue ? 'due now' : `next due ${item.nextDueAt}`,
            `spec ${item.specPath ?? '(inline/unknown)'}`,
            item.lastSuccessfulSnapshotId ? `latest ${item.lastSuccessfulSnapshotId}` : 'no snapshots',
          ].join(' | ')),
      };
    });
  });

program
  .command('fetch')
  .argument('<source-id-or-all>')
  .action(async (sourceIdOrAll: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'fetch', async () => {
      const result = await fetchSources(sourceIdOrAll);
      const results = result.results;

      return {
        data: result,
        human: results.length === 0
          ? 'No sources registered.'
          : results.map((result) => {
            const verb = result.reused ? 'Reused' : 'Fetched';
            return `${verb} ${result.sourceId} -> ${result.snapshotId} (${result.pageCount} pages)`;
          }),
      };
    });
  });

program
  .command('canary')
  .argument('<source-id-or-all>')
  .description('Run lightweight extraction canaries without creating snapshots.')
  .action(async (sourceIdOrAll: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'canary', async () => {
      const result = await runSourceCanaries(sourceIdOrAll);
      return {
        data: result,
        human: result.results.length === 0
          ? 'No sources registered.'
          : result.results.map((entry) =>
              `Canary ${entry.sourceId} | status=${entry.status} | checks=${entry.summary.checkCount} | pass=${entry.summary.passCount} | fail=${entry.summary.failCount}`,
            ),
      };
    });
  });

const refresh = program.command('refresh');
refresh
  .command('due')
  .argument('[source-id-or-all]')
  .description('Refresh all due sources, or refresh one specific source only if it is currently due.')
  .action(async (sourceIdOrAll: string | undefined, _options: unknown, command: Command) => {
    await executeCommand(command, 'refresh.due', async () => {
      const result = await refreshDueSources(sourceIdOrAll ?? 'all');
      const results = result.results;

      return {
        data: result,
        human: results.length === 0
          ? sourceIdOrAll && sourceIdOrAll !== 'all'
            ? `Source ${sourceIdOrAll} is not due for refresh.`
            : 'No sources due for refresh.'
          : results.map((result) => {
            const verb = result.reused ? 'Reused' : 'Fetched';
            return `${verb} ${result.sourceId} -> ${result.snapshotId} (${result.pageCount} pages)`;
          }),
      };
    });
  });

const snapshot = program.command('snapshot');
snapshot
  .command('list')
  .argument('<source-id>')
  .action(async (sourceId: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'snapshot.list', async () => {
      const result = await listSnapshotsForSource(sourceId);
      const snapshots = result.snapshots;
      return {
        data: result,
        human: snapshots.length === 0
          ? `No snapshots for ${sourceId}`
          : [
            `Snapshots for ${sourceId}:`,
            ...snapshots.map((item) => `${item.snapshotId} | pages=${item.pageCount} | created=${item.createdAt}`),
          ],
      };
    });
  });

program
  .command('diff')
  .alias('changes')
  .argument('<source-id>')
  .option('--from <snapshot-id>', 'base snapshot id')
  .option('--to <snapshot-id>', 'target snapshot id')
  .description('Compare two snapshots for a source.')
  .action(
    async (
      sourceId: string,
      options: { from?: string; to?: string },
      command: Command,
    ) => {
      await executeCommand(command, 'diff', async () => {
        const result = await diffSnapshotsForSource({
          sourceId,
          ...(options.from ? { fromSnapshotId: options.from } : {}),
          ...(options.to ? { toSnapshotId: options.to } : {}),
        });

        return {
          data: result,
          human: [
            `Diff ${result.sourceId} | from=${result.fromSnapshotId} | to=${result.toSnapshotId}`,
            `Added=${result.summary.addedPageCount} | Removed=${result.summary.removedPageCount} | Changed=${result.summary.changedPageCount} | Unchanged=${result.summary.unchangedPageCount}`,
          ],
        };
      });
    },
  );

const project = program.command('project');
project
  .command('link')
  .argument('<project-path>')
  .argument('<source-ids...>')
  .action(async (projectPath: string, sourceIds: string[], _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'project.link', async () => {
      const result = await linkProjectSources(projectPath, sourceIds);
      return {
        data: result,
        human: `Linked ${result.projectPath} -> ${sourceIds.join(', ')}`,
      };
    });
  });

project
  .command('unlink')
  .argument('<project-path>')
  .argument('[source-ids...]')
  .action(async (projectPath: string, sourceIds: string[], _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'project.unlink', async () => {
      const result = await unlinkProjectSources(projectPath, sourceIds);
      return {
        data: result,
        human: `Unlinked ${result.projectPath}`,
      };
    });
  });

const workspace = program.command('workspace');

workspace
  .command('create')
  .argument('<workspace-id>')
  .requiredOption('--label <label>', 'workspace label')
  .option('--purpose <purpose>', 'workspace purpose/description')
  .option('--auto-compile', 'automatically recompile after bound-source or raw-input changes')
  .option('--output <format>', 'default output format', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .action(async (
    workspaceId: string,
    options: { label: string; purpose?: string; output?: string[]; autoCompile?: boolean },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.create', async () => {
      const result = await createWorkspace({
        workspaceId,
        label: options.label,
        ...(options.purpose ? { purpose: options.purpose } : {}),
        ...(options.autoCompile ? { autoCompileEnabled: true } : {}),
        ...(options.output && options.output.length > 0 ? { defaultOutputFormats: options.output as Array<'report' | 'slides' | 'summary'> } : {}),
      });
      return {
        data: result,
        human: `Created workspace ${result.workspace.id}`,
      };
    });
  });

workspace
  .command('configure')
  .argument('<workspace-id>')
  .requiredOption('--auto-compile <enabled>', 'set workspace auto-compile to true or false')
  .action(async (
    workspaceId: string,
    options: { autoCompile: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.configure', async () => {
      const normalized = options.autoCompile.trim().toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') {
        throw new AiocsError(
          AIOCS_ERROR_CODES.invalidArgument,
          '--auto-compile must be true or false',
        );
      }
      const result = await updateWorkspaceSettings({
        workspaceId,
        autoCompileEnabled: normalized === 'true',
      });
      return {
        data: result,
        human: `Updated ${workspaceId}: autoCompile=${result.workspace.autoCompileEnabled}`,
      };
    });
  });

workspace
  .command('list')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.list', async () => {
      const result = await listWorkspaceRecords();
      return {
        data: result,
        human: result.workspaces.length === 0
          ? 'No workspaces registered.'
          : result.workspaces.map((item) => [
            item.id,
            item.label,
            `bindings=${item.bindingCount}`,
            `artifacts=${item.artifactCount}`,
            item.lastCompileStatus ? `last=${item.lastCompileStatus}` : 'never compiled',
          ].join(' | ')),
      };
    });
  });

workspace
  .command('bind')
  .argument('<workspace-id>')
  .argument('<source-ids...>')
  .action(async (workspaceId: string, sourceIds: string[], _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.bind', async () => {
      const result = await bindWorkspaceSources({ workspaceId, sourceIds });
      return {
        data: result,
        human: `Bound ${workspaceId} -> ${sourceIds.join(', ')}`,
      };
    });
  });

workspace
  .command('unbind')
  .argument('<workspace-id>')
  .argument('[source-ids...]')
  .action(async (workspaceId: string, sourceIds: string[], _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.unbind', async () => {
      const result = await unbindWorkspaceSources({
        workspaceId,
        ...(sourceIds.length > 0 ? { sourceIds } : {}),
      });
      return {
        data: result,
        human: sourceIds.length > 0
          ? `Unbound ${workspaceId} -> ${sourceIds.join(', ')}`
          : `Unbound all sources from ${workspaceId}`,
      };
    });
  });

workspace
  .command('compile')
  .argument('<workspace-id>')
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.compile', async () => {
      const result = await compileWorkspaceArtifacts(workspaceId);
      return {
        data: result,
        human: result.skipped
          ? `Workspace ${workspaceId} is already up to date.`
          : [
              `Compiled ${workspaceId}`,
              `Changed sources: ${result.changedSourceIds.join(', ') || '(none)'}`,
              `Changed raw inputs: ${result.changedRawInputIds.join(', ') || '(none)'}`,
              ...result.updatedArtifactPaths.map((path) => `- ${path}`),
            ],
      };
    });
  });

workspace
  .command('status')
  .argument('<workspace-id>')
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.status', async () => {
      const result = await getWorkspaceStatus(workspaceId);
      return {
        data: result,
        human: [
          `${result.workspace.id} | ${result.workspace.label}`,
          `Bindings=${result.bindings.length} | RawInputs=${result.rawInputs.length} | Artifacts=${result.artifacts.length} | Runs=${result.compileRuns.length}`,
          `AutoCompile=${result.workspace.autoCompileEnabled} | Health=${result.health.status} | PendingJobs=${result.health.pendingCompileJobs} | FailedJobs=${result.health.failedCompileJobs}`,
          `Links=${result.graph.linkCount} | BrokenLinks=${result.graph.brokenLinkCount} | Orphans=${result.graph.orphanArtifactCount}`,
        ],
      };
    });
  });

workspace
  .command('queue-run')
  .option('--max-jobs <count>', 'maximum queued workspace compile jobs to process')
  .action(async (
    options: { maxJobs?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.queue-run', async () => {
      const maxJobs = parsePositiveIntegerOption(options.maxJobs, 'max-jobs');
      const result = await runQueuedWorkspaceCompiles({
        ...(typeof maxJobs === 'number' ? { maxJobs } : {}),
      });
      return {
        data: result,
        human: [
          `Processed ${result.processedJobs} workspace compile job(s)`,
          ...result.succeededJobs.map((job) => `success | ${job.workspaceId} | sources=${job.changedSourceIds.length} | raw=${job.changedRawInputIds.length}`),
          ...result.failedJobs.map((job) => `failed | ${job.workspaceId} | ${job.errorMessage}`),
        ],
      };
    });
  });

workspace
  .command('search')
  .argument('<workspace-id>')
  .argument('<query>')
  .option('--scope <scope>', 'source, derived, or mixed')
  .option('--mode <mode>', 'search mode: auto, lexical, hybrid, semantic')
  .option('--path <glob>', 'restrict source-side search to file paths matching a glob', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--language <name>', 'restrict source-side search to a language', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--limit <count>', 'maximum number of results to return')
  .option('--offset <count>', 'number of results to skip before returning matches')
  .action(async (
    workspaceId: string,
    query: string,
    options: WorkspaceSearchOptions & { limit?: string; offset?: string; mode?: string; path?: string[]; language?: string[]; scope?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.search', async () => {
      const limit = parsePositiveIntegerOption(options.limit, 'limit');
      const offset = parsePositiveIntegerOption(options.offset, 'offset');
      const mode = parseSearchModeOption(options.mode);
      const result = await searchWorkspaceCatalog(workspaceId, query, {
        ...(options.scope ? { scope: options.scope as 'source' | 'derived' | 'mixed' } : {}),
        ...(mode ? { mode } : {}),
        ...(options.path && options.path.length > 0 ? { path: options.path } : {}),
        ...(options.language && options.language.length > 0 ? { language: options.language } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(typeof offset === 'number' ? { offset } : {}),
      });
      return {
        data: result,
        human: result.results.length === 0
          ? `No workspace results for "${query}" (${result.scope})`
          : [
              `Showing ${result.offset + 1}-${result.offset + result.results.length} of ${result.total} workspace result(s)`,
              ...result.results.map((entry) => renderWorkspaceSearchResult(entry)),
            ],
      };
    });
  });

const workspaceArtifact = workspace.command('artifact');
workspaceArtifact
  .command('list')
  .argument('<workspace-id>')
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.artifact.list', async () => {
      const result = await listWorkspaceArtifacts(workspaceId);
      return {
        data: result,
        human: result.artifacts.length === 0
          ? `No artifacts for ${workspaceId}`
          : result.artifacts.map((artifact) => [
              artifact.path,
              artifact.kind,
              artifact.stale ? 'stale' : 'fresh',
              `chunks=${artifact.chunkCount}`,
            ].join(' | ')),
      };
    });
  });

workspaceArtifact
  .command('show')
  .argument('<workspace-id>')
  .argument('<artifact-path>')
  .action(async (workspaceId: string, artifactPath: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.artifact.show', async () => {
      const result = await showWorkspaceArtifact(workspaceId, artifactPath);
      return {
        data: result,
        human: result.content,
      };
    });
  });

const workspaceIngest = workspace.command('ingest');

workspaceIngest
  .command('add')
  .argument('<workspace-id>')
  .argument('<kind>')
  .argument('<path>')
  .option('--label <label>', 'display label for the raw input')
  .action(async (
    workspaceId: string,
    kind: string,
    path: string,
    options: { label?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.ingest.add', async () => {
      const result = await ingestWorkspaceRawInput({
        workspaceId,
        kind,
        sourcePath: path,
        ...(options.label ? { label: options.label } : {}),
      });
      return {
        data: result,
        human: `Ingested ${result.rawInput.kind} ${result.rawInput.id} into ${workspaceId}`,
      };
    });
  });

workspaceIngest
  .command('list')
  .argument('<workspace-id>')
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.ingest.list', async () => {
      const result = await listWorkspaceRawInputsRecord(workspaceId);
      return {
        data: result,
        human: result.rawInputs.length === 0
          ? `No raw inputs for ${workspaceId}`
          : result.rawInputs.map((rawInput) => [
              rawInput.id,
              rawInput.kind,
              rawInput.label,
              `chunks=${rawInput.chunkCount}`,
            ].join(' | ')),
      };
    });
  });

workspaceIngest
  .command('show')
  .argument('<workspace-id>')
  .argument('<raw-input-id>')
  .action(async (workspaceId: string, rawInputId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.ingest.show', async () => {
      const result = await showWorkspaceRawInput(workspaceId, rawInputId);
      return {
        data: result,
        human: [
          `${result.rawInput.id} | ${result.rawInput.kind} | ${result.rawInput.label}`,
          ...result.chunks.map((chunk) => `${chunk.section_title} | ${chunk.file_path ?? '(root)'}`),
        ],
      };
    });
  });

workspaceIngest
  .command('search')
  .argument('<workspace-id>')
  .argument('<query>')
  .option('--kind <kind>', 'raw input kind filter', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--limit <count>', 'maximum number of results to return')
  .option('--offset <count>', 'number of results to skip')
  .action(async (
    workspaceId: string,
    query: string,
    options: { kind?: string[]; limit?: string; offset?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.ingest.search', async () => {
      const limit = parsePositiveIntegerOption(options.limit, 'limit');
      const offset = parsePositiveIntegerOption(options.offset, 'offset');
      const result = await searchWorkspaceRawInputCatalog({
        workspaceId,
        query,
        ...(options.kind && options.kind.length > 0 ? { kinds: options.kind } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(typeof offset === 'number' ? { offset } : {}),
      });
      return {
        data: result,
        human: result.results.length === 0
          ? `No raw-input matches for "${query}"`
          : [
              `Showing ${result.offset + 1}-${result.offset + result.results.length} of ${result.total} raw-input result(s)`,
              ...result.results.map((entry) => [
                entry.rawInputId,
                entry.kind,
                entry.label,
                entry.sectionTitle,
                entry.filePath ?? '(root)',
              ].join(' | ')),
            ],
      };
    });
  });

workspaceIngest
  .command('remove')
  .argument('<workspace-id>')
  .argument('<raw-input-id>')
  .action(async (workspaceId: string, rawInputId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.ingest.remove', async () => {
      const result = await removeWorkspaceRawInput({ workspaceId, rawInputId });
      return {
        data: result,
        human: `Removed raw input ${rawInputId} from ${workspaceId}`,
      };
    });
  });

workspace
  .command('lint')
  .argument('<workspace-id>')
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    await executeCommand(command, 'workspace.lint', async () => {
      const result = await lintWorkspaceArtifacts(workspaceId);
      return {
        data: result,
        human: [
          `${workspaceId} lint status=${result.summary.status}`,
          ...result.findings.map((finding) => `${finding.kind} | ${finding.artifactPath ?? finding.sourceId ?? '(workspace)'} | ${finding.summary}`),
        ],
      };
    });
  });

workspace
  .command('output')
  .argument('<workspace-id>')
  .argument('<format>')
  .option('--name <name>', 'output file slug')
  .option('--prompt <prompt>', 'extra output instructions')
  .action(async (
    workspaceId: string,
    format: string,
    options: { name?: string; prompt?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.output', async () => {
      const result = await generateWorkspaceArtifactOutput({
        workspaceId,
        format: format as 'report' | 'slides' | 'summary',
        ...(options.name ? { name: options.name } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
      });
      return {
        data: result,
        human: `Generated ${result.format} at ${result.path}`,
      };
    });
  });

workspace
  .command('answer')
  .argument('<workspace-id>')
  .argument('<format>')
  .argument('<question>')
  .option('--name <name>', 'output file slug')
  .action(async (
    workspaceId: string,
    format: string,
    question: string,
    options: { name?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.answer', async () => {
      const result = await answerWorkspace({
        workspaceId,
        format,
        question,
        ...(options.name ? { name: options.name } : {}),
      });
      return {
        data: result,
        human: `Answered into ${result.path} (${result.format})`,
      };
    });
  });

const workspaceSync = workspace.command('sync');
workspaceSync
  .command('obsidian')
  .argument('<workspace-id>')
  .argument('<vault-path>')
  .option('--export-subdir <subdir>', 'vault subdirectory to sync into')
  .action(async (
    workspaceId: string,
    vaultPath: string,
    options: { exportSubdir?: string },
    command: Command,
  ) => {
    await executeCommand(command, 'workspace.sync.obsidian', async () => {
      const result = await syncWorkspaceToObsidianVault({
        workspaceId,
        vaultPath,
        ...(options.exportSubdir ? { exportSubdir: options.exportSubdir } : {}),
      });
      return {
        data: result,
        human: `Synced ${workspaceId} to ${result.targetPath}`,
      };
    });
  });

const backup = program.command('backup');
backup
  .command('export')
  .argument('<output-dir>')
  .option('--replace-existing', 'replace an existing non-empty export directory')
  .action(
    async (
      outputDir: string,
      options: { replaceExisting?: boolean },
      command: Command,
    ) => {
      await executeCommand(command, 'backup.export', async () => {
        const result = await exportCatalogBackup({
          outputDir,
          ...(typeof options.replaceExisting === 'boolean' ? { replaceExisting: options.replaceExisting } : {}),
        });
        return {
          data: result,
          human: `Exported backup to ${result.outputDir}`,
        };
      });
    },
  );

backup
  .command('import')
  .argument('<input-dir>')
  .option('--replace-existing', 'replace an existing local aiocs data/config directory')
  .action(
    async (
      inputDir: string,
      options: { replaceExisting?: boolean },
      command: Command,
    ) => {
      await executeCommand(command, 'backup.import', async () => {
        const result = await importCatalogBackup({
          inputDir,
          ...(typeof options.replaceExisting === 'boolean' ? { replaceExisting: options.replaceExisting } : {}),
        });
        return {
          data: result,
          human: `Imported backup from ${result.inputDir}`,
        };
      });
    },
  );

const embeddings = program.command('embeddings');
embeddings
  .command('status')
  .description('Show embedding backlog and coverage for latest snapshots.')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'embeddings.status', async () => {
      const result = await getEmbeddingStatus();
      return {
        data: result,
        human: [
          `Queue | pending=${result.queue.pendingJobs} running=${result.queue.runningJobs} failed=${result.queue.failedJobs}`,
          ...result.sources.map((source) => [
            source.sourceId,
            source.snapshotId ?? '(none)',
            `coverage=${Math.round(source.coverageRatio * 100)}%`,
            `indexed=${source.indexedChunks}/${source.totalChunks}`,
            `pending=${source.pendingChunks}`,
            `failed=${source.failedChunks}`,
            `stale=${source.staleChunks}`,
          ].join(' | ')),
        ],
      };
    });
  });

embeddings
  .command('backfill')
  .argument('<source-id-or-all>')
  .description('Queue latest snapshots for embedding rebuild.')
  .action(async (sourceIdOrAll: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'embeddings.backfill', async () => {
      const result = await backfillEmbeddings(sourceIdOrAll);
      return {
        data: result,
        human: `Queued ${result.queuedJobs} embedding job(s)`,
      };
    });
  });

embeddings
  .command('clear')
  .argument('<source-id-or-all>')
  .description('Clear derived embedding state for latest snapshots.')
  .action(async (sourceIdOrAll: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'embeddings.clear', async () => {
      const result = await clearEmbeddings(sourceIdOrAll);
      return {
        data: result,
        human: result.clearedSources.length === 0
          ? 'No embedding state cleared.'
          : `Cleared embedding state for ${result.clearedSources.join(', ')}`,
      };
    });
  });

embeddings
  .command('run')
  .description('Process queued embedding jobs immediately.')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'embeddings.run', async () => {
      const result = await runEmbeddingWorker();
      return {
        data: result,
        human: [
          `Processed ${result.processedJobs} embedding job(s)`,
          ...result.succeededJobs.map((job) =>
            `Embedded ${job.sourceId} -> ${job.snapshotId} (${job.chunkCount} chunks)`),
          ...result.failedJobs.map((job) =>
            `Embedding failed ${job.sourceId} -> ${job.snapshotId}: ${job.errorMessage}`),
        ],
      };
    });
  });

program
  .command('search')
  .argument('<query>')
  .option('--source <source-id>', 'restrict search to a source', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--snapshot <snapshot-id>', 'search a specific snapshot')
  .option('--all', 'search across all latest snapshots')
  .option('--project <path>', 'resolve search scope as if running from this path')
  .option('--path <glob>', 'restrict search to file paths matching a glob', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--language <name>', 'restrict search to a language', (value, current: string[]) => {
    current.push(value);
    return current;
  }, [])
  .option('--mode <mode>', 'search mode: auto, lexical, hybrid, semantic')
  .option('--limit <count>', 'maximum number of results to return')
  .option('--offset <count>', 'number of results to skip before returning matches')
  .action(async (
    query: string,
    options: SearchOptions & { limit?: string; offset?: string; mode?: string; path?: string[]; language?: string[] },
    command: Command,
  ) => {
    await executeCommand(command, 'search', async () => {
      const limit = parsePositiveIntegerOption(options.limit, 'limit');
      const offset = parsePositiveIntegerOption(options.offset, 'offset');
      const mode = parseSearchModeOption(options.mode);
      const result = await searchCatalog(query, {
        source: options.source,
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        ...(typeof options.all !== 'undefined' ? { all: options.all } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.path && options.path.length > 0 ? { path: options.path } : {}),
        ...(options.language && options.language.length > 0 ? { language: options.language } : {}),
        ...(mode ? { mode } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(typeof offset === 'number' ? { offset } : {}),
      });
      const results = result.results;

      return {
        data: result,
        human: results.length === 0
          ? `No results for "${query}" (mode=${result.modeUsed})`
          : [
            `Showing ${result.offset + 1}-${result.offset + results.length} of ${result.total} result(s) for "${query}" | mode=${result.modeUsed}`,
            ...results.map((entry) => renderSearchResult(entry)),
          ],
      };
    });
  });

const verify = program.command('verify');
verify
  .command('coverage')
  .argument('<source-id>')
  .argument('<reference-files...>')
  .option('--snapshot <snapshot-id>', 'verify a specific snapshot instead of the latest successful snapshot')
  .action(
    async (
      sourceId: string,
      referenceFiles: string[],
      options: { snapshot?: string },
      command: Command,
    ) => {
      await executeCommand(command, 'verify.coverage', async () => {
        const result = await verifyCoverage({
          sourceId,
          referenceFiles,
          ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
        });

        return {
          data: result,
          human: [
            `Coverage ${result.complete ? 'complete' : 'incomplete'} for ${result.sourceId} @ ${result.snapshotId}`,
            `Files=${result.summary.fileCount} | headings=${result.summary.headingCount} | matched=${result.summary.matchedHeadingCount} | missing=${result.summary.missingHeadingCount}`,
            ...result.files.flatMap((file) => file.missingHeadings.length > 0
              ? [
                  `Missing in ${file.referenceFile}:`,
                  ...file.missingHeadings.map((heading) => `- ${heading}`),
                ]
              : [`No missing headings in ${file.referenceFile}`]),
          ],
        };
      });
    },
  );

program
  .command('show')
  .argument('<chunk-id>')
  .action(async (chunkId: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'show', async () => {
      const result = await showChunk(Number(chunkId));
      return {
        data: result,
        human: renderSearchResult(result.chunk),
      };
    });
  });

program
  .command('daemon')
  .description('Run scheduled local refreshes in a long-lived process.')
  .action(async (_options: unknown, command: Command) => {
    const json = commandWantsJson(command);
    const logger = createDaemonLogger(json);
    const abortController = new AbortController();
    const stop = () => abortController.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    try {
      const config = parseDaemonConfig(process.env);
      const dataDir = getAiocsDataDir();
      getAiocsConfigDir();
      const catalog = openCatalog({ dataDir });
      try {
        await startDaemon({
          catalog,
          dataDir,
          config,
          logger,
          signal: abortController.signal,
        });
      } finally {
        catalog.close();
      }
    } catch (error) {
      emitError({
        json,
        commandName: 'daemon',
        error,
      });
      process.exitCode = 1;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
    process.exitCode = 0;
    return;
  }

  emitError({
    json: argvWantsJson(process.argv),
    commandName: inferRequestedCommand(process.argv.slice(2)),
    error,
  });
  process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
});
