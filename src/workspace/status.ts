import type { openCatalog } from '../catalog/catalog.js';
import {
  assessWorkspaceArtifactFreshness,
  getExpectedArtifactRawInputIds,
  getExpectedArtifactSourceIds,
  getWorkspaceIndexPath,
  getWorkspaceSuggestionPath,
} from './artifacts.js';
import type {
  WorkspaceArtifactLinkRelationKind,
  WorkspaceArtifactRecord,
  WorkspaceHealthSummary,
} from './types.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceAnalysisFindingKind =
  | 'stale-artifact'
  | 'missing-provenance'
  | 'missing-artifact'
  | 'broken-artifact-link'
  | 'orphan-artifact'
  | 'suggested-concept'
  | 'duplicate-concept-candidate'
  | 'missing-article-candidate'
  | 'follow-up-question-suggestion';

export type WorkspaceAnalysisFinding = {
  kind: WorkspaceAnalysisFindingKind;
  severity: 'warn';
  summary: string;
  artifactPath?: string;
  sourceId?: string;
  rawInputId?: string;
  relatedArtifactPaths?: string[];
};

export type WorkspaceStatusAnalysis = {
  staleArtifactPaths: string[];
  findings: WorkspaceAnalysisFinding[];
  graph: {
    linkCount: number;
    brokenLinkCount: number;
    orphanArtifactCount: number;
    backlinkCount: number;
    relationCounts: Record<WorkspaceArtifactLinkRelationKind, number>;
    mostLinkedArtifacts: Array<{
      artifactPath: string;
      incomingCount: number;
      outgoingCount: number;
    }>;
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
    duplicateConceptCandidateCount: number;
    missingArticleCandidateCount: number;
    followUpQuestionCount: number;
  };
  health: WorkspaceHealthSummary;
};

const relationKinds: WorkspaceArtifactLinkRelationKind[] = [
  'explicit_link',
  'derived_from',
  'mentions',
  'related_to',
  'expands',
  'index_entry',
  'summary_of',
  'concept_of',
  'output_depends_on',
];

const healthDegradingFindingKinds = new Set<WorkspaceAnalysisFindingKind>([
  'stale-artifact',
  'missing-provenance',
  'missing-artifact',
  'broken-artifact-link',
  'orphan-artifact',
]);

function normalizeConceptLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\bconcepts?\b/g, '')
    .replace(/\bdocs?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function deriveConceptLabel(input: {
  catalog: Catalog;
  rawInputs: ReturnType<Catalog['listWorkspaceRawInputs']>;
  artifactPath: string;
}): string {
  const sourceMatch = input.artifactPath.match(/^derived\/concepts\/(.+)\.md$/);
  if (sourceMatch?.[1]) {
    return input.catalog.getSourceSpec(sourceMatch[1])?.label ?? sourceMatch[1];
  }

  const rawMatch = input.artifactPath.match(/^derived\/raw\/([^/]+)\/concept\.md$/);
  if (rawMatch?.[1]) {
    return input.rawInputs.find((rawInput) => rawInput.id === rawMatch[1])?.label ?? rawMatch[1];
  }

  return input.artifactPath;
}

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
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
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

  const relationCounts = Object.fromEntries(
    relationKinds.map((relationKind) => [relationKind, 0]),
  ) as Record<WorkspaceArtifactLinkRelationKind, number>;
  for (const link of links) {
    relationCounts[link.relationKind] += 1;
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
  const outgoingCounts = new Map<string, number>();
  for (const link of links) {
    incomingCounts.set(link.toPath, (incomingCounts.get(link.toPath) ?? 0) + 1);
    outgoingCounts.set(link.fromPath, (outgoingCounts.get(link.fromPath) ?? 0) + 1);
  }
  const orphanArtifacts = artifacts.filter((artifact) => (
    artifact.path !== getWorkspaceIndexPath()
    && artifact.path !== getWorkspaceSuggestionPath()
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

  const conceptArtifacts = artifacts.filter((artifact) => artifact.kind === 'concept');
  const conceptGroups = new Map<string, WorkspaceArtifactRecord[]>();
  for (const artifact of conceptArtifacts) {
    const canonicalLabel = normalizeConceptLabel(deriveConceptLabel({
      catalog: input.catalog,
      rawInputs,
      artifactPath: artifact.path,
    }));
    const existing = conceptGroups.get(canonicalLabel) ?? [];
    existing.push(artifact);
    conceptGroups.set(canonicalLabel, existing);
  }

  for (const [canonicalLabel, groupedArtifacts] of conceptGroups.entries()) {
    if (canonicalLabel.length === 0 || groupedArtifacts.length < 2) {
      continue;
    }

    const artifactPaths = groupedArtifacts.map((artifact) => artifact.path).sort();
    const primaryArtifactPath = artifactPaths[0];
    if (!primaryArtifactPath) {
      continue;
    }
    findings.push({
      kind: 'duplicate-concept-candidate',
      severity: 'warn',
      artifactPath: primaryArtifactPath,
      relatedArtifactPaths: artifactPaths.slice(1),
      summary: `Concept artifacts share the same canonical topic "${canonicalLabel}": ${artifactPaths.join(', ')}.`,
    });
    findings.push({
      kind: 'follow-up-question-suggestion',
      severity: 'warn',
      artifactPath: primaryArtifactPath,
      relatedArtifactPaths: artifactPaths.slice(1),
      summary: `Should these concept artifacts be merged or explicitly differentiated for "${canonicalLabel}"?`,
    });
  }

  const conceptArtifactsMissingArticles = conceptArtifacts.filter((artifact) => {
    const incoming = links.filter((link) => link.toPath === artifact.path);
    return !incoming.some((link) => {
      const fromArtifact = artifactByPath.get(link.fromPath);
      return Boolean(fromArtifact && (fromArtifact.kind === 'report' || fromArtifact.kind === 'slides' || fromArtifact.kind === 'note'));
    });
  });

  for (const artifact of conceptArtifactsMissingArticles) {
    findings.push({
      kind: 'missing-article-candidate',
      severity: 'warn',
      artifactPath: artifact.path,
      summary: `Concept artifact ${artifact.path} has no supporting note, report, or slide deck yet.`,
    });
    findings.push({
      kind: 'follow-up-question-suggestion',
      severity: 'warn',
      artifactPath: artifact.path,
      summary: `What important workflows, caveats, or open questions remain unresolved for ${artifact.path}?`,
    });
  }

  const pendingCompileJobs = compileJobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const failedCompileJobs = compileJobs.filter((job) => job.status === 'failed').length;
  const lintFindingCount = findings.length;
  const healthFindingCount = findings.filter((finding) => healthDegradingFindingKinds.has(finding.kind)).length;
  const mostLinkedArtifacts = artifacts
    .map((artifact) => ({
      artifactPath: artifact.path,
      incomingCount: incomingCounts.get(artifact.path) ?? 0,
      outgoingCount: outgoingCounts.get(artifact.path) ?? 0,
    }))
    .sort((left, right) => right.incomingCount - left.incomingCount || right.outgoingCount - left.outgoingCount || left.artifactPath.localeCompare(right.artifactPath))
    .slice(0, 5);

  return {
    staleArtifactPaths: [...staleArtifactPaths].sort(),
    findings,
    graph: {
      linkCount: links.length,
      brokenLinkCount: brokenLinks.length,
      orphanArtifactCount: orphanArtifacts.length,
      backlinkCount: links.length - brokenLinks.length,
      relationCounts,
      mostLinkedArtifacts,
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
      duplicateConceptCandidateCount: findings.filter((finding) => finding.kind === 'duplicate-concept-candidate').length,
      missingArticleCandidateCount: findings.filter((finding) => finding.kind === 'missing-article-candidate').length,
      followUpQuestionCount: findings.filter((finding) => finding.kind === 'follow-up-question-suggestion').length,
    },
    health: {
      status: healthFindingCount > 0 || pendingCompileJobs > 0 || failedCompileJobs > 0 ? 'degraded' : 'healthy',
      staleArtifactCount: staleArtifactPaths.size,
      pendingCompileJobs,
      failedCompileJobs,
      brokenLinkCount: brokenLinks.length,
      orphanArtifactCount: orphanArtifacts.length,
      rawInputCount: rawInputs.length,
      lintFindingCount,
      duplicateConceptCandidateCount: findings.filter((finding) => finding.kind === 'duplicate-concept-candidate').length,
      missingArticleCandidateCount: findings.filter((finding) => finding.kind === 'missing-article-candidate').length,
      followUpQuestionCount: findings.filter((finding) => finding.kind === 'follow-up-question-suggestion').length,
    },
  };
}
