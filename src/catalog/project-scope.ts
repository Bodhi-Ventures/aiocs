import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type ProjectScope = {
  projectPath: string;
  sourceIds: string[];
};

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function canonicalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectScope(cwd: string, scopes: ProjectScope[]): ProjectScope | null {
  const normalizedCwd = canonicalizeProjectPath(cwd);
  const normalizedScopes = scopes
    .map((scope) => ({
      projectPath: canonicalizeProjectPath(scope.projectPath),
      sourceIds: [...scope.sourceIds],
    }))
    .filter((scope) => isWithin(normalizedCwd, scope.projectPath))
    .sort((left, right) => right.projectPath.length - left.projectPath.length);

  return normalizedScopes[0] ?? null;
}
