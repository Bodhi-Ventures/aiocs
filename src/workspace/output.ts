import type { openCatalog } from '../catalog/catalog.js';
import { sha256 } from '../catalog/fingerprint.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import {
  assessWorkspaceArtifactFreshness,
  getExpectedArtifactRawInputIds,
  getRawInputArtifactBundle,
  getWorkspaceAnswerPath,
  getSourceArtifactBundle,
  getWorkspaceIndexPath,
  getWorkspaceLatestSnapshotMap,
  getWorkspaceOutputPath,
} from './artifacts.js';
import { resolveEffectiveWorkspaceCompilerProfile } from './compiler-profile.js';
import { compileWithLmStudio } from './lmstudio.js';
import { readWorkspaceArtifact, writeWorkspaceArtifact } from './storage.js';

type Catalog = ReturnType<typeof openCatalog>;

type OutputFormat = 'report' | 'slides' | 'summary' | 'note';
type WorkspaceGenerationContext = {
  contextSections: string[];
  provenanceEntries: Array<{
    sourceId: string;
    snapshotId: string;
    chunkIds: number[];
  }>;
  rawInputProvenanceEntries: Array<{
    rawInputId: string;
    chunkIds: number[];
  }>;
};

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

function normalizeSlides(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('---') && trimmed.includes('marp: true')) {
    return `${trimmed}\n`;
  }

  return [
    '---',
    'marp: true',
    'theme: default',
    'paginate: true',
    '---',
    '',
    trimmed,
    '',
  ].join('\n');
}

function mergeProvenance(
  entries: Array<{
    sourceId: string;
    snapshotId: string;
    chunkIds: number[];
  }>,
): Array<{
  sourceId: string;
  snapshotId: string;
  chunkIds: number[];
}> {
  const grouped = new Map<string, { sourceId: string; snapshotId: string; chunkIds: Set<number> }>();
  for (const entry of entries) {
    const key = `${entry.sourceId}::${entry.snapshotId}`;
    const existing = grouped.get(key) ?? {
      sourceId: entry.sourceId,
      snapshotId: entry.snapshotId,
      chunkIds: new Set<number>(),
    };
    for (const chunkId of entry.chunkIds) {
      existing.chunkIds.add(chunkId);
    }
    grouped.set(key, existing);
  }

  return [...grouped.values()].map((entry) => ({
    sourceId: entry.sourceId,
    snapshotId: entry.snapshotId,
    chunkIds: [...entry.chunkIds].sort((left, right) => left - right),
  }));
}

function mergeRawInputProvenance(
  entries: Array<{
    rawInputId: string;
    chunkIds: number[];
  }>,
): Array<{
  rawInputId: string;
  chunkIds: number[];
}> {
  const grouped = new Map<string, Set<number>>();
  for (const entry of entries) {
    const chunkIds = grouped.get(entry.rawInputId) ?? new Set<number>();
    for (const chunkId of entry.chunkIds) {
      chunkIds.add(chunkId);
    }
    grouped.set(entry.rawInputId, chunkIds);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rawInputId, chunkIds]) => ({
      rawInputId,
      chunkIds: [...chunkIds].sort((left, right) => left - right),
    }));
}

function buildOutputPrompt(format: OutputFormat, prompt: string | undefined, context: string): string {
  const instruction = format === 'slides'
    ? 'Create a Marp slide deck from this workspace context.'
    : format === 'report'
      ? 'Create a research report from this workspace context.'
      : format === 'note'
        ? 'Create a tightly scoped Markdown note that answers the user question from this workspace context.'
        : 'Create a compact Markdown summary from this workspace context.';
  const requirements = format === 'slides'
    ? [
        '- Output valid Markdown only.',
        '- Start with Marp frontmatter beginning with --- and include `marp: true`.',
        '- Do not include reasoning, analysis, `<think>` blocks, or channel/control tokens.',
        '- Preserve identifiers, package names, runtimes, and URLs exactly as they appear in the workspace context.',
        '- Use standard Markdown headings, paragraphs, and bullet lists inside slides.',
      ]
    : [
        '- Output valid Markdown only.',
        '- Start with an H1 title.',
        '- Do not include reasoning, analysis, `<think>` blocks, or channel/control tokens.',
        '- Preserve identifiers, package names, runtimes, and URLs exactly as they appear in the workspace context.',
        '- Use standard Markdown headings, paragraphs, and bullet lists.',
      ];

  return [
    instruction,
    'Requirements:',
    ...requirements,
    ...(prompt ? ['', `User request: ${prompt}`] : []),
    '',
    'Workspace context:',
    context,
  ].join('\n');
}

export async function generateWorkspaceOutput(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  format: 'report' | 'slides' | 'summary';
  name?: string;
  prompt?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  workspaceId: string;
  format: OutputFormat;
  path: string;
  artifactCount: number;
}> {
  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const generation = await collectWorkspaceGenerationContext(input);
  return generateWorkspaceArtifact({
    catalog: input.catalog,
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
    format: input.format,
    context: generation,
    path: getWorkspaceOutputPath(input.format, input.name),
    artifactKind: input.format,
    ...(input.name ? { name: input.name } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
}

async function collectWorkspaceGenerationContext(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
}): Promise<WorkspaceGenerationContext> {
  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  const rawInputs = input.catalog.listWorkspaceRawInputs(input.workspaceId);
  if (bindings.length === 0 && rawInputs.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has no bound sources or raw inputs`,
    );
  }
  const boundSourceIds = bindings.map((binding) => binding.sourceId);
  const latestSnapshots = getWorkspaceLatestSnapshotMap(input.catalog, boundSourceIds);
  if (latestSnapshots.size !== boundSourceIds.length) {
    const resolvedIds = new Set(latestSnapshots.keys());
    const missing = boundSourceIds.filter((sourceId) => !resolvedIds.has(sourceId));
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has bound sources without snapshots: ${missing.join(', ')}`,
    );
  }
  const staleArtifactPaths: string[] = [];
  const freshArtifactPaths: string[] = [];

  const contextSections: string[] = [];
  const provenanceEntries: WorkspaceGenerationContext['provenanceEntries'] = [];
  const rawInputProvenanceEntries: WorkspaceGenerationContext['rawInputProvenanceEntries'] = [];

  const indexArtifact = input.catalog.getWorkspaceArtifact(input.workspaceId, getWorkspaceIndexPath());
  if (indexArtifact) {
    const freshness = assessWorkspaceArtifactFreshness({
      catalog: input.catalog,
      workspaceId: input.workspaceId,
      artifactPath: getWorkspaceIndexPath(),
      boundSourceIds,
      latestSnapshots,
    });
    if (freshness.stale) {
      staleArtifactPaths.push(getWorkspaceIndexPath());
    } else {
      freshArtifactPaths.push(getWorkspaceIndexPath());
    }
    const indexContent = await readWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: getWorkspaceIndexPath(),
    });
    contextSections.push(indexContent.content);
    provenanceEntries.push(...input.catalog.listWorkspaceArtifactProvenance(input.workspaceId, getWorkspaceIndexPath()));
    rawInputProvenanceEntries.push(...input.catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, getWorkspaceIndexPath()));
  }

  for (const binding of bindings) {
    const bundle = getSourceArtifactBundle(binding.sourceId);
    for (const path of [bundle.summaryPath, bundle.conceptPath]) {
      const artifact = input.catalog.getWorkspaceArtifact(input.workspaceId, path);
      if (!artifact) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.workspaceArtifactNotFound,
          `Workspace '${input.workspaceId}' is missing artifact '${path}' required for output generation`,
        );
      }
      const freshness = assessWorkspaceArtifactFreshness({
        catalog: input.catalog,
        workspaceId: input.workspaceId,
        artifactPath: path,
        boundSourceIds,
        latestSnapshots,
      });
      if (freshness.stale) {
        staleArtifactPaths.push(path);
      } else {
        freshArtifactPaths.push(path);
      }

      const content = await readWorkspaceArtifact({
        dataDir: input.dataDir,
        workspaceId: input.workspaceId,
        path,
      });
      contextSections.push(content.content);
      provenanceEntries.push(...input.catalog.listWorkspaceArtifactProvenance(input.workspaceId, path));
      rawInputProvenanceEntries.push(...input.catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, path));
    }
  }

  for (const rawInput of rawInputs) {
    const bundle = getRawInputArtifactBundle(rawInput.id);
    for (const path of [bundle.summaryPath, bundle.conceptPath]) {
      const artifact = input.catalog.getWorkspaceArtifact(input.workspaceId, path);
      if (!artifact) {
        throw new AiocsError(
          AIOCS_ERROR_CODES.workspaceArtifactNotFound,
          `Workspace '${input.workspaceId}' is missing artifact '${path}' required for output generation`,
        );
      }

      const rawInputProvenance = input.catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, path);
      const expectedRawInputIds = getExpectedArtifactRawInputIds(path, rawInputs.map((entry) => entry.id));
      const rawMissing = expectedRawInputIds.some((rawInputId) => (
        !rawInputProvenance.some((entry) => entry.rawInputId === rawInputId)
      ));
      if (artifact.stale || rawMissing) {
        staleArtifactPaths.push(path);
      } else {
        freshArtifactPaths.push(path);
      }

      const content = await readWorkspaceArtifact({
        dataDir: input.dataDir,
        workspaceId: input.workspaceId,
        path,
      });
      contextSections.push(content.content);
      provenanceEntries.push(...input.catalog.listWorkspaceArtifactProvenance(input.workspaceId, path));
      rawInputProvenanceEntries.push(...rawInputProvenance);
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
  if (staleArtifactPaths.length > 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceArtifactsStale,
      `Workspace '${input.workspaceId}' has stale artifacts. Re-run 'workspace compile' before generating outputs.`,
      {
        staleArtifactPaths: [...new Set(staleArtifactPaths)].sort(),
      },
    );
  }

  return {
    contextSections,
    provenanceEntries,
    rawInputProvenanceEntries,
  };
}

async function generateWorkspaceArtifact(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  format: OutputFormat;
  path: string;
  artifactKind: 'report' | 'slides' | 'summary' | 'note';
  context: WorkspaceGenerationContext;
  name?: string;
  prompt?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  workspaceId: string;
  format: OutputFormat;
  path: string;
  artifactCount: number;
}> {
  const workspace = input.catalog.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceNotFound,
      `Unknown workspace '${input.workspaceId}'`,
    );
  }

  const effectiveCompilerProfile = resolveEffectiveWorkspaceCompilerProfile(workspace.compilerProfile, input.env);
  const prompt = buildOutputPrompt(input.format, input.prompt, input.context.contextSections.join('\n\n'));
  const generated = await compileWithLmStudio({
    profile: effectiveCompilerProfile,
    systemPrompt: 'You create provenance-backed workspace outputs. Return only the final Markdown document. Never emit reasoning, analysis, tool traces, <think> tags, or channel/control tokens.',
    userPrompt: prompt,
    ...(input.env ? { env: input.env } : {}),
  });

  const titled = input.format === 'slides'
    ? generated.content
    : ensureLeadingTitle(
        generated.content,
        input.name ?? `${workspace.label} ${input.format}`,
      );
  const content = input.format === 'slides'
    ? normalizeSlides(titled)
    : `${titled.trim()}\n`;
  await writeWorkspaceArtifact({
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
    path: input.path,
    content,
  });

  input.catalog.upsertWorkspaceArtifact({
    workspaceId: input.workspaceId,
    path: input.path,
    kind: input.artifactKind,
    contentHash: sha256(content),
    compilerMetadata: {
      provider: 'lmstudio',
      model: generated.model,
      promptKind: input.format,
    },
    stale: false,
    chunks: [
      {
        sectionTitle: `${input.format} output`,
        markdown: content,
      },
    ],
    provenance: mergeProvenance(input.context.provenanceEntries),
    ...(input.context.rawInputProvenanceEntries.length > 0
      ? { rawInputProvenance: mergeRawInputProvenance(input.context.rawInputProvenanceEntries) }
      : {}),
  });

  return {
    workspaceId: input.workspaceId,
    format: input.format,
    path: input.path,
    artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
  };
}

export async function answerWorkspaceQuestion(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  question: string;
  format: OutputFormat;
  name?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  workspaceId: string;
  format: OutputFormat;
  path: string;
  artifactCount: number;
}> {
  const generation = await collectWorkspaceGenerationContext(input);
  return generateWorkspaceArtifact({
    catalog: input.catalog,
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
    format: input.format,
    prompt: input.question,
    context: generation,
    path: getWorkspaceAnswerPath(input.format, input.name),
    artifactKind: input.format === 'note' ? 'note' : input.format,
    ...(input.name ? { name: input.name } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
}
