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
import type { WorkspaceArtifactLinkInput, WorkspaceCompilerProfile } from './types.js';
import {
  extractWorkspaceLinks,
  getRawInputArtifactBundle,
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

type ResolvedWorkspaceRawInput = {
  rawInputId: string;
  contentHash: string;
};

export type WorkspaceCompileContext = {
  workspace: NonNullable<ReturnType<Catalog['getWorkspace']>>;
  bindings: ReturnType<Catalog['listWorkspaceSourceBindings']>;
  rawInputs: ReturnType<Catalog['listWorkspaceRawInputs']>;
  latestSnapshots: ReturnType<Catalog['listLatestSnapshots']>;
  sourceIds: string[];
  rawInputIds: string[];
  eligible: boolean;
  ineligibleReason: 'no-inputs' | 'missing-snapshots' | null;
  missingSourceIds: string[];
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
  rawInputProvenance?: Array<{
    rawInputId: string;
    chunkIds: number[];
  }>;
  links?: WorkspaceArtifactLinkInput[];
};

const WORKSPACE_COMPILE_RECIPE_VERSION = 'workspace-compile-v3';

export type WorkspaceCompileResult = {
  workspaceId: string;
  skipped: boolean;
  sourceFingerprint: string;
  changedSourceIds: string[];
  changedRawInputIds: string[];
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

export function resolveWorkspaceCompileContext(input: {
  catalog: Catalog;
  workspaceId: string;
}): WorkspaceCompileContext {
  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  const rawInputs = input.catalog.listWorkspaceRawInputs(input.workspaceId);
  const sourceIds = bindings.map((binding) => binding.sourceId);
  const rawInputIds = rawInputs.map((rawInput) => rawInput.id);

  if (sourceIds.length === 0 && rawInputIds.length === 0) {
    return {
      workspace,
      bindings,
      rawInputs,
      latestSnapshots: [],
      sourceIds,
      rawInputIds,
      eligible: false,
      ineligibleReason: 'no-inputs',
      missingSourceIds: [],
    };
  }

  const latestSnapshots = input.catalog.listLatestSnapshots(sourceIds);
  const resolvedIds = new Set(latestSnapshots.map((snapshot) => snapshot.sourceId));
  const missingSourceIds = sourceIds.filter((sourceId) => !resolvedIds.has(sourceId));

  if (missingSourceIds.length > 0) {
    return {
      workspace,
      bindings,
      rawInputs,
      latestSnapshots,
      sourceIds,
      rawInputIds,
      eligible: false,
      ineligibleReason: 'missing-snapshots',
      missingSourceIds,
    };
  }

  return {
    workspace,
    bindings,
    rawInputs,
    latestSnapshots,
    sourceIds,
    rawInputIds,
    eligible: true,
    ineligibleReason: null,
    missingSourceIds: [],
  };
}

function computeSourceFingerprint(
  workspaceId: string,
  compilerProfile: Record<string, unknown>,
  sources: ResolvedWorkspaceSource[],
  rawInputs: ResolvedWorkspaceRawInput[],
): string {
  return sha256(stableStringify({
    workspaceId,
    recipeVersion: {
      compile: WORKSPACE_COMPILE_RECIPE_VERSION,
      sanitizer: LMSTUDIO_SANITIZER_VERSION,
    },
    compilerProfile,
    sources,
    rawInputs,
  }));
}

function buildEvidenceMarkdown(input: {
  sourceLabel: string;
  revisionLabel: string;
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
      `Source: ${input.sourceLabel}`,
      `Revision: ${input.revisionLabel}`,
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
      `Workspace evidence '${input.sourceLabel}' has no usable chunks for revision '${input.revisionLabel}'`,
    );
  }

  return {
    markdown: sections.join('\n'),
    chunkIds,
  };
}

function buildSummaryPrompt(input: {
  label: string;
  revisionLabel: string;
  evidenceMarkdown: string;
}): string {
  return [
    `Create a Markdown summary artifact for workspace input ${input.label} at revision ${input.revisionLabel}.`,
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
  label: string;
  revisionLabel: string;
  evidenceMarkdown: string;
}): string {
  return [
    `Create a Markdown concept page for workspace input ${input.label} at revision ${input.revisionLabel}.`,
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
  label: string;
  revisionLabel: string;
  summaryTitle: string;
  conceptTitle: string;
  summaryPath: string;
  conceptPath: string;
  evidenceMarkdown: string;
  compilerProfile: WorkspaceCompilerProfile;
  provenance: Array<{
    sourceId: string;
    snapshotId: string;
    chunkIds: number[];
  }>;
  rawInputProvenance?: Array<{
    rawInputId: string;
    chunkIds: number[];
  }>;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<ArtifactRender[]> {
  const summary = await compileWithLmStudio({
    profile: input.compilerProfile,
    systemPrompt: 'You maintain a provenance-backed local research wiki. Return only the final Markdown document. Never emit reasoning, analysis, tool traces, <think> tags, or channel/control tokens.',
    userPrompt: buildSummaryPrompt({
      label: input.label,
      revisionLabel: input.revisionLabel,
      evidenceMarkdown: input.evidenceMarkdown,
    }),
    ...(input.env ? { env: input.env } : {}),
  });
  const concepts = await compileWithLmStudio({
    profile: input.compilerProfile,
    systemPrompt: 'You maintain a provenance-backed local research wiki. Return only the final Markdown document. Never emit reasoning, analysis, tool traces, <think> tags, or channel/control tokens.',
    userPrompt: buildConceptPrompt({
      label: input.label,
      revisionLabel: input.revisionLabel,
      evidenceMarkdown: input.evidenceMarkdown,
    }),
    ...(input.env ? { env: input.env } : {}),
  });

  return [
    {
      path: input.summaryPath,
      kind: 'summary',
      content: wrapArtifactContent(
        ensureLeadingTitle(summary.content, input.summaryTitle),
        input.workspaceId,
        ['derived/index.md', input.conceptPath],
      ),
      provenance: input.provenance,
      ...(input.rawInputProvenance ? { rawInputProvenance: input.rawInputProvenance } : {}),
      compilerMetadata: {
        provider: 'lmstudio',
        model: summary.model,
        promptKind: 'summary',
      },
      links: buildArtifactLinks(
        input.summaryPath,
        wrapArtifactContent(
          ensureLeadingTitle(summary.content, input.summaryTitle),
          input.workspaceId,
          ['derived/index.md', input.conceptPath],
        ),
        [
          { toPath: 'derived/index.md', relationKind: 'related_to', anchorText: 'derived/index.md' },
          { toPath: input.conceptPath, relationKind: 'summary_of', anchorText: input.conceptPath },
        ],
      ),
    },
    {
      path: input.conceptPath,
      kind: 'concept',
      content: wrapArtifactContent(
        ensureLeadingTitle(concepts.content, input.conceptTitle),
        input.workspaceId,
        ['derived/index.md', input.summaryPath],
      ),
      provenance: input.provenance,
      ...(input.rawInputProvenance ? { rawInputProvenance: input.rawInputProvenance } : {}),
      compilerMetadata: {
        provider: 'lmstudio',
        model: concepts.model,
        promptKind: 'concept',
      },
      links: buildArtifactLinks(
        input.conceptPath,
        wrapArtifactContent(
          ensureLeadingTitle(concepts.content, input.conceptTitle),
          input.workspaceId,
          ['derived/index.md', input.summaryPath],
        ),
        [
          { toPath: 'derived/index.md', relationKind: 'related_to', anchorText: 'derived/index.md' },
          { toPath: input.summaryPath, relationKind: 'concept_of', anchorText: input.summaryPath },
        ],
      ),
    },
  ];
}

async function buildIndexArtifact(input: {
  dataDir: string;
  workspaceId: string;
  sourceIds: string[];
  latestSnapshots: Map<string, string>;
  rawInputs: Array<{
    id: string;
    label: string;
    contentHash: string;
  }>;
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

  const rawSections = await Promise.all(input.rawInputs.map(async (rawInput) => {
    const bundle = getRawInputArtifactBundle(rawInput.id);
    const summary = await readWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: bundle.summaryPath,
    });

    return {
      rawInputId: rawInput.id,
      label: rawInput.label,
      contentHash: rawInput.contentHash,
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
    ...(rawSections.length > 0
      ? [
          '## Raw Inputs',
          ...rawSections.flatMap((section) => [
            `### ${section.label}`,
            `- Raw Input ID: ${section.rawInputId}`,
            `- Content Hash: ${section.contentHash}`,
            `- [Summary](${section.summaryPath})`,
            `- [Concepts](${section.conceptPath})`,
            '',
            '#### Preview',
            section.preview || '_No preview available._',
            '',
          ]),
        ]
      : []),
  ].join('\n');

  const links: WorkspaceArtifactLinkInput[] = [];
  for (const section of sections) {
    links.push(
      { fromPath: getWorkspaceIndexPath(), toPath: section.summaryPath, relationKind: 'index_entry', anchorText: section.summaryPath },
      { fromPath: getWorkspaceIndexPath(), toPath: section.conceptPath, relationKind: 'index_entry', anchorText: section.conceptPath },
    );
  }
  for (const section of rawSections) {
    links.push(
      { fromPath: getWorkspaceIndexPath(), toPath: section.summaryPath, relationKind: 'index_entry', anchorText: section.summaryPath },
      { fromPath: getWorkspaceIndexPath(), toPath: section.conceptPath, relationKind: 'index_entry', anchorText: section.conceptPath },
    );
  }

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
    rawInputProvenance: rawSections.map((section) => ({
      rawInputId: section.rawInputId,
      chunkIds: [],
    })),
    compilerMetadata: {
      provider: 'deterministic',
      promptKind: 'index',
    },
    links: buildArtifactLinks(getWorkspaceIndexPath(), content, links),
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

function artifactPathsForRawInput(rawInputId: string): string[] {
  const bundle = getRawInputArtifactBundle(rawInputId);
  return [bundle.conceptPath, bundle.summaryPath];
}

function listArtifactPathsForRawInputChanges(
  workspaceId: string,
  catalog: Catalog,
  rawInputs: ResolvedWorkspaceRawInput[],
): string[] {
  const paths: string[] = [];
  for (const rawInput of rawInputs) {
    const bundle = getRawInputArtifactBundle(rawInput.rawInputId);
    for (const path of [bundle.summaryPath, bundle.conceptPath]) {
      const artifact = catalog.getWorkspaceArtifact(workspaceId, path);
      if (!artifact) {
        paths.push(path);
        continue;
      }

      const provenance = catalog.listWorkspaceArtifactRawInputProvenance(workspaceId, path);
      if (!provenance.some((entry) => entry.rawInputId === rawInput.rawInputId)) {
        paths.push(path);
      }
    }
  }

  return [...new Set(paths)];
}

function changedRawInputsFromArtifactPaths(paths: string[]): string[] {
  return [...new Set(paths.flatMap((path) => {
    const summaryMatch = path.match(/^derived\/raw\/([^/]+)\/summary\.md$/);
    if (summaryMatch?.[1]) {
      return [summaryMatch[1]];
    }

    const conceptMatch = path.match(/^derived\/raw\/([^/]+)\/concept\.md$/);
    return conceptMatch?.[1] ? [conceptMatch[1]] : [];
  }))].sort();
}

function buildArtifactLinks(
  fromPath: string,
  content: string,
  relationLinks: Array<Omit<WorkspaceArtifactLinkInput, 'fromPath'>> = [],
): WorkspaceArtifactLinkInput[] {
  const links: WorkspaceArtifactLinkInput[] = extractWorkspaceLinks(fromPath, content).map((link) => ({
    fromPath,
    toPath: link.targetPath,
    relationKind: 'explicit_link',
    anchorText: link.anchorText,
    source: 'deterministic',
    broken: false,
  }));

  for (const relation of relationLinks) {
    links.push({
      fromPath,
      ...relation,
      source: relation.source ?? 'deterministic',
      broken: relation.broken ?? false,
    });
  }

  const deduped = new Map<string, WorkspaceArtifactLinkInput>();
  for (const link of links) {
    deduped.set(
      `${link.fromPath}::${link.toPath}::${link.relationKind}::${link.source ?? 'deterministic'}`,
      link,
    );
  }

  return [...deduped.values()];
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

  const compileContext = resolveWorkspaceCompileContext({
    catalog: input.catalog,
    workspaceId: input.workspaceId,
  });
  const workspace = compileContext.workspace;
  const bindings = compileContext.bindings;
  const rawInputs = compileContext.rawInputs;
  if (!compileContext.eligible && compileContext.ineligibleReason === 'no-inputs') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has no bound sources or raw inputs`,
    );
  }

  if (!compileContext.eligible && compileContext.ineligibleReason === 'missing-snapshots') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has bound sources without snapshots: ${compileContext.missingSourceIds.join(', ')}`,
    );
  }
  const latestSnapshots = compileContext.latestSnapshots;

  const sortedSnapshots = [...latestSnapshots].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sortedRawInputs = rawInputs
    .map((rawInput) => ({
      rawInputId: rawInput.id,
      contentHash: rawInput.contentHash,
    }))
    .sort((left, right) => left.rawInputId.localeCompare(right.rawInputId));
  const effectiveCompilerProfile = resolveEffectiveWorkspaceCompilerProfile(workspace.compilerProfile, input.env);
  const sourceFingerprint = computeSourceFingerprint(
    input.workspaceId,
    effectiveCompilerProfile,
    sortedSnapshots,
    sortedRawInputs,
  );

  let artifactPathsToRefresh = [
    ...listArtifactPathsForSourceChanges(
      input.workspaceId,
      input.catalog,
      sortedSnapshots,
    ),
    ...listArtifactPathsForRawInputChanges(
      input.workspaceId,
      input.catalog,
      sortedRawInputs,
    ),
  ];
  let changedSourceIds = changedSourcesFromArtifactPaths(artifactPathsToRefresh);
  let changedRawInputIds = changedRawInputsFromArtifactPaths(artifactPathsToRefresh);
  const lastRun = input.catalog.listWorkspaceCompileRuns(input.workspaceId)[0] ?? null;
  const indexPath = getWorkspaceIndexPath();
  if (
    lastRun
    && lastRun.status === 'success'
    && lastRun.sourceFingerprint !== sourceFingerprint
    && changedSourceIds.length === 0
    && changedRawInputIds.length === 0
  ) {
    changedSourceIds = sortedSnapshots.map((snapshot) => snapshot.sourceId);
    changedRawInputIds = sortedRawInputs.map((rawInput) => rawInput.rawInputId);
    artifactPathsToRefresh = [
      ...changedSourceIds.flatMap((sourceId) => artifactPathsForSource(sourceId)),
      ...changedRawInputIds.flatMap((rawInputId) => artifactPathsForRawInput(rawInputId)),
    ];
  }
  const needsIndexRefresh = (
    changedSourceIds.length > 0
    || changedRawInputIds.length > 0
    || !input.catalog.getWorkspaceArtifact(input.workspaceId, indexPath)
  );

  if (
    lastRun
    && lastRun.status === 'success'
    && lastRun.sourceFingerprint === sourceFingerprint
    && changedSourceIds.length === 0
    && changedRawInputIds.length === 0
    && !needsIndexRefresh
  ) {
    return {
      workspaceId: input.workspaceId,
      skipped: true,
      sourceFingerprint,
      changedSourceIds: [],
      changedRawInputIds: [],
      updatedArtifactPaths: [],
      artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
      compileRunId: null,
    };
  }

  const updatedArtifactPaths = new Set<string>();
  const latestSnapshotMap = new Map(sortedSnapshots.map((snapshot) => [snapshot.sourceId, snapshot.snapshotId]));
  const rawInputMap = new Map(rawInputs.map((rawInput) => [rawInput.id, rawInput]));
  const outputArtifactPathsToInvalidate = needsIndexRefresh || changedSourceIds.length > 0 || changedRawInputIds.length > 0
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
        sourceLabel: sourceId,
        revisionLabel: snapshotId,
        chunks,
        maxInputChars: effectiveCompilerProfile.maxInputChars,
      });
      const bundle = getSourceArtifactBundle(sourceId);
      const rendered = await renderSourceArtifacts({
        workspaceId: input.workspaceId,
        label: sourceId,
        revisionLabel: snapshotId,
        summaryTitle: `${sourceId} Summary`,
        conceptTitle: `${sourceId} Concepts`,
        summaryPath: bundle.summaryPath,
        conceptPath: bundle.conceptPath,
        evidenceMarkdown: evidence.markdown,
        compilerProfile: effectiveCompilerProfile,
        provenance: [
          {
            sourceId,
            snapshotId,
            chunkIds: evidence.chunkIds,
          },
        ],
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
          ...(artifact.rawInputProvenance ? { rawInputProvenance: artifact.rawInputProvenance } : {}),
          ...(artifact.links ? { links: artifact.links } : {}),
        });
        updatedArtifactPaths.add(artifact.path);
      }
    }

    for (const rawInputId of changedRawInputIds) {
      input.catalog.setWorkspaceArtifactsStale({
        workspaceId: input.workspaceId,
        artifactPaths: artifactPathsForRawInput(rawInputId),
        stale: true,
      });

      const rawInput = rawInputMap.get(rawInputId);
      if (!rawInput) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.invalidArgument,
          `Workspace '${input.workspaceId}' is missing raw input '${rawInputId}'`,
        );
      }

      const chunks = input.catalog.listWorkspaceRawInputChunks(input.workspaceId, rawInputId).map((chunk) => ({
        chunkId: chunk.id,
        pageTitle: rawInput.label,
        sectionTitle: chunk.section_title,
        markdown: chunk.markdown,
        pageUrl: `workspace://raw/${rawInputId}`,
        filePath: chunk.file_path,
        language: chunk.file_path?.endsWith('.md') || chunk.file_path?.endsWith('.mdx') ? 'markdown' : null,
        pageKind: 'file' as const,
      }));
      const evidence = buildEvidenceMarkdown({
        sourceLabel: rawInput.label,
        revisionLabel: rawInput.contentHash,
        chunks,
        maxInputChars: effectiveCompilerProfile.maxInputChars,
      });
      const bundle = getRawInputArtifactBundle(rawInputId);
      const rendered = await renderSourceArtifacts({
        workspaceId: input.workspaceId,
        label: rawInput.label,
        revisionLabel: rawInput.contentHash,
        summaryTitle: `${rawInput.label} Summary`,
        conceptTitle: `${rawInput.label} Concepts`,
        summaryPath: bundle.summaryPath,
        conceptPath: bundle.conceptPath,
        evidenceMarkdown: evidence.markdown,
        compilerProfile: effectiveCompilerProfile,
        provenance: [],
        rawInputProvenance: [
          {
            rawInputId,
            chunkIds: evidence.chunkIds,
          },
        ],
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
          compilerMetadata: {
            ...artifact.compilerMetadata,
            rawInputId,
          },
          stale: false,
          chunks: [
            {
              sectionTitle: artifact.kind === 'summary'
                ? `${rawInput.label} summary`
                : `${rawInput.label} concepts`,
              markdown: artifact.content,
            },
          ],
          provenance: [],
          ...(artifact.rawInputProvenance ? { rawInputProvenance: artifact.rawInputProvenance } : {}),
          ...(artifact.links ? { links: artifact.links } : {}),
        });
        updatedArtifactPaths.add(artifact.path);
      }
    }

    if (needsIndexRefresh || changedSourceIds.length > 0 || changedRawInputIds.length > 0) {
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
        rawInputs: rawInputs.map((rawInput) => ({
          id: rawInput.id,
          label: rawInput.label,
          contentHash: rawInput.contentHash,
        })),
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
        ...(indexArtifact.rawInputProvenance ? { rawInputProvenance: indexArtifact.rawInputProvenance } : {}),
        ...(indexArtifact.links ? { links: indexArtifact.links } : {}),
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
        changedRawInputIds,
        updatedArtifactPaths: [...updatedArtifactPaths].sort(),
        compiledAt: new Date().toISOString(),
        sources: sortedSnapshots,
        rawInputs: sortedRawInputs,
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
      changedRawInputIds,
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
