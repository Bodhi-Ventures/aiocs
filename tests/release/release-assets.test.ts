import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };

const repoRoot = '/Users/jmucha/repos/mandex/aiocs';
const packageManifest = packageJson as Record<string, unknown> & {
  bin: Record<string, string>;
};

describe('release assets', () => {
  it('ships publishable package metadata', () => {
    expect(packageManifest.private).not.toBe(true);
    expect(packageManifest.license).toBe('MIT');
    expect(packageManifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/Bodhi-Ventures/aiocs.git',
    });
    expect(packageManifest.homepage).toBe('https://github.com/Bodhi-Ventures/aiocs');
    expect(packageManifest.bugs).toEqual({
      url: 'https://github.com/Bodhi-Ventures/aiocs/issues',
    });
    expect(packageManifest.files).toEqual(expect.arrayContaining([
      'dist',
      'sources',
      'docs',
      'LICENSE',
      'README.md',
      'skills',
    ]));
    expect(packageManifest.bin).toEqual({
      docs: './dist/cli.js',
      'aiocs-mcp': './dist/mcp-server.js',
    });
  });

  it('ships a license, JSON contract doc, and agent skill', () => {
    const licensePath = join(repoRoot, 'LICENSE');
    const contractPath = join(repoRoot, 'docs', 'json-contract.md');
    const skillPath = join(repoRoot, 'skills', 'aiocs', 'SKILL.md');

    expect(existsSync(licensePath)).toBe(true);
    expect(readFileSync(licensePath, 'utf8')).toContain('MIT License');

    expect(existsSync(contractPath)).toBe(true);
    expect(readFileSync(contractPath, 'utf8')).toContain('CLI JSON Contract');
    expect(readFileSync(contractPath, 'utf8')).toContain('daemon.started');

    expect(existsSync(skillPath)).toBe(true);
    const skillBody = readFileSync(skillPath, 'utf8');
    expect(skillBody).toContain('aiocs');
    expect(skillBody).toContain('--json');
    expect(skillBody).toContain('aiocs-mcp');
  });

  it('ships CI and release workflows aligned with validation and npm publishing', () => {
    const ciWorkflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
    const releaseWorkflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');

    expect(existsSync(ciWorkflowPath)).toBe(true);
    expect(readFileSync(ciWorkflowPath, 'utf8')).toContain('npm pack --dry-run');
    expect(readFileSync(ciWorkflowPath, 'utf8')).toContain('docker build');

    expect(existsSync(releaseWorkflowPath)).toBe(true);
    const workflow = readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('npm publish --provenance');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('git tag');
    expect(workflow.indexOf('npm version')).toBeLessThan(workflow.indexOf('pnpm build'));
    expect(workflow.indexOf('git push origin main')).toBeLessThan(workflow.indexOf('npm publish --provenance'));
    expect(workflow.indexOf('npm publish --provenance')).toBeLessThan(workflow.indexOf('gh release create'));
  });
});
