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
  diffSnapshotsForSource,
  getEmbeddingStatus,
  exportCatalogBackup,
  importCatalogBackup,
  fetchSources,
  getDoctorReport,
  initBuiltInSources,
  linkProjectSources,
  listSnapshotsForSource,
  listSources,
  runSourceCanaries,
  runEmbeddingWorker,
  searchCatalog,
  showChunk,
  type SearchOptions,
  unlinkProjectSources,
  upsertSourceFromSpecFile,
  verifyCoverage,
  refreshDueSources,
  getManagedSourceSpecDirectories,
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
  score?: number;
  signals?: Array<'lexical' | 'vector'>;
}): string {
  return [
    `Chunk ID: ${result.chunkId}`,
    `Source: ${result.sourceId}`,
    `Snapshot: ${result.snapshotId}`,
    ...(typeof result.score === 'number' ? [`Score: ${result.score.toFixed(4)}`] : []),
    ...(result.signals ? [`Signals: ${result.signals.join(', ')}`] : []),
    `Page: ${result.pageTitle}`,
    `Section: ${result.sectionTitle}`,
    `URL: ${result.pageUrl}`,
    '',
    result.markdown,
    '',
  ].join('\n');
}

function parsePositiveIntegerOption(
  value: string | undefined,
  field: 'limit' | 'offset',
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
  .description('Register bundled built-in source specs and optionally fetch them.')
  .option('--fetch', 'fetch built-in sources immediately')
  .option('--no-fetch', 'skip immediate fetching after bootstrapping')
  .action(async (options: { fetch?: boolean }, command: Command) => {
    await executeCommand(command, 'init', async () => {
      const result = await initBuiltInSources({
        fetch: options.fetch ?? false,
      });

      return {
        data: result,
        human: [
          `Initialized ${result.initializedSources.length} built-in sources from ${result.sourceSpecDir}`,
          `User-managed source specs live under ${getManagedSourceSpecDirectories().userSourceDir}`,
          ...(result.removedSourceIds.length > 0
            ? [`Removed managed sources: ${result.removedSourceIds.join(', ')}`]
            : []),
          ...(result.fetchResults.length > 0
            ? result.fetchResults.map((entry) => {
                const verb = entry.reused ? 'Reused' : 'Fetched';
                return `${verb} ${entry.sourceId} -> ${entry.snapshotId} (${entry.pageCount} pages)`;
              })
            : [result.fetched ? 'No built-in sources were fetched.' : 'Skipped fetching built-in sources.']),
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
  .option('--mode <mode>', 'search mode: auto, lexical, hybrid, semantic')
  .option('--limit <count>', 'maximum number of results to return')
  .option('--offset <count>', 'number of results to skip before returning matches')
  .action(async (
    query: string,
    options: SearchOptions & { limit?: string; offset?: string; mode?: string },
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
