import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function getAiocsDataDir(): string {
  const override = process.env.AIOCS_DATA_DIR;
  if (override) {
    mkdirSync(expandTilde(override), { recursive: true });
    return expandTilde(override);
  }

  const target = join(homedir(), '.aiocs', 'data');
  mkdirSync(target, { recursive: true });
  return target;
}

export function getAiocsConfigDir(): string {
  const override = process.env.AIOCS_CONFIG_DIR;
  if (override) {
    mkdirSync(expandTilde(override), { recursive: true });
    return expandTilde(override);
  }

  const target = join(homedir(), '.aiocs', 'config');
  mkdirSync(target, { recursive: true });
  return target;
}
