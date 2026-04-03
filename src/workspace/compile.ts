import { join } from 'node:path';

import type { openCatalog } from '../catalog/catalog.js';
import { sha256 } from '../catalog/fingerprint.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import {
  ensureWorkspaceDirectories,
  readWorkspaceArtifact,
  writeWorkspaceArtifact,
  writeWorkspaceManifest,
} from './storage.js';
import { compileWithLmStudio, LMSTUDIO_SANITIZER_VERSION } from './lmstudio.js';
import type { WorkspaceCompilerProfile } from './types.js';
import {
  getSourceArtifactBundle,
  getWorkspaceIndexPath,
  listWorkspaceOutputArtifactPaths,
} from './artifacts.js';
import { resolveEffectiveWorkspaceCompilerProfile } from './compiler-profile.js';

type Catalog = ReturnType<typeof openCatalog>;

type ResolvedWorkspaceSource = {
  sourceId: string;
  snapshotId: string;
};

type ArtifactRender = {
  path: string;
  kind: 'summary' | 'concept' | 'index';
  content: string;
  provenance: Array<{
    sourceId: string;
    snapshotId: string;
    chunkIds: number[];
  }>;
  compilerMetadata: Record<string, unknown>;
};

const WORKSPACE_COMPILE_RECIPE_VERSION = 'workspace-compile-v2';

export type WorkspaceCompileResult = {
  workspaceId: string;
  skipped: boolean;
  sourceFingerprint: string;
  changedSourceIds: string[];
  updatedArtifactPaths: string[];
  artifactCount: number;
  compileRunId: string | null;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function computeSourceFingerprint(
  workspaceId: string,
  compilerProfile: Record<string, unknown>,
  sources: ResolvedWorkspaceSource[],
): string {
  return sha256(stableStringify({
    workspaceId,
    recipeVersion: {
      compile: WORKSPACE_COMPILE_RECIPE_VERSION,
      sanitizer: LMSTUDIO_SANITIZER_VERSION,
    },
    compilerProfile,
    sources,
  }));
}

function buildEvidenceMarkdown(input: {
  sourceId: string;
  snapshotId: string;
  chunks: Array<{
    chunkId: number;
    pageTitle: string;
    sectionTitle: string;
    markdown: string;
    pageUrl: string;
    filePath: string | null;
    language: string | null;
    pageKind: 'document' | 'file';
  }>;
  maxInputChars: number;
}): {
  markdown: string;
  chunkIds: number[];
} {
  const budget = Math.max(2_000, input.maxInputChars - 1_000);
  const sections: string[] = [];
  const chunkIds: number[] = [];
  let totalLength = 0;

  for (const chunk of input.chunks) {
    const header = [
      `## Evidence Chunk ${chunk.chunkId}`,
      `Source: ${input.sourceId}`,
      `Snapshot: ${input.snapshotId}`,
      `Title: ${chunk.pageTitle}`,
      `Section: ${chunk.sectionTitle}`,
      `Kind: ${chunk.pageKind}`,
      ...(chunk.filePath ? [`Path: ${chunk.filePath}`] : []),
      ...(chunk.language ? [`Language: ${chunk.language}`] : []),
      `URL: ${chunk.pageUrl}`,
      '',
    ].join('\n');

    const availableForChunk = budget - totalLength - header.length - 2;
    if (availableForChunk <= 0) {
      break;
    }

    const body = chunk.markdown.length > availableForChunk
      ? `${chunk.markdown.slice(0, Math.max(0, availableForChunk - 16)).trimEnd()}\n\n[truncated]`
      : chunk.markdown;
    const block = `${header}${body}\n`;

    sections.push(block);
    chunkIds.push(chunk.chunkId);
    totalLength += block.length;

    if (totalLength >= budget) {
      break;
    }
  }

  if (sections.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace source '${input.sourceId}' has no usable evidence chunks for snapshot '${input.snapshotId}'`,
    );
  }

  return {
    markdown: sections.join('\n'),
    chunkIds,
  };
}

function buildSummaryPrompt(input: {
  sourceId: string;
  snapshotId: string;
  evidenceMarkdown: string;
}): string {
  return [
    `Create a Markdown summary artifact for source ${input.sourceId} at snapshot ${input.snapshotId}.`,
    'Requirements:',
    '- Output valid Markdown only.',
    '- Do not include reasoning, analysis, `<think>` blocks, or channel/control tokens.',
    '- Start with an H1 title.',
    '- Preserve identifiers, package names, runtimes, and URLs exactly as they appear in the evidence.',
    '- Use standard Markdown headings, paragraphs, and bullet lists.',
    '- Include sections for scope, key primitives, important flows, and noteworthy caveats.',
    '- Stay grounded only in the provided evidence.',
    '',
    'Evidence:',
    input.evidenceMarkdown,
  ].join('\n');
}

function buildConceptPrompt(input: {
  sourceId: string;
  snapshotId: string;
  evidenceMarkdown: string;
}): string {
  return [
    `Create a Markdown concept page for source ${input.sourceId} at snapshot ${input.snapshotId}.`,
    'Requirements:',
    '- Output valid Markdown only.',
    '- Do not include reasoning, analysis, `<think>` blocks, or channel/control tokens.',
    '- Start with an H1 title.',
    '- Preserve identifiers, package names, runtimes, and URLs exactly as they appear in the evidence.',
    '- Use standard Markdown headings, paragraphs, and bullet lists.',
    '- Identify the main concepts, terminology, and relationships present in the evidence.',
    '- Use concise sections and bullet lists where they help clarity.',
    '- Stay grounded only in the provided evidence.',
    '',
    'Evidence:',
    input.evidenceMarkdown,
  ].join('\n');
}

function ensureLeadingTitle(content: string, title: string): string {
  const lines = content.trim().split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor]?.trim() ?? '';
    if (line.length === 0 || line.startsWith('<!--')) {
      cursor += 1;
      continue;
    }
    if (/^#\s+/.test(line)) {
      return content.trim();
    }
    break;
  }

  return [`# ${title}`, '', content.trim()].join('\n');
}

function wrapArtifactContent(content: string, workspaceId: string, relatedPaths: string[]): string {
  const trimmed = content.trim();
  const links = relatedPaths.length > 0
    ? [
        '',
        '## Workspace Links',
        ...relatedPaths.map((path) => `- [${path}](${path})`),
      ].join('\n')
    : '';

  return [
    '<!-- aiocs workspace artifact -->',
    `<!-- workspace: ${workspaceId} -->`,
    '',
    trimmed,
    links,
    '',
  ].join('\n');
}

async function renderSourceArtifacts(input: {
  workspaceId: string;
  sourceId: string;
  snapshotId: string;
  evidenceMarkdown: string;
  chunkIds: number[];
  compilerProfile: WorkspaceCompilerProfile;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<ArtifactRender[]> {
  const bundle = getSourceArtifactBundle(input.sourceId);
  const summary = await compileWithLmStudio({
    profile: input.compilerProfile,
    systemPrompt: 'You maintain a provenance-backed local research wiki. Return only the final Markdown document. Never emit reasoning, analysis, tool traces, <think> tags, or channel/control tokens.',
    userPrompt: buildSummaryPrompt({
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      evidenceMarkdown: input.evidenceMarkdown,
    }),
    ...(input.env ? { env: input.env } : {}),
  });
  const concepts = await compileWithLmStudio({
    profile: input.compilerProfile,
    systemPrompt: 'You maintain a provenance-backed local research wiki. Return only the final Markdown document. Never emit reasoning, analysis, tool traces, <think> tags, or channel/control tokens.',
    userPrompt: buildConceptPrompt({
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      evidenceMarkdown: input.evidenceMarkdown,
    }),
    ...(input.env ? { env: input.env } : {}),
  });

  return [
    {
      path: bundle.summaryPath,
      kind: 'summary',
      content: wrapArtifactContent(
        ensureLeadingTitle(summary.content, `${input.sourceId} Summary`),
        input.workspaceId,
        ['derived/index.md', bundle.conceptPath],
      ),
      provenance: [
        {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          chunkIds: input.chunkIds,
        },
      ],
      compilerMetadata: {
        provider: 'lmstudio',
        model: summary.model,
        promptKind: 'summary',
      },
    },
    {
      path: bundle.conceptPath,
      kind: 'concept',
      content: wrapArtifactContent(
        ensureLeadingTitle(concepts.content, `${input.sourceId} Concepts`),
        input.workspaceId,
        ['derived/index.md', bundle.summaryPath],
      ),
      provenance: [
        {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          chunkIds: input.chunkIds,
        },
      ],
      compilerMetadata: {
        provider: 'lmstudio',
        model: concepts.model,
        promptKind: 'concept',
      },
    },
  ];
}

async function buildIndexArtifact(input: {
  dataDir: string;
  workspaceId: string;
  sourceIds: string[];
  latestSnapshots: Map<string, string>;
}): Promise<ArtifactRender> {
  const sections = await Promise.all(input.sourceIds.map(async (sourceId) => {
    const bundle = getSourceArtifactBundle(sourceId);
    const summary = await readWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: bundle.summaryPath,
    });

    return {
      sourceId,
      snapshotId: input.latestSnapshots.get(sourceId) ?? null,
      summaryPath: bundle.summaryPath,
      conceptPath: bundle.conceptPath,
      preview: summary.content.split('\n').slice(0, 6).join('\n').trim(),
    };
  }));

  const content = [
    '# Workspace Index',
    '',
    '## Sources',
    ...sections.flatMap((section) => [
      `### ${section.sourceId}`,
      `- Snapshot: ${section.snapshotId ?? 'missing'}`,
      `- [Summary](${section.summaryPath})`,
      `- [Concepts](${section.conceptPath})`,
      '',
      '#### Preview',
      section.preview || '_No preview available._',
      '',
    ]),
  ].join('\n');

  return {
    path: getWorkspaceIndexPath(),
    kind: 'index',
    content,
    provenance: sections.flatMap((section) => (
      section.snapshotId
        ? [{
            sourceId: section.sourceId,
            snapshotId: section.snapshotId,
            chunkIds: [],
          }]
        : []
    )),
    compilerMetadata: {
      provider: 'deterministic',
      promptKind: 'index',
    },
  };
}

function artifactPathsForSource(sourceId: string): string[] {
  const bundle = getSourceArtifactBundle(sourceId);
  return [bundle.conceptPath, bundle.summaryPath];
}

function listArtifactPathsForSourceChanges(
  workspaceId: string,
  catalog: Catalog,
  latestSnapshots: ResolvedWorkspaceSource[],
): string[] {
  const paths: string[] = [];
  for (const snapshot of latestSnapshots) {
    const bundle = getSourceArtifactBundle(snapshot.sourceId);
    for (const path of [bundle.summaryPath, bundle.conceptPath]) {
      const artifact = catalog.getWorkspaceArtifact(workspaceId, path);
      if (!artifact) {
        paths.push(path);
        continue;
      }

      const provenance = catalog.listWorkspaceArtifactProvenance(workspaceId, path);
      if (!provenance.some((entry) => entry.sourceId === snapshot.sourceId && entry.snapshotId === snapshot.snapshotId)) {
        paths.push(path);
      }
    }
  }

  return [...new Set(paths)];
}

function changedSourcesFromArtifactPaths(paths: string[]): string[] {
  return [...new Set(paths.flatMap((path) => {
    const summaryMatch = path.match(/^derived\/sources\/([^/]+)\/summary\.md$/);
    if (summaryMatch?.[1]) {
      return [summaryMatch[1]];
    }

    const conceptMatch = path.match(/^derived\/concepts\/(.+)\.md$/);
    return conceptMatch?.[1] ? [conceptMatch[1]] : [];
  }))].sort();
}

export async function compileWorkspace(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WorkspaceCompileResult> {
  ensureWorkspaceDirectories({
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
  });

  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  if (bindings.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has no bound sources`,
    );
  }

  const latestSnapshots = input.catalog.listLatestSnapshots(bindings.map((binding) => binding.sourceId));
  if (latestSnapshots.length !== bindings.length) {
    const resolvedIds = new Set(latestSnapshots.map((snapshot) => snapshot.sourceId));
    const missing = bindings
      .map((binding) => binding.sourceId)
      .filter((sourceId) => !resolvedIds.has(sourceId));
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has bound sources without snapshots: ${missing.join(', ')}`,
    );
  }

  const sortedSnapshots = [...latestSnapshots].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const effectiveCompilerProfile = resolveEffectiveWorkspaceCompilerProfile(workspace.compilerProfile, input.env);
  const sourceFingerprint = computeSourceFingerprint(
    input.workspaceId,
    effectiveCompilerProfile,
    sortedSnapshots,
  );

  let artifactPathsToRefresh = listArtifactPathsForSourceChanges(
    input.workspaceId,
    input.catalog,
    sortedSnapshots,
  );
  let changedSourceIds = changedSourcesFromArtifactPaths(artifactPathsToRefresh);
  const lastRun = input.catalog.listWorkspaceCompileRuns(input.workspaceId)[0] ?? null;
  const indexPath = getWorkspaceIndexPath();
  if (
    lastRun
    && lastRun.status === 'success'
    && lastRun.sourceFingerprint !== sourceFingerprint
    && changedSourceIds.length === 0
  ) {
    changedSourceIds = sortedSnapshots.map((snapshot) => snapshot.sourceId);
    artifactPathsToRefresh = changedSourceIds.flatMap((sourceId) => artifactPathsForSource(sourceId));
  }
  const needsIndexRefresh = changedSourceIds.length > 0 || !input.catalog.getWorkspaceArtifact(input.workspaceId, indexPath);

  if (
    lastRun
    && lastRun.status === 'success'
    && lastRun.sourceFingerprint === sourceFingerprint
    && changedSourceIds.length === 0
    && !needsIndexRefresh
  ) {
    return {
      workspaceId: input.workspaceId,
      skipped: true,
      sourceFingerprint,
      changedSourceIds: [],
      updatedArtifactPaths: [],
      artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
      compileRunId: null,
    };
  }

  const updatedArtifactPaths = new Set<string>();
  const latestSnapshotMap = new Map(sortedSnapshots.map((snapshot) => [snapshot.sourceId, snapshot.snapshotId]));
  const outputArtifactPathsToInvalidate = needsIndexRefresh || changedSourceIds.length > 0
    ? listWorkspaceOutputArtifactPaths(input.catalog, input.workspaceId)
    : [];

  try {
    if (outputArtifactPathsToInvalidate.length > 0) {
      input.catalog.setWorkspaceArtifactsStale({
        workspaceId: input.workspaceId,
        artifactPaths: outputArtifactPathsToInvalidate,
        stale: true,
      });
    }

    for (const sourceId of changedSourceIds) {
      const bundle = getSourceArtifactBundle(sourceId);
      input.catalog.setWorkspaceArtifactsStale({
        workspaceId: input.workspaceId,
        artifactPaths: artifactPathsForSource(sourceId),
        stale: true,
      });

      const snapshotId = latestSnapshotMap.get(sourceId);
      if (!snapshotId) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.invalidArgument,
          `Workspace '${input.workspaceId}' is missing a latest snapshot for '${sourceId}'`,
        );
      }

      const chunks = input.catalog.listSnapshotChunks({
        sourceId,
        snapshotId,
      });
      const evidence = buildEvidenceMarkdown({
        sourceId,
        snapshotId,
        chunks,
        maxInputChars: effectiveCompilerProfile.maxInputChars,
      });
      const rendered = await renderSourceArtifacts({
        workspaceId: input.workspaceId,
        sourceId,
        snapshotId,
      evidenceMarkdown: evidence.markdown,
      chunkIds: evidence.chunkIds,
      compilerProfile: effectiveCompilerProfile,
      ...(input.env ? { env: input.env } : {}),
    });

      for (const artifact of rendered) {
        await writeWorkspaceArtifact({
          dataDir: input.dataDir,
          workspaceId: input.workspaceId,
        path: artifact.path,
          content: artifact.content,
        });
        input.catalog.upsertWorkspaceArtifact({
          workspaceId: input.workspaceId,
          path: artifact.path,
          kind: artifact.kind,
          contentHash: sha256(artifact.content),
          compilerMetadata: artifact.compilerMetadata,
          stale: false,
          chunks: [
            {
              sectionTitle: artifact.kind === 'summary'
                ? `${sourceId} summary`
                : `${sourceId} concepts`,
              markdown: artifact.content,
            },
          ],
          provenance: artifact.provenance,
        });
        updatedArtifactPaths.add(artifact.path);
      }
    }

    if (needsIndexRefresh || changedSourceIds.length > 0) {
      input.catalog.setWorkspaceArtifactsStale({
        workspaceId: input.workspaceId,
        artifactPaths: [indexPath],
        stale: true,
      });

      const indexArtifact = await buildIndexArtifact({
        dataDir: input.dataDir,
        workspaceId: input.workspaceId,
        sourceIds: sortedSnapshots.map((snapshot) => snapshot.sourceId),
        latestSnapshots: latestSnapshotMap,
      });
      await writeWorkspaceArtifact({
        dataDir: input.dataDir,
        workspaceId: input.workspaceId,
        path: indexArtifact.path,
        content: indexArtifact.content,
      });
      input.catalog.upsertWorkspaceArtifact({
        workspaceId: input.workspaceId,
        path: indexArtifact.path,
        kind: indexArtifact.kind,
        contentHash: sha256(indexArtifact.content),
        compilerMetadata: indexArtifact.compilerMetadata,
        stale: false,
        chunks: [
          {
            sectionTitle: 'Workspace Index',
            markdown: indexArtifact.content,
          },
        ],
        provenance: indexArtifact.provenance,
      });
      updatedArtifactPaths.add(indexArtifact.path);
    }

    await writeWorkspaceManifest({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      fileName: 'compile-state.json',
      data: {
        workspaceId: input.workspaceId,
        sourceFingerprint,
        changedSourceIds,
        updatedArtifactPaths: [...updatedArtifactPaths].sort(),
        compiledAt: new Date().toISOString(),
        sources: sortedSnapshots,
      },
    });

    const compileRun = input.catalog.recordWorkspaceCompileRun({
      workspaceId: input.workspaceId,
      status: 'success',
      sourceFingerprint,
      artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
    });

    return {
      workspaceId: input.workspaceId,
      skipped: false,
      sourceFingerprint,
      changedSourceIds,
      updatedArtifactPaths: [...updatedArtifactPaths].sort(),
      artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
      compileRunId: compileRun.runId,
    };
  } catch (error) {
    input.catalog.recordWorkspaceCompileRun({
      workspaceId: input.workspaceId,
      status: 'failed',
      sourceFingerprint,
      artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
