#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';

import { openCatalog } from './catalog/catalog.js';
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

const program = new Command();
program
  .name('docs')
  .description('Local-only docs fetch and search CLI for AI agents.')
  .showHelpAfterError();

const source = program.command('source');

source
  .command('upsert')
  .argument('<spec-file>')
  .action(async (specFile: string) => {
    await withCatalog(async ({ catalog }) => {
      const spec = await loadSourceSpec(specFile);
      catalog.upsertSource(spec);
      console.log(`Upserted source ${spec.id}`);
    });
  });

source
  .command('list')
  .action(async () => {
    await withCatalog(({ catalog }) => {
      const sources = catalog.listSources();
      if (sources.length === 0) {
        console.log('No sources registered.');
        return;
      }

      for (const item of sources) {
        console.log([
          item.id,
          item.label,
          `next due ${item.nextDueAt}`,
          item.lastSuccessfulSnapshotId ? `latest ${item.lastSuccessfulSnapshotId}` : 'no snapshots',
        ].join(' | '));
      }
    });
  });

program
  .command('fetch')
  .argument('<source-id-or-all>')
  .action(async (sourceIdOrAll: string) => {
    await withCatalog(async ({ catalog, dataDir }) => {
      const sourceIds = sourceIdOrAll === 'all'
        ? catalog.listSources().map((item) => item.id)
        : [sourceIdOrAll];

      if (sourceIds.length === 0) {
        console.log('No sources registered.');
        return;
      }

      for (const sourceId of sourceIds) {
        const result = await fetchSource({ catalog, sourceId, dataDir });
        const verb = result.reused ? 'Reused' : 'Fetched';
        console.log(`${verb} ${sourceId} -> ${result.snapshotId} (${result.pageCount} pages)`);
      }
    });
  });

program
  .command('refresh')
  .command('due')
  .action(async () => {
    await withCatalog(async ({ catalog, dataDir }) => {
      const dueIds = catalog.listDueSourceIds();
      if (dueIds.length === 0) {
        console.log('No sources due for refresh.');
        return;
      }

      for (const sourceId of dueIds) {
        const result = await fetchSource({ catalog, sourceId, dataDir });
        const verb = result.reused ? 'Reused' : 'Fetched';
        console.log(`${verb} ${sourceId} -> ${result.snapshotId} (${result.pageCount} pages)`);
      }
    });
  });

const snapshot = program.command('snapshot');
snapshot
  .command('list')
  .argument('<source-id>')
  .action(async (sourceId: string) => {
    await withCatalog(({ catalog }) => {
      const snapshots = catalog.listSnapshots(sourceId);
      if (snapshots.length === 0) {
        console.log(`No snapshots for ${sourceId}`);
        return;
      }

      console.log(`Snapshots for ${sourceId}:`);
      for (const item of snapshots) {
        console.log(`${item.snapshotId} | pages=${item.pageCount} | created=${item.createdAt}`);
      }
    });
  });

const project = program.command('project');
project
  .command('link')
  .argument('<project-path>')
  .argument('<source-ids...>')
  .action(async (projectPath: string, sourceIds: string[]) => {
    await withCatalog(({ catalog }) => {
      catalog.linkProject(projectPath, sourceIds);
      console.log(`Linked ${resolve(projectPath)} -> ${sourceIds.join(', ')}`);
    });
  });

project
  .command('unlink')
  .argument('<project-path>')
  .argument('[source-ids...]')
  .action(async (projectPath: string, sourceIds?: string[]) => {
    await withCatalog(({ catalog }) => {
      catalog.unlinkProject(projectPath, sourceIds);
      console.log(`Unlinked ${resolve(projectPath)}`);
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
  .action(async (query: string, options: SearchOptions) => {
    await withCatalog(({ catalog }) => {
      const cwd = options.project ? resolve(options.project) : process.cwd();
      const explicitSources = options.source.length > 0;
      const scope = resolveProjectScope(cwd, catalog.listProjectLinks());

      if (!explicitSources && !options.all && !scope) {
        throw new Error('No linked project scope found. Use --source or --all.');
      }

      const results = catalog.search({
        query,
        cwd,
        ...(explicitSources ? { sourceIds: options.source } : {}),
        ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
        ...(options.all ? { all: true } : {}),
      });

      if (results.length === 0) {
        console.log(`No results for "${query}"`);
        return;
      }

      for (const result of results) {
        console.log(renderSearchResult(result));
      }
    });
  });

program
  .command('show')
  .argument('<chunk-id>')
  .action(async (chunkId: string) => {
    await withCatalog(({ catalog }) => {
      const chunk = catalog.getChunkById(Number(chunkId));
      if (!chunk) {
        throw new Error(`Chunk ${chunkId} not found`);
      }

      console.log(renderSearchResult(chunk));
    });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
