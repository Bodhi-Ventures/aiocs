import type { openCatalog } from '../catalog/catalog.js';

export type SourceArtifactBundle = {
  summaryPath: string;
  conceptPath: string;
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

  for (const sourceId of boundSourceIds) {
    const bundle = getSourceArtifactBundle(sourceId);
    if (artifactPath === bundle.summaryPath || artifactPath === bundle.conceptPath) {
      return [sourceId];
    }
  }

  return [...new Set(boundSourceIds)];
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

export function isWorkspaceOutputArtifactPath(path: string): boolean {
  return path.startsWith('outputs/');
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
