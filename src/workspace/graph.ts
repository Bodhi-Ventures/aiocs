import { basename } from 'node:path';

import type { openCatalog } from '../catalog/catalog.js';
import { sha256 } from '../catalog/fingerprint.js';
import type { WorkspaceArtifactLinkInput, WorkspaceArtifactLinkRecord, WorkspaceArtifactRecord } from './types.js';
import { extractWorkspaceLinks } from './artifacts.js';
import { readWorkspaceArtifact, writeWorkspaceArtifact } from './storage.js';

type Catalog = ReturnType<typeof openCatalog>;

const GRAPH_NAVIGATION_START = '<!-- aiocs-graph-navigation:start -->';
const GRAPH_NAVIGATION_END = '<!-- aiocs-graph-navigation:end -->';

function sortLinks(left: WorkspaceArtifactLinkRecord, right: WorkspaceArtifactLinkRecord): number {
  return left.relationKind.localeCompare(right.relationKind)
    || left.toPath.localeCompare(right.toPath)
    || left.fromPath.localeCompare(right.fromPath);
}

export function stripManagedGraphNavigationSection(markdown: string): string {
  return markdown
    .replace(
      new RegExp(`${GRAPH_NAVIGATION_START}[\\s\\S]*?${GRAPH_NAVIGATION_END}\\s*`, 'g'),
      '',
    )
    .trimEnd();
}

function renderOutgoingRelations(links: WorkspaceArtifactLinkRecord[]): string[] {
  if (links.length === 0) {
    return ['_None._'];
  }

  return links
    .slice()
    .sort(sortLinks)
    .map((link) => `- ${link.relationKind}: [${link.toPath}](${link.toPath})`);
}

function renderBacklinks(links: WorkspaceArtifactLinkRecord[]): string[] {
  if (links.length === 0) {
    return ['_None._'];
  }

  return links
    .slice()
    .sort(sortLinks)
    .map((link) => `- ${link.relationKind} from [${link.fromPath}](${link.fromPath})`);
}

export function renderGraphNavigationSection(input: {
  outgoingRelations: WorkspaceArtifactLinkRecord[];
  incomingRelations: WorkspaceArtifactLinkRecord[];
}): string {
  return [
    GRAPH_NAVIGATION_START,
    '## Graph Navigation',
    '',
    '### Outgoing Relations',
    ...renderOutgoingRelations(input.outgoingRelations),
    '',
    '### Backlinks',
    ...renderBacklinks(input.incomingRelations),
    GRAPH_NAVIGATION_END,
  ].join('\n');
}

export function injectManagedGraphNavigationSection(input: {
  content: string;
  graphNavigationSection: string;
}): string {
  const stripped = stripManagedGraphNavigationSection(input.content).trimEnd();
  return `${stripped}\n\n${input.graphNavigationSection}\n`;
}

export function buildArtifactLinks(
  fromPath: string,
  content: string,
  relationLinks: Array<Omit<WorkspaceArtifactLinkInput, 'fromPath'>> = [],
): WorkspaceArtifactLinkInput[] {
  const baseContent = stripManagedGraphNavigationSection(content);
  const links: WorkspaceArtifactLinkInput[] = extractWorkspaceLinks(fromPath, baseContent).map((link) => ({
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

function inferArtifactSectionTitle(artifact: WorkspaceArtifactRecord): string {
  switch (artifact.kind) {
    case 'index':
      return 'Workspace Index';
    case 'report':
      return 'report output';
    case 'slides':
      return 'slides output';
    case 'summary':
      return `${basename(artifact.path, '.md')} summary`;
    case 'concept':
      return `${basename(artifact.path, '.md')} concepts`;
    case 'note':
      return basename(artifact.path, '.md');
    case 'image':
      return basename(artifact.path, '.md');
  }
}

export async function syncWorkspaceGraphNavigation(input: {
  catalog: Catalog;
  dataDir: string;
  workspaceId: string;
  artifactPaths?: string[];
}): Promise<{
  updatedArtifactPaths: string[];
}> {
  const artifacts = input.catalog.listWorkspaceArtifacts(input.workspaceId);
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const targetPaths = input.artifactPaths && input.artifactPaths.length > 0
    ? [...new Set(input.artifactPaths)].filter((path) => artifactMap.has(path))
    : artifacts.map((artifact) => artifact.path);
  const updatedArtifactPaths: string[] = [];

  for (const artifactPath of targetPaths) {
    const artifact = artifactMap.get(artifactPath);
    if (!artifact) {
      continue;
    }

    let current;
    try {
      current = await readWorkspaceArtifact({
        dataDir: input.dataDir,
        workspaceId: input.workspaceId,
        path: artifactPath,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const outgoingRelations = input.catalog.listWorkspaceArtifactLinks({
      workspaceId: input.workspaceId,
      artifactPath,
      direction: 'outgoing',
    });
    const incomingRelations = input.catalog.listWorkspaceArtifactLinks({
      workspaceId: input.workspaceId,
      artifactPath,
      direction: 'incoming',
    });
    const nextContent = injectManagedGraphNavigationSection({
      content: current.content,
      graphNavigationSection: renderGraphNavigationSection({
        outgoingRelations,
        incomingRelations,
      }),
    });

    if (nextContent === current.content) {
      continue;
    }

    const provenance = input.catalog.listWorkspaceArtifactProvenance(input.workspaceId, artifactPath);
    const rawInputProvenance = input.catalog.listWorkspaceArtifactRawInputProvenance(input.workspaceId, artifactPath);
    const deterministicRelationLinks = outgoingRelations
      .filter((link) => link.relationKind !== 'explicit_link')
      .map((link) => ({
        toPath: link.toPath,
        relationKind: link.relationKind,
        anchorText: link.anchorText,
        source: link.source,
        broken: link.broken,
      }));

    await writeWorkspaceArtifact({
      dataDir: input.dataDir,
      workspaceId: input.workspaceId,
      path: artifactPath,
      content: nextContent,
    });
    input.catalog.upsertWorkspaceArtifact({
      workspaceId: input.workspaceId,
      path: artifactPath,
      kind: artifact.kind,
      contentHash: sha256(nextContent),
      compilerMetadata: {
        ...artifact.compilerMetadata,
        graphNavigation: {
          outgoingCount: outgoingRelations.length,
          incomingCount: incomingRelations.length,
        },
      },
      stale: artifact.stale,
      chunks: [
        {
          sectionTitle: inferArtifactSectionTitle(artifact),
          markdown: nextContent,
        },
      ],
      provenance,
      ...(rawInputProvenance.length > 0 ? { rawInputProvenance } : {}),
      links: buildArtifactLinks(artifactPath, nextContent, deterministicRelationLinks),
    });
    updatedArtifactPaths.push(artifactPath);
  }

  return {
    updatedArtifactPaths: updatedArtifactPaths.sort(),
  };
}
