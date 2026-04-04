import type { openCatalog } from '../catalog/catalog.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import { sha256 } from '../catalog/fingerprint.js';
import { getWorkspaceSuggestionPath } from './artifacts.js';
import { buildArtifactLinks, syncWorkspaceGraphNavigation } from './graph.js';
import { deleteWorkspaceArtifact, writeWorkspaceArtifact } from './storage.js';
import { analyzeWorkspaceStatus, type WorkspaceAnalysisFindingKind } from './status.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceLintFinding = {
  kind: WorkspaceAnalysisFindingKind;
  severity: 'warn';
  summary: string;
  artifactPath?: string;
  sourceId?: string;
  rawInputId?: string;
  relatedArtifactPaths?: string[];
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
    duplicateConceptCandidateCount: number;
    missingArticleCandidateCount: number;
    followUpQuestionCount: number;
  };
  findings: WorkspaceLintFinding[];
  suggestionsArtifactPath: string | null;
};

function buildSuggestionsArtifact(input: {
  workspaceId: string;
  findings: WorkspaceLintFinding[];
}): {
  content: string;
  links: Array<{
    toPath: string;
    relationKind: 'mentions';
    anchorText: string;
  }>;
} | null {
  const duplicateConcepts = input.findings.filter((finding) => finding.kind === 'duplicate-concept-candidate');
  const missingArticles = input.findings.filter((finding) => finding.kind === 'missing-article-candidate');
  const followUpQuestions = input.findings.filter((finding) => finding.kind === 'follow-up-question-suggestion');

  if (duplicateConcepts.length === 0 && missingArticles.length === 0 && followUpQuestions.length === 0) {
    return null;
  }

  const linkedPaths = new Set<string>();
  const links: Array<{
    toPath: string;
    relationKind: 'mentions';
    anchorText: string;
  }> = [];
  const includeLink = (path: string | undefined) => {
    if (!path || linkedPaths.has(path)) {
      return;
    }
    linkedPaths.add(path);
    links.push({
      toPath: path,
      relationKind: 'mentions',
      anchorText: path,
    });
  };

  const renderFinding = (finding: WorkspaceLintFinding): string => {
    includeLink(finding.artifactPath);
    for (const relatedPath of finding.relatedArtifactPaths ?? []) {
      includeLink(relatedPath);
    }
    return `- ${finding.summary}`;
  };

  return {
    content: [
      '# Workspace Suggestions',
      '',
      `Workspace: ${input.workspaceId}`,
      '',
      ...(duplicateConcepts.length > 0
        ? [
            '## Duplicate Concept Candidates',
            ...duplicateConcepts.map(renderFinding),
            '',
          ]
        : []),
      ...(missingArticles.length > 0
        ? [
            '## Missing Article Candidates',
            ...missingArticles.map(renderFinding),
            '',
          ]
        : []),
      ...(followUpQuestions.length > 0
        ? [
            '## Follow-up Questions',
            ...followUpQuestions.map(renderFinding),
            '',
          ]
        : []),
    ].join('\n').trimEnd() + '\n',
    links,
  };
}

export async function lintWorkspace(input: {
  catalog: Catalog;
  dataDir: string;
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

  const suggestionsArtifactPath = getWorkspaceSuggestionPath();
  const suggestionsArtifact = buildSuggestionsArtifact({
    workspaceId: input.workspaceId,
    findings: analysis.findings,
  });
  if (suggestionsArtifact) {
    await writeWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: suggestionsArtifactPath,
      content: suggestionsArtifact.content,
    });
    input.catalog.upsertWorkspaceArtifact({
      workspaceId: input.workspaceId,
      path: suggestionsArtifactPath,
      kind: 'note',
      contentHash: sha256(suggestionsArtifact.content),
      compilerMetadata: {
        provider: 'deterministic',
        promptKind: 'workspace-lint-suggestions',
      },
      stale: false,
      chunks: [
        {
          sectionTitle: 'Workspace Suggestions',
          markdown: suggestionsArtifact.content,
        },
      ],
      provenance: [],
      links: buildArtifactLinks(suggestionsArtifactPath, suggestionsArtifact.content, suggestionsArtifact.links),
    });
  } else if (input.catalog.getWorkspaceArtifact(input.workspaceId, suggestionsArtifactPath)) {
    input.catalog.deleteWorkspaceArtifacts({
      workspaceId: input.workspaceId,
      artifactPaths: [suggestionsArtifactPath],
    });
    await deleteWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: suggestionsArtifactPath,
    });
  }

  await syncWorkspaceGraphNavigation({
    catalog: input.catalog,
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
  });

  return {
    workspaceId: input.workspaceId,
    summary: analysis.lintSummary,
    findings: analysis.findings,
    suggestionsArtifactPath: suggestionsArtifact ? suggestionsArtifactPath : null,
  };
}
