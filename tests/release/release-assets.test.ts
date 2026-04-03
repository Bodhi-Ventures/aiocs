import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageManifest = packageJson as Record<string, unknown> & {
  bin: Record<string, string>;
};

describe('release assets', () => {
  it('ships publishable package metadata', () => {
    expect(packageManifest.private).not.toBe(true);
    expect(packageManifest.name).toBe('@bodhi-ventures/aiocs');
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
    expect(packageManifest.publishConfig).toEqual({
      access: 'public',
      provenance: true,
    });
    expect(packageManifest.bin).toEqual({
      docs: './dist/cli.js',
      'aiocs-mcp': './dist/mcp-server.js',
    });
  });

  it('ships a license, user-facing docs, archived design artifacts, agent skill, and production agent config', () => {
    const licensePath = join(repoRoot, 'LICENSE');
    const contractPath = join(repoRoot, 'docs', 'json-contract.md');
    const codexIntegrationPath = join(repoRoot, 'docs', 'codex-integration.md');
    const archivedDesignPath = join(repoRoot, 'plans', 'completed', '2026-04-03-git-repo-sources-design.md');
    const skillPath = join(repoRoot, 'skills', 'aiocs', 'SKILL.md');
    const agentPath = join(repoRoot, 'agents', 'aiocs-docs-specialist.toml');

    expect(existsSync(licensePath)).toBe(true);
    expect(readFileSync(licensePath, 'utf8')).toContain('MIT License');

    expect(existsSync(contractPath)).toBe(true);
    expect(readFileSync(contractPath, 'utf8')).toContain('CLI JSON Contract');
    expect(readFileSync(contractPath, 'utf8')).toContain('daemon.started');

    expect(existsSync(codexIntegrationPath)).toBe(true);
    const codexIntegration = readFileSync(codexIntegrationPath, 'utf8');
    expect(codexIntegration).toContain('Codex Integration');
    expect(codexIntegration).toContain('aiocs-mcp');
    expect(codexIntegration).toContain('~/.codex/skills');
    expect(codexIntegration).toContain('~/.codex/agents');
    expect(codexIntegration).not.toContain('ai-skills/');

    expect(existsSync(archivedDesignPath)).toBe(true);
    expect(readFileSync(archivedDesignPath, 'utf8')).toContain('Git Repo Sources Design');

    expect(existsSync(skillPath)).toBe(true);
    const skillBody = readFileSync(skillPath, 'utf8');
    expect(skillBody).toContain('aiocs');
    expect(skillBody).toContain('--json');
    expect(skillBody).toContain('aiocs-mcp');

    expect(existsSync(agentPath)).toBe(true);
    const agent = readFileSync(agentPath, 'utf8');
    expect(agent).toContain('aiocs_docs_specialist');
    expect(agent).toContain('aiocs-mcp');

    const readmePath = join(repoRoot, 'README.md');
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('npm install -g @bodhi-ventures/aiocs');
    expect(readme).toContain('## Release');
    expect(readme).toContain('git tag vX.Y.Z');
    expect(readme).toContain('git push origin main');
    expect(readme).toContain('git push origin vX.Y.Z');
  });

  it('ships CI and release workflows aligned with validation and npm publishing', () => {
    const ciWorkflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
    const releaseWorkflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');
    const composePath = join(repoRoot, 'docker-compose.yml');

    expect(existsSync(ciWorkflowPath)).toBe(true);
    expect(readFileSync(ciWorkflowPath, 'utf8')).toContain('npm pack --dry-run');
    expect(readFileSync(ciWorkflowPath, 'utf8')).toContain('docker build');
    expect(readFileSync(ciWorkflowPath, 'utf8')).toContain('docker compose config');

    expect(existsSync(composePath)).toBe(true);
    const compose = readFileSync(composePath, 'utf8');
    expect(compose).toContain('aiocs-qdrant');
    expect(compose).toContain('host.docker.internal:11434');
    expect(compose).toContain('host-gateway');

    expect(existsSync(releaseWorkflowPath)).toBe(true);
    const workflow = readFileSync(releaseWorkflowPath, 'utf8');
    expect(workflow).toContain('tags:');
    expect(workflow).toContain("- 'v*.*.*'");
    expect(workflow).not.toContain('workflow_dispatch');
    expect(workflow).toContain('PACKAGE_NAME="@bodhi-ventures/aiocs"');
    expect(workflow).toContain('TAG_VERSION="${GITHUB_REF_NAME#v}"');
    expect(workflow).toContain('npm view "${PACKAGE_NAME}@${TAG_VERSION}" version');
    expect(workflow).toContain('npm publish');
    expect(workflow).toContain('--access public');
    expect(workflow).toContain('--provenance');
    expect(workflow).toContain('gh release create');
    expect(workflow).not.toContain('git config user.name');
    expect(workflow).not.toContain('git config user.email');
    expect(workflow).not.toContain('npm version');
    expect(workflow).not.toContain('git tag');
    expect(workflow).not.toContain('git commit');
    expect(workflow).not.toContain('git push origin HEAD:main');
    expect(workflow.indexOf('npm publish --provenance')).toBeLessThan(workflow.indexOf('gh release create'));
  });
});
