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
import {
  fetchSources,
  getDoctorReport,
  initBuiltInSources,
  linkProjectSources,
  listSnapshotsForSource,
  listSources,
  searchCatalog,
  showChunk,
  type SearchOptions,
  unlinkProjectSources,
  upsertSourceFromSpecFile,
  refreshDueSources,
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
}): string {
  return [
    `Chunk ID: ${result.chunkId}`,
    `Source: ${result.sourceId}`,
    `Snapshot: ${result.snapshotId}`,
    `Page: ${result.pageTitle}`,
    `Section: ${result.sectionTitle}`,
    `URL: ${result.pageUrl}`,
    '',
    result.markdown,
    '',
  ].join('\n');
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
            `due=${event.result.dueSourceIds.length}`,
            `refreshed=${event.result.refreshed.length}`,
            `failed=${event.result.failed.length}`,
          ].join(' | '));
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
            `next due ${item.nextDueAt}`,
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

const refresh = program.command('refresh');
refresh
  .command('due')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'refresh.due', async () => {
      const result = await refreshDueSources();
      const results = result.results;

      return {
        data: result,
        human: results.length === 0
          ? 'No sources due for refresh.'
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
  .action(async (query: string, options: SearchOptions, command: Command) => {
    await executeCommand(command, 'search', async () => {
      const result = await searchCatalog(query, options);
      const results = result.results;

      return {
        data: result,
        human: results.length === 0
          ? `No results for "${query}"`
          : results.map((result) => renderSearchResult(result)),
      };
    });
  });

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
