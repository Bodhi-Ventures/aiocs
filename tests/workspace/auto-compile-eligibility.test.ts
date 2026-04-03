import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCatalog } from '../../src/catalog/catalog.js';
import {
  bindWorkspaceSources,
  createWorkspace,
  ingestWorkspaceRawInput,
  removeWorkspaceRawInput,
  unbindWorkspaceSources,
  updateWorkspaceSettings,
} from '../../src/services.js';
import { parseSourceSpecObject } from '../../src/spec/source-spec.js';

function buildSpec(id: string) {
  return parseSourceSpecObject({
    id,
    label: `${id} docs`,
    startUrls: ['https://example.com/docs/start'],
    allowedHosts: ['example.com'],
    discovery: {
      include: ['https://example.com/docs/**'],
      exclude: [],
      maxPages: 25,
    },
    extract: {
      strategy: 'selector',
      selector: 'article',
    },
    normalize: {
      prependSourceComment: true,
    },
    schedule: {
      everyHours: 24,
    },
  });
}

describe('workspace auto-compile eligibility', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiocs-workspace-eligibility-'));
    previousDataDir = process.env.AIOCS_DATA_DIR;
    previousConfigDir = process.env.AIOCS_CONFIG_DIR;
    process.env.AIOCS_DATA_DIR = join(root, 'data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (typeof previousDataDir === 'undefined') {
      delete process.env.AIOCS_DATA_DIR;
    } else {
      process.env.AIOCS_DATA_DIR = previousDataDir;
    }

    if (typeof previousConfigDir === 'undefined') {
      delete process.env.AIOCS_CONFIG_DIR;
    } else {
      process.env.AIOCS_CONFIG_DIR = previousConfigDir;
    }

    rmSync(root, { recursive: true, force: true });
  });

  it('does not enqueue auto-compile when binding a source without snapshots', async () => {
    const dataDir = process.env.AIOCS_DATA_DIR as string;
    const catalog = openCatalog({ dataDir });

    try {
      catalog.upsertSource(buildSpec('missing-snapshot'));
    } finally {
      catalog.close();
    }

    await createWorkspace({
      workspaceId: 'needs-first-fetch',
      label: 'Needs First Fetch',
      autoCompileEnabled: true,
    });

    await bindWorkspaceSources({
      workspaceId: 'needs-first-fetch',
      sourceIds: ['missing-snapshot'],
    });

    const reopened = openCatalog({ dataDir });
    try {
      expect(reopened.getWorkspaceCompileJob('needs-first-fetch')).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it('does not enqueue auto-compile when removing the last raw input', async () => {
    const notesDir = join(root, 'notes');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, 'alpha.md'), '# Alpha\n\nMain websocket takeaway.', 'utf8');

    await createWorkspace({
      workspaceId: 'raw-empty',
      label: 'Raw Empty',
      autoCompileEnabled: false,
    });
    await ingestWorkspaceRawInput({
      workspaceId: 'raw-empty',
      kind: 'markdown-dir',
      sourcePath: notesDir,
      label: 'Research notes',
    });
    await updateWorkspaceSettings({
      workspaceId: 'raw-empty',
      autoCompileEnabled: true,
    });

    const beforeRemovalCatalog = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR as string });
    let rawInputId: string;
    try {
      rawInputId = beforeRemovalCatalog.listWorkspaceRawInputs('raw-empty')[0]!.id;
      expect(beforeRemovalCatalog.getWorkspaceCompileJob('raw-empty')).toBeNull();
    } finally {
      beforeRemovalCatalog.close();
    }

    await removeWorkspaceRawInput({
      workspaceId: 'raw-empty',
      rawInputId,
    });

    const reopened = openCatalog({ dataDir: process.env.AIOCS_DATA_DIR as string });
    try {
      expect(reopened.listWorkspaceRawInputs('raw-empty')).toEqual([]);
      expect(reopened.getWorkspaceCompileJob('raw-empty')).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it('does not enqueue auto-compile when unbinding the last remaining source', async () => {
    const dataDir = process.env.AIOCS_DATA_DIR as string;
    const catalog = openCatalog({ dataDir });
    const source = buildSpec('hyperliquid');

    try {
      catalog.upsertSource(source);
      catalog.recordSuccessfulSnapshot({
        sourceId: source.id,
        pages: [
          {
            url: 'https://example.com/docs/hyperliquid/orders',
            title: 'Orders',
            markdown: '# Orders\n\nMaker flow.',
          },
        ],
      });
    } finally {
      catalog.close();
    }

    await createWorkspace({
      workspaceId: 'unbind-last-source',
      label: 'Unbind Last Source',
      autoCompileEnabled: false,
    });

    const seeded = openCatalog({ dataDir });
    try {
      seeded.bindWorkspaceSources('unbind-last-source', [source.id]);
    } finally {
      seeded.close();
    }

    await updateWorkspaceSettings({
      workspaceId: 'unbind-last-source',
      autoCompileEnabled: true,
    });

    await unbindWorkspaceSources({
      workspaceId: 'unbind-last-source',
      sourceIds: [source.id],
    });

    const reopened = openCatalog({ dataDir });
    try {
      expect(reopened.listWorkspaceSourceBindings('unbind-last-source')).toEqual([]);
      expect(reopened.getWorkspaceCompileJob('unbind-last-source')).toBeNull();
    } finally {
      reopened.close();
    }
  });
});
