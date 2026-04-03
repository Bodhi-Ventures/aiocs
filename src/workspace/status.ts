import type { openCatalog } from '../catalog/catalog.js';
import {
  assessWorkspaceArtifactFreshness,
  getExpectedArtifactRawInputIds,
  getExpectedArtifactSourceIds,
  getWorkspaceIndexPath,
} from './artifacts.js';
import type { WorkspaceArtifactRecord, WorkspaceHealthSummary } from './types.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceAnalysisFindingKind =
  | 'stale-artifact'
  | 'missing-provenance'
  | 'missing-artifact'
  | 'broken-artifact-link'
  | 'orphan-artifact'
  | 'suggested-concept';

export type WorkspaceAnalysisFinding = {
  kind: WorkspaceAnalysisFindingKind;
  severity: 'warn';
  summary: string;
  artifactPath?: string;
  sourceId?: string;
  rawInputId?: string;
};

export type WorkspaceStatusAnalysis = {
  staleArtifactPaths: string[];
  findings: WorkspaceAnalysisFinding[];
  graph: {
    linkCount: number;
    brokenLinkCount: number;
    orphanArtifactCount: number;
  };
  lintSummary: {
    status: 'pass' | 'warn';
    findingCount: number;
    staleArtifactCount: number;
    missingProvenanceCount: number;
    missingArtifactCount: number;
    brokenLinkCount: number;
    orphanArtifactCount: number;
    suggestedConceptCount: number;
  };
  health: WorkspaceHealthSummary;
};

export function analyzeWorkspaceStatus(input: {
  catalog: Catalog;
  workspaceId: string;
}): WorkspaceStatusAnalysis {
  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  const boundSourceIds = bindings.map((binding) => binding.sourceId);
  const latestSnapshots = new Map(
    input.catalog.listLatestSnapshots(boundSourceIds).map((entry) => [entry.sourceId, entry.snapshotId]),
  );
  const rawInputs = input.catalog.listWorkspaceRawInputs(input.workspaceId);
  const rawInputIds = rawInputs.map((rawInput) => rawInput.id);
  const artifacts = input.catalog.listWorkspaceArtifacts(input.workspaceId);
  const links = input.catalog.listWorkspaceArtifactLinks({
    workspaceId: input.workspaceId,
  });
  const compileJobs = input.catalog.listWorkspaceCompileJobs(input.workspaceId);
  const findings: WorkspaceAnalysisFinding[] = [];
  const staleArtifactPaths = new Set<string>();

  for (const artifact of artifacts) {
    const freshness = assessWorkspaceArtifactFreshness({
      catalog: input.catalog,
      workspaceId: input.workspaceId,
      artifactPath: artifact.path,
      boundSourceIds,
      latestSnapshots,
    });
    const rawInputProvenance = input.catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, artifact.path);
    const expectedRawInputIds = getExpectedArtifactRawInputIds(artifact.path, rawInputIds);
    const rawMissing = expectedRawInputIds.some((rawInputId) => (
      !rawInputProvenance.some((entry) => entry.rawInputId === rawInputId)
    ));
    const stale = artifact.stale || freshness.stale || rawMissing;

    if (
      freshness.provenance.length === 0
      && rawInputProvenance.length === 0
      && artifact.path !== getWorkspaceIndexPath()
      && !artifact.path.startsWith('outputs/')
    ) {
      findings.push({
        kind: 'missing-provenance',
        severity: 'warn',
        artifactPath: artifact.path,
        summary: `Artifact ${artifact.path} has no source or raw-input provenance.`,
      });
    } else if (freshness.missingProvenance || rawMissing) {
      findings.push({
        kind: 'missing-provenance',
        severity: 'warn',
        artifactPath: artifact.path,
        summary: `Artifact ${artifact.path} has incomplete provenance for its expected inputs.`,
      });
    }

    if (stale) {
      staleArtifactPaths.add(artifact.path);
      findings.push({
        kind: 'stale-artifact',
        severity: 'warn',
        artifactPath: artifact.path,
        summary: `Artifact ${artifact.path} is stale relative to current workspace inputs.`,
      });
    }
  }

  for (const sourceId of boundSourceIds) {
    const expectedPaths = [
      `derived/sources/${sourceId}/summary.md`,
      `derived/concepts/${sourceId}.md`,
    ];
    for (const artifactPath of expectedPaths) {
      if (!input.catalog.getWorkspaceArtifact(input.workspaceId, artifactPath)) {
        findings.push({
          kind: 'missing-artifact',
          severity: 'warn',
          sourceId,
          artifactPath,
          summary: `Workspace is missing expected artifact ${artifactPath} for source ${sourceId}.`,
        });
      }
    }
  }

  for (const rawInputId of rawInputIds) {
    const expectedPaths = [
      `derived/raw/${rawInputId}/summary.md`,
      `derived/raw/${rawInputId}/concept.md`,
    ];
    for (const artifactPath of expectedPaths) {
      if (!input.catalog.getWorkspaceArtifact(input.workspaceId, artifactPath)) {
        findings.push({
          kind: 'missing-artifact',
          severity: 'warn',
          rawInputId,
          artifactPath,
          summary: `Workspace is missing expected artifact ${artifactPath} for raw input ${rawInputId}.`,
        });
      }
    }
  }

  const brokenLinks = links.filter((link) => !input.catalog.getWorkspaceArtifact(input.workspaceId, link.toPath));
  for (const link of brokenLinks) {
    findings.push({
      kind: 'broken-artifact-link',
      severity: 'warn',
      artifactPath: link.fromPath,
      summary: `Artifact ${link.fromPath} links to missing artifact ${link.toPath}.`,
    });
  }

  const incomingCounts = new Map<string, number>();
  for (const link of links) {
    incomingCounts.set(link.toPath, (incomingCounts.get(link.toPath) ?? 0) + 1);
  }
  const orphanArtifacts = artifacts.filter((artifact) => (
    artifact.path !== getWorkspaceIndexPath()
    && !artifact.path.startsWith('outputs/')
    && !artifact.path.startsWith('derived/notes/')
    && (incomingCounts.get(artifact.path) ?? 0) === 0
  ));
  for (const artifact of orphanArtifacts) {
    findings.push({
      kind: 'orphan-artifact',
      severity: 'warn',
      artifactPath: artifact.path,
      summary: `Artifact ${artifact.path} has no incoming workspace links.`,
    });
  }

  const suggestedConcepts = rawInputs.filter((rawInput) => (
    !input.catalog.getWorkspaceArtifact(input.workspaceId, `derived/raw/${rawInput.id}/concept.md`)
  ));
  for (const rawInput of suggestedConcepts) {
    findings.push({
      kind: 'suggested-concept',
      severity: 'warn',
      rawInputId: rawInput.id,
      summary: `Raw input ${rawInput.label} would benefit from a concept artifact.`,
    });
  }

  const pendingCompileJobs = compileJobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const failedCompileJobs = compileJobs.filter((job) => job.status === 'failed').length;
  const lintFindingCount = findings.length;

  return {
    staleArtifactPaths: [...staleArtifactPaths].sort(),
    findings,
    graph: {
      linkCount: links.length,
      brokenLinkCount: brokenLinks.length,
      orphanArtifactCount: orphanArtifacts.length,
    },
    lintSummary: {
      status: findings.length > 0 ? 'warn' : 'pass',
      findingCount: findings.length,
      staleArtifactCount: findings.filter((finding) => finding.kind === 'stale-artifact').length,
      missingProvenanceCount: findings.filter((finding) => finding.kind === 'missing-provenance').length,
      missingArtifactCount: findings.filter((finding) => finding.kind === 'missing-artifact').length,
      brokenLinkCount: findings.filter((finding) => finding.kind === 'broken-artifact-link').length,
      orphanArtifactCount: findings.filter((finding) => finding.kind === 'orphan-artifact').length,
      suggestedConceptCount: findings.filter((finding) => finding.kind === 'suggested-concept').length,
    },
    health: {
      status: findings.length > 0 || pendingCompileJobs > 0 || failedCompileJobs > 0 ? 'degraded' : 'healthy',
      staleArtifactCount: staleArtifactPaths.size,
      pendingCompileJobs,
      failedCompileJobs,
      brokenLinkCount: brokenLinks.length,
      orphanArtifactCount: orphanArtifacts.length,
      rawInputCount: rawInputs.length,
      lintFindingCount,
    },
  };
}
