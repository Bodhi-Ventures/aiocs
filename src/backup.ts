import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { packageVersion } from './runtime/package-metadata.js';
import { AiocsError, AIOCS_ERROR_CODES } from './errors.js';

type BackupEntry = {
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
};

type BackupManifest = {
  formatVersion: 1;
  createdAt: string;
  packageVersion: string;
  entries: BackupEntry[];
};

type ValidatedBackupPayload = {
  manifest: BackupManifest;
  backupDataDir: string;
  backupConfigDir?: string;
};

const CATALOG_DB_FILENAME = 'catalog.sqlite';
const SQLITE_SIDE_CAR_SUFFIXES = ['-wal', '-shm'];

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSourceDirExists(path: string): Promise<void> {
  if (!await pathExists(path)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupSourceMissing,
      `Backup source path does not exist: ${path}`,
    );
  }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
  if (!await pathExists(path)) {
    return true;
  }

  return (await readdir(path)).length === 0;
}

async function listEntries(root: string, relativePath = ''): Promise<BackupEntry[]> {
  const absolutePath = relativePath ? join(root, relativePath) : root;
  const stats = await stat(absolutePath);

  if (!stats.isDirectory()) {
    return [{
      relativePath,
      type: 'file',
      size: stats.size,
    }];
  }

  const childNames = await readdir(absolutePath);
  const entries: BackupEntry[] = relativePath
    ? [{
        relativePath,
        type: 'directory',
        size: 0,
      }]
    : [];

  for (const childName of childNames.sort()) {
    entries.push(...await listEntries(root, relativePath ? join(relativePath, childName) : childName));
  }

  return entries;
}

async function copyIfPresent(from: string, to: string, entries: BackupEntry[], relativePrefix: string): Promise<void> {
  if (!await pathExists(from)) {
    return;
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, force: true });
  const copiedEntries = await listEntries(to);
  entries.push(
    ...copiedEntries.map((entry) => ({
      ...entry,
      relativePath: join(relativePrefix, entry.relativePath),
    })),
  );
}

async function copyDataDirForBackup(from: string, to: string): Promise<void> {
  const sourceCatalogPath = join(from, CATALOG_DB_FILENAME);
  if (!await pathExists(sourceCatalogPath)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupSourceMissing,
      `Backup source is missing the catalog database: ${sourceCatalogPath}`,
    );
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = basename(source);
      if (name === CATALOG_DB_FILENAME) {
        return false;
      }
      if (name === 'git-mirrors') {
        return false;
      }
      return !SQLITE_SIDE_CAR_SUFFIXES.some((suffix) => name === `${CATALOG_DB_FILENAME}${suffix}`);
    },
  });

  const targetCatalogPath = join(to, CATALOG_DB_FILENAME);
  const sourceCatalog = new Database(sourceCatalogPath, { readonly: true });
  try {
    await sourceCatalog.backup(targetCatalogPath);
  } finally {
    sourceCatalog.close();
  }
}

async function loadValidatedBackupPayload(inputDir: string): Promise<ValidatedBackupPayload> {
  const manifestPath = join(inputDir, 'manifest.json');

  await assertSourceDirExists(inputDir);
  if (!await pathExists(manifestPath)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupInvalid,
      `Backup manifest not found: ${manifestPath}`,
    );
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<BackupManifest>;
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupInvalid,
      `Invalid backup manifest: ${manifestPath}`,
    );
  }

  const backupDataDir = join(inputDir, 'data');
  if (!await pathExists(backupDataDir)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupInvalid,
      `Backup payload is missing the data directory: ${backupDataDir}`,
    );
  }

  const backupCatalogPath = join(backupDataDir, CATALOG_DB_FILENAME);
  if (!await pathExists(backupCatalogPath)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.backupInvalid,
      `Backup payload is missing the catalog database: ${backupCatalogPath}`,
    );
  }

  const backupConfigDir = join(inputDir, 'config');

  return {
    manifest: manifest as BackupManifest,
    backupDataDir,
    ...(await pathExists(backupConfigDir) ? { backupConfigDir } : {}),
  };
}

async function prepareReplacementTarget(
  backupDir: string,
  targetDir: string,
): Promise<string> {
  const parentDir = dirname(targetDir);
  const stagingDir = join(parentDir, `.${basename(targetDir)}.import-${randomUUID()}`);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(parentDir, { recursive: true });
  await cp(backupDir, stagingDir, { recursive: true, force: true });

  return stagingDir;
}

export async function exportBackup(input: {
  dataDir: string;
  outputDir: string;
  configDir?: string;
  replaceExisting?: boolean;
}): Promise<{
  outputDir: string;
  manifestPath: string;
  manifest: BackupManifest;
}> {
  const dataDir = resolve(input.dataDir);
  const outputDir = resolve(input.outputDir);
  const configDir = input.configDir ? resolve(input.configDir) : undefined;
  await assertSourceDirExists(dataDir);

  if (!await isDirectoryEmpty(outputDir)) {
    if (!input.replaceExisting) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.backupConflict,
        `Backup output directory is not empty: ${outputDir}`,
      );
    }
    await rm(outputDir, { recursive: true, force: true });
  }

  await mkdir(outputDir, { recursive: true });
  const entries: BackupEntry[] = [];

  await copyDataDirForBackup(dataDir, join(outputDir, 'data'));
  entries.push(...(await listEntries(join(outputDir, 'data'))).map((entry) => ({
    ...entry,
    relativePath: join('data', entry.relativePath),
  })));
  if (configDir) {
    await copyIfPresent(configDir, join(outputDir, 'config'), entries, 'config');
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    packageVersion,
    entries,
  };

  const manifestPath = join(outputDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

export async function importBackup(input: {
  inputDir: string;
  dataDir: string;
  configDir?: string;
  replaceExisting?: boolean;
}): Promise<{
  inputDir: string;
  dataDir: string;
  configDir?: string;
  manifest: BackupManifest;
}> {
  const inputDir = resolve(input.inputDir);
  const dataDir = resolve(input.dataDir);
  const configDir = input.configDir ? resolve(input.configDir) : undefined;
  const { manifest, backupDataDir, backupConfigDir } = await loadValidatedBackupPayload(inputDir);

  if (!await isDirectoryEmpty(dataDir)) {
    if (!input.replaceExisting) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.backupConflict,
        `Backup target data directory is not empty: ${dataDir}`,
      );
    }
  }

  if (configDir && backupConfigDir && !await isDirectoryEmpty(configDir)) {
    if (!input.replaceExisting) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.backupConflict,
        `Backup target config directory is not empty: ${configDir}`,
      );
    }
  }

  const stagedDataDir = await prepareReplacementTarget(backupDataDir, dataDir);
  const stagedConfigDir = configDir && backupConfigDir
    ? await prepareReplacementTarget(backupConfigDir, configDir)
    : undefined;

  try {
    await rm(dataDir, { recursive: true, force: true });
    await rename(stagedDataDir, dataDir);

    if (configDir && stagedConfigDir) {
      await rm(configDir, { recursive: true, force: true });
      await rename(stagedConfigDir, configDir);
    }
  } catch (error) {
    await rm(stagedDataDir, { recursive: true, force: true });
    if (stagedConfigDir) {
      await rm(stagedConfigDir, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    inputDir,
    dataDir,
    ...(configDir ? { configDir } : {}),
    manifest: manifest as BackupManifest,
  };
}
