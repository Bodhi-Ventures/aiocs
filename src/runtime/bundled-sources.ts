import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (existsSync(join(currentDir, 'package.json')) && existsSync(join(currentDir, 'sources'))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not locate aiocs package root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

export function getBundledSourcesDir(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(currentFilePath));
  return join(packageRoot, 'sources');
}
