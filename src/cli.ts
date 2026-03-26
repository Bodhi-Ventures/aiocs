#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import { resolve } from 'node:path';

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
import { resolveProjectScope } from './catalog/project-scope.js';
import { fetchSource } from './fetch/fetch-source.js';
import { getAiocsConfigDir, getAiocsDataDir } from './runtime/paths.js';
import { loadSourceSpec } from './spec/source-spec.js';

type SearchOptions = {
  source: string[];
  snapshot?: string;
  all?: boolean;
  project?: string;
};

type CommandResult<TData> = {
  data: TData;
  human?: HumanOutput;
};

function createCatalog() {
  const dataDir = getAiocsDataDir();
  getAiocsConfigDir();
  return {
    dataDir,
    catalog: openCatalog({ dataDir }),
  };
}

function withCatalog<T>(run: (ctx: { dataDir: string; catalog: ReturnType<typeof openCatalog> }) => Promise<T> | T): Promise<T> {
  const ctx = createCatalog();
  return Promise.resolve(run(ctx)).finally(() => ctx.catalog.close());
}

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

const source = program.command('source');

source
  .command('upsert')
  .argument('<spec-file>')
  .action(async (specFile: string, _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'source.upsert', async () => {
      const specPath = resolve(specFile);
      const spec = await loadSourceSpec(specPath);
      const result = await withCatalog(({ catalog }) => catalog.upsertSource(spec, { specPath }));

      return {
        data: {
          sourceId: result.sourceId,
          configHash: result.configHash,
          specPath,
        },
        human: `Upserted source ${spec.id}`,
      };
    });
  });

source
  .command('list')
  .action(async (_options: unknown, command: Command) => {
    await executeCommand(command, 'source.list', async () => {
      const sources = await withCatalog(({ catalog }) => catalog.listSources());
      return {
        data: {
          sources,
        },
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
      const results = await withCatalog(async ({ catalog, dataDir }) => {
        const sourceIds = sourceIdOrAll === 'all'
          ? catalog.listSources().map((item) => item.id)
          : [sourceIdOrAll];

        if (sourceIds.length === 0) {
          return [];
        }

        const fetched = [];
        for (const sourceId of sourceIds) {
          const result = await fetchSource({ catalog, sourceId, dataDir });
          fetched.push({
            sourceId,
            snapshotId: result.snapshotId,
            pageCount: result.pageCount,
            reused: result.reused,
          });
        }
        return fetched;
      });

      return {
        data: {
          results,
        },
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
      const results = await withCatalog(async ({ catalog, dataDir }) => {
        const dueIds = catalog.listDueSourceIds();
        const fetched = [];

        for (const sourceId of dueIds) {
          const result = await fetchSource({ catalog, sourceId, dataDir });
          fetched.push({
            sourceId,
            snapshotId: result.snapshotId,
            pageCount: result.pageCount,
            reused: result.reused,
          });
        }

        return fetched;
      });

      return {
        data: {
          results,
        },
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
      const snapshots = await withCatalog(({ catalog }) => catalog.listSnapshots(sourceId));
      return {
        data: {
          sourceId,
          snapshots,
        },
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
      const resolvedProjectPath = resolve(projectPath);
      await withCatalog(({ catalog }) => {
        catalog.linkProject(resolvedProjectPath, sourceIds);
      });
      return {
        data: {
          projectPath: resolvedProjectPath,
          sourceIds,
        },
        human: `Linked ${resolvedProjectPath} -> ${sourceIds.join(', ')}`,
      };
    });
  });

project
  .command('unlink')
  .argument('<project-path>')
  .argument('[source-ids...]')
  .action(async (projectPath: string, sourceIds: string[], _options: Record<string, never>, command: Command) => {
    await executeCommand(command, 'project.unlink', async () => {
      const resolvedProjectPath = resolve(projectPath);
      await withCatalog(({ catalog }) => {
        catalog.unlinkProject(resolvedProjectPath, sourceIds);
      });
      return {
        data: {
          projectPath: resolvedProjectPath,
          sourceIds,
        },
        human: `Unlinked ${resolvedProjectPath}`,
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
      const cwd = options.project ? resolve(options.project) : process.cwd();
      const explicitSources = options.source.length > 0;
      const results = await withCatalog(({ catalog }) => {
        const scope = resolveProjectScope(cwd, catalog.listProjectLinks());

        if (!explicitSources && !options.all && !scope) {
          throw new Error('No linked project scope found. Use --source or --all.');
        }

        return catalog.search({
          query,
          cwd,
          ...(explicitSources ? { sourceIds: options.source } : {}),
          ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
          ...(options.all ? { all: true } : {}),
        });
      });

      return {
        data: {
          query,
          results,
        },
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
      const chunk = await withCatalog(({ catalog }) => catalog.getChunkById(Number(chunkId)));
      if (!chunk) {
        throw new Error(`Chunk ${chunkId} not found`);
      }

      return {
        data: {
          chunk,
        },
        human: renderSearchResult(chunk),
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
      await withCatalog(async ({ catalog, dataDir }) => {
        await startDaemon({
          catalog,
          dataDir,
          config,
          logger,
          signal: abortController.signal,
        });
      });
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
