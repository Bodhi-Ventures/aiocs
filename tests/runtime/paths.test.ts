import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

describe('runtime paths', () => {
  const originalEnv = { ...process.env };
  const created: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const path of created.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('defaults to ~/.aiocs/data and ~/.aiocs/config when no overrides are set', async () => {
    delete process.env.AIOCS_DATA_DIR;
    delete process.env.AIOCS_CONFIG_DIR;
    delete process.env.AIOCS_SOURCES_DIR;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;

    const paths = await import('../../src/runtime/paths.js');

    expect(paths.getAiocsDataDir()).toBe(join(originalEnv.HOME as string, '.aiocs', 'data'));
    expect(paths.getAiocsConfigDir()).toBe(join(originalEnv.HOME as string, '.aiocs', 'config'));
    expect(paths.getAiocsSourcesDir()).toBe(join(originalEnv.HOME as string, '.aiocs', 'sources'));
  });

  it('respects explicit environment overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiocs-paths-'));
    created.push(root);
    process.env.AIOCS_DATA_DIR = join(root, 'custom-data');
    process.env.AIOCS_CONFIG_DIR = join(root, 'custom-config');
    process.env.AIOCS_SOURCES_DIR = join(root, 'custom-sources');

    const paths = await import('../../src/runtime/paths.js');

    expect(paths.getAiocsDataDir()).toBe(join(root, 'custom-data'));
    expect(paths.getAiocsConfigDir()).toBe(join(root, 'custom-config'));
    expect(paths.getAiocsSourcesDir()).toBe(join(root, 'custom-sources'));
  });
});
