import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export const SOURCE_SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

export function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const rawPath of paths) {
    const normalized = resolve(rawPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function walkSourceSpecFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const discovered: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...await walkSourceSpecFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (SOURCE_SPEC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      discovered.push(entryPath);
    }
  }

  return discovered;
}
