import type { openCatalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import {
  assessWorkspaceArtifactFreshness,
  getSourceArtifactBundle,
  getWorkspaceLatestSnapshotMap,
} from './artifacts.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceLintFinding = {
  kind: 'stale-artifact' | 'missing-provenance' | 'missing-artifact';
  severity: 'warn';
  summary: string;
  artifactPath?: string;
  sourceId?: string;
};

export type WorkspaceLintReport = {
  workspaceId: string;
  summary: {
    status: 'pass' | 'warn';
    findingCount: number;
    staleArtifactCount: number;
    missingProvenanceCount: number;
    missingArtifactCount: number;
  };
  findings: WorkspaceLintFinding[];
};

export async function lintWorkspace(input: {
  catalog: Catalog;
  workspaceId: string;
}): Promise<WorkspaceLintReport> {
  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  const boundSourceIds = bindings.map((binding) => binding.sourceId);
  const latestSnapshots = getWorkspaceLatestSnapshotMap(input.catalog, boundSourceIds);
  const artifacts = input.catalog.listWorkspaceArtifacts(input.workspaceId);
  const findings: WorkspaceLintFinding[] = [];
  const staleArtifactPaths: string[] = [];
  const freshArtifactPaths: string[] = [];

  for (const artifact of artifacts) {
    const freshness = assessWorkspaceArtifactFreshness({
      catalog: input.catalog,
      workspaceId: input.workspaceId,
      artifactPath: artifact.path,
      boundSourceIds,
      latestSnapshots,
    });
    if (freshness.provenance.length === 0 || freshness.missingProvenance) {
      findings.push({
        kind: 'missing-provenance',
        severity: 'warn',
        artifactPath: artifact.path,
        summary: `Artifact ${artifact.path} has missing or incomplete provenance.`,
      });
    }

    if (freshness.stale) {
      staleArtifactPaths.push(artifact.path);
      findings.push({
        kind: 'stale-artifact',
        severity: 'warn',
        artifactPath: artifact.path,
        summary: `Artifact ${artifact.path} is stale relative to the latest source snapshots.`,
      });
    } else {
      freshArtifactPaths.push(artifact.path);
    }
  }

  for (const sourceId of boundSourceIds) {
    const bundle = getSourceArtifactBundle(sourceId);
    for (const path of [bundle.summaryPath, bundle.conceptPath]) {
      if (!input.catalog.getWorkspaceArtifact(input.workspaceId, path)) {
        findings.push({
          kind: 'missing-artifact',
          severity: 'warn',
          sourceId,
          artifactPath: path,
          summary: `Workspace is missing expected artifact ${path} for source ${sourceId}.`,
        });
      }
    }
  }

  input.catalog.setWorkspaceArtifactsStale({
    workspaceId: input.workspaceId,
    artifactPaths: staleArtifactPaths,
    stale: true,
  });
  input.catalog.setWorkspaceArtifactsStale({
    workspaceId: input.workspaceId,
    artifactPaths: freshArtifactPaths,
    stale: false,
  });

  return {
    workspaceId: input.workspaceId,
    summary: {
      status: findings.length > 0 ? 'warn' : 'pass',
      findingCount: findings.length,
      staleArtifactCount: findings.filter((finding) => finding.kind === 'stale-artifact').length,
      missingProvenanceCount: findings.filter((finding) => finding.kind === 'missing-provenance').length,
      missingArtifactCount: findings.filter((finding) => finding.kind === 'missing-artifact').length,
    },
    findings,
  };
}
