import type { openCatalog } from '../catalog/catalog.js';
import { sha256 } from '../catalog/fingerprint.js';
import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import {
  assessWorkspaceArtifactFreshness,
  getSourceArtifactBundle,
  getWorkspaceIndexPath,
  getWorkspaceLatestSnapshotMap,
  getWorkspaceOutputPath,
} from './artifacts.js';
import { resolveEffectiveWorkspaceCompilerProfile } from './compiler-profile.js';
import { compileWithLmStudio } from './lmstudio.js';
import { readWorkspaceArtifact, writeWorkspaceArtifact } from './storage.js';

type Catalog = ReturnType<typeof openCatalog>;

type OutputFormat = 'report' | 'slides' | 'summary';

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

function buildOutputPrompt(format: OutputFormat, prompt: string | undefined, context: string): string {
  const instruction = format === 'slides'
    ? 'Create a Marp slide deck from this workspace context.'
    : format === 'report'
      ? 'Create a research report from this workspace context.'
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
  format: OutputFormat;
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

  const bindings = input.catalog.listWorkspaceSourceBindings(input.workspaceId);
  if (bindings.length === 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.invalidArgument,
      `Workspace '${input.workspaceId}' has no bound sources`,
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
  const provenanceEntries: Array<{
    sourceId: string;
    snapshotId: string;
    chunkIds: number[];
  }> = [];

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

  const effectiveCompilerProfile = resolveEffectiveWorkspaceCompilerProfile(workspace.compilerProfile, input.env);
  const prompt = buildOutputPrompt(input.format, input.prompt, contextSections.join('\n\n'));
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
  const path = getWorkspaceOutputPath(input.format, input.name);
  await writeWorkspaceArtifact({
    dataDir: input.dataDir,
    workspaceId: input.workspaceId,
    path,
    content,
  });

  input.catalog.upsertWorkspaceArtifact({
    workspaceId: input.workspaceId,
    path,
    kind: input.format,
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
    provenance: mergeProvenance(provenanceEntries),
  });

  return {
    workspaceId: input.workspaceId,
    format: input.format,
    path,
    artifactCount: input.catalog.listWorkspaceArtifacts(input.workspaceId).length,
  };
}
