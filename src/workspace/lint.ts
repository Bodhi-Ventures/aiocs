import type { openCatalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { analyzeWorkspaceStatus, type WorkspaceAnalysisFindingKind } from './status.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceLintFinding = {
  kind: WorkspaceAnalysisFindingKind;
  severity: 'warn';
  summary: string;
  artifactPath?: string;
  sourceId?: string;
  rawInputId?: string;
};

export type WorkspaceLintReport = {
  workspaceId: string;
  summary: {
    status: 'pass' | 'warn';
    findingCount: number;
    staleArtifactCount: number;
    missingProvenanceCount: number;
    missingArtifactCount: number;
    brokenLinkCount: number;
    orphanArtifactCount: number;
    suggestedConceptCount: number;
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
  const analysis = analyzeWorkspaceStatus({
    catalog: input.catalog,
    workspaceId: input.workspaceId,
  });
  const artifacts = input.catalog.listWorkspaceArtifacts(input.workspaceId);
  const freshArtifactPaths = artifacts
    .map((artifact) => artifact.path)
    .filter((path) => !analysis.staleArtifactPaths.includes(path));

  input.catalog.setWorkspaceArtifactsStale({
    workspaceId: input.workspaceId,
    artifactPaths: analysis.staleArtifactPaths,
    stale: true,
  });
  input.catalog.setWorkspaceArtifactsStale({
    workspaceId: input.workspaceId,
    artifactPaths: freshArtifactPaths,
    stale: false,
  });

  return {
    workspaceId: input.workspaceId,
    summary: analysis.lintSummary,
    findings: analysis.findings,
  };
}
