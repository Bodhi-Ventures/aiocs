import { dirname, normalize, posix } from 'node:path';

import type { openCatalog } from '../catalog/catalog.js';

export type SourceArtifactBundle = {
  summaryPath: string;
  conceptPath: string;
};

export type RawInputArtifactBundle = {
  summaryPath: string;
  conceptPath: string;
};

export type WorkspaceLinkTarget = {
  targetPath: string;
  anchorText: string | null;
};

type Catalog = ReturnType<typeof openCatalog>;

export function getSourceArtifactBundle(sourceId: string): SourceArtifactBundle {
  return {
    summaryPath: `derived/sources/${sourceId}/summary.md`,
    conceptPath: `derived/concepts/${sourceId}.md`,
  };
}

export function getWorkspaceIndexPath(): string {
  return 'derived/index.md';
}

export function getRawInputArtifactBundle(rawInputId: string): RawInputArtifactBundle {
  return {
    summaryPath: `derived/raw/${rawInputId}/summary.md`,
    conceptPath: `derived/raw/${rawInputId}/concept.md`,
  };
}

export function getWorkspaceLatestSnapshotMap(
  catalog: Catalog,
  sourceIds: string[],
): Map<string, string> {
  return new Map(
    catalog.listLatestSnapshots(sourceIds).map((entry) => [entry.sourceId, entry.snapshotId]),
  );
}

export function getExpectedArtifactSourceIds(artifactPath: string, boundSourceIds: string[]): string[] {
  if (artifactPath === getWorkspaceIndexPath()) {
    return [...boundSourceIds];
  }

  if (artifactPath.startsWith('derived/raw/') || artifactPath.startsWith('outputs/') || artifactPath.startsWith('derived/notes/')) {
    return [];
  }

  for (const sourceId of boundSourceIds) {
    const bundle = getSourceArtifactBundle(sourceId);
    if (artifactPath === bundle.summaryPath || artifactPath === bundle.conceptPath) {
      return [sourceId];
    }
  }

  return [...new Set(boundSourceIds)];
}

export function getExpectedArtifactRawInputIds(artifactPath: string, rawInputIds: string[]): string[] {
  if (artifactPath === getWorkspaceIndexPath()) {
    return [...rawInputIds];
  }

  for (const rawInputId of rawInputIds) {
    const bundle = getRawInputArtifactBundle(rawInputId);
    if (artifactPath === bundle.summaryPath || artifactPath === bundle.conceptPath) {
      return [rawInputId];
    }
  }

  return [];
}

export function assessWorkspaceArtifactFreshness(input: {
  catalog: Catalog;
  workspaceId: string;
  artifactPath: string;
  boundSourceIds: string[];
  latestSnapshots: Map<string, string>;
}): {
  provenance: ReturnType<Catalog['listWorkspaceArtifactProvenance']>;
  expectedSourceIds: string[];
  missingProvenance: boolean;
  stale: boolean;
} {
  const provenance = input.catalog.listWorkspaceArtifactProvenance(input.workspaceId, input.artifactPath);
  const expectedSourceIds = getExpectedArtifactSourceIds(input.artifactPath, input.boundSourceIds);
  const latestSnapshotEntries = expectedSourceIds.map((sourceId) => [sourceId, input.latestSnapshots.get(sourceId)] as const);
  const provenanceBySource = new Map(provenance.map((entry) => [entry.sourceId, entry.snapshotId]));
  const missingProvenance = expectedSourceIds.some((sourceId) => !provenanceBySource.has(sourceId));
  const stale = missingProvenance || latestSnapshotEntries.some(([sourceId, latestSnapshotId]) => {
    if (!latestSnapshotId) {
      return true;
    }

    return provenanceBySource.get(sourceId) !== latestSnapshotId;
  });

  return {
    provenance,
    expectedSourceIds,
    missingProvenance,
    stale,
  };
}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function getWorkspaceOutputPath(format: 'report' | 'slides' | 'summary', name?: string): string {
  const baseName = slugifySegment(name && name.trim().length > 0 ? name : new Date().toISOString().replace(/[:.]/g, '-'));

  switch (format) {
    case 'report':
      return `outputs/reports/${baseName}.md`;
    case 'slides':
      return `outputs/slides/${baseName}.md`;
    case 'summary':
      return `outputs/summaries/${baseName}.md`;
  }
}

export function getWorkspaceAnswerPath(
  format: 'report' | 'slides' | 'summary' | 'note',
  name?: string,
): string {
  const baseName = slugifySegment(name && name.trim().length > 0 ? name : new Date().toISOString().replace(/[:.]/g, '-'));
  switch (format) {
    case 'report':
      return `outputs/answers/reports/${baseName}.md`;
    case 'slides':
      return `outputs/answers/slides/${baseName}.md`;
    case 'summary':
      return `outputs/answers/summaries/${baseName}.md`;
    case 'note':
      return `derived/notes/${baseName}.md`;
  }
}

export function getWorkspaceSuggestionPath(name = 'lint'): string {
  const baseName = slugifySegment(name);
  return `outputs/suggestions/${baseName}.md`;
}

export function getWorkspaceObsidianExportSubdir(workspaceId: string): string {
  return posix.join('aiocs', workspaceId);
}

export function isWorkspaceOutputArtifactPath(path: string): boolean {
  return path.startsWith('outputs/') || path.startsWith('derived/notes/');
}

export function listWorkspaceOutputArtifactPaths(
  catalog: Catalog,
  workspaceId: string,
): string[] {
  return catalog
    .listWorkspaceArtifacts(workspaceId)
    .map((artifact) => artifact.path)
    .filter((path) => isWorkspaceOutputArtifactPath(path));
}

function normalizeWorkspaceRelativePath(input: string): string | null {
  const normalized = normalize(input).replace(/\\/g, '/');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
}

export function resolveWorkspaceLinkTarget(fromPath: string, target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }

  const [withoutFragment] = trimmed.split('#', 1);
  if (!withoutFragment) {
    return null;
  }

  if (withoutFragment.startsWith('/')) {
    return normalizeWorkspaceRelativePath(withoutFragment.slice(1));
  }

  if (
    withoutFragment.startsWith('derived/')
    || withoutFragment.startsWith('outputs/')
    || withoutFragment.startsWith('raw/')
    || withoutFragment.startsWith('manifests/')
  ) {
    return normalizeWorkspaceRelativePath(withoutFragment);
  }

  const joined = posix.join(dirname(fromPath), withoutFragment);
  return normalizeWorkspaceRelativePath(joined);
}

export function extractWorkspaceLinks(fromPath: string, markdown: string): WorkspaceLinkTarget[] {
  const links: WorkspaceLinkTarget[] = [];
  const seen = new Set<string>();
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = regex.exec(markdown);
  while (match) {
    const targetPath = resolveWorkspaceLinkTarget(fromPath, match[2] ?? '');
    if (targetPath) {
      const key = `${targetPath}::${match[1] ?? ''}`;
      if (!seen.has(key)) {
        links.push({
          targetPath,
          anchorText: (match[1] ?? '').trim() || null,
        });
        seen.add(key);
      }
    }
    match = regex.exec(markdown);
  }

  return links;
}
