import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export type GitRepoFixture = {
  root: string;
  fileUrl: string;
  commit(files: Record<string, string>, message: string): string;
};

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

export function createGitRepoFixture(root: string): GitRepoFixture {
  mkdirSync(root, { recursive: true });
  runGit(['init', '-b', 'main'], root);
  runGit(['config', 'user.name', 'aiocs-tests'], root);
  runGit(['config', 'user.email', 'aiocs-tests@example.com'], root);

  return {
    root,
    fileUrl: new URL(`file://${root}`).toString(),
    commit(files: Record<string, string>, message: string): string {
      writeFiles(root, files);
      runGit(['add', '.'], root);
      runGit(['commit', '-m', message], root);
      return runGit(['rev-parse', 'HEAD'], root);
    },
  };
}
