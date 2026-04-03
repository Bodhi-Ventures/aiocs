import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { WorkspaceCompilerProfile } from './types.js';

export const DEFAULT_LMSTUDIO_MODEL = 'google/gemma-4-26b-a4b';

export type LmStudioRuntimeConfig = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

function parsePositiveInteger(value: string | undefined, field: string, fallback: number): number {
  if (typeof value === 'undefined' || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceCompilerConfigInvalid,
      `${field} must be a positive integer`,
    );
  }

  return parsed;
}

function parseProbability(
  value: number | undefined,
  field: keyof Pick<WorkspaceCompilerProfile, 'temperature' | 'topP'>,
  fallback: number,
): number {
  if (typeof value === 'undefined') {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceCompilerConfigInvalid,
      `${field} must be a number between 0 and 1`,
    );
  }

  return value;
}

function parseProfilePositiveInteger(
  value: number | undefined,
  field: keyof Pick<WorkspaceCompilerProfile, 'maxInputChars' | 'maxOutputTokens' | 'concurrency'>,
  fallback: number,
): number {
  if (typeof value === 'undefined') {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceCompilerConfigInvalid,
      `${field} must be a positive integer`,
    );
  }

  return value;
}

export function resolveWorkspaceCompilerProfile(
  input: Partial<Omit<WorkspaceCompilerProfile, 'provider'>> = {},
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceCompilerProfile {
  return {
    provider: 'lmstudio',
    model: input.model ?? env.AIOCS_LMSTUDIO_MODEL ?? DEFAULT_LMSTUDIO_MODEL,
    temperature: parseProbability(input.temperature, 'temperature', 0.1),
    topP: parseProbability(input.topP, 'topP', 0.9),
    maxInputChars: parseProfilePositiveInteger(input.maxInputChars, 'maxInputChars', 12_000),
    maxOutputTokens: parseProfilePositiveInteger(input.maxOutputTokens, 'maxOutputTokens', 4_096),
    concurrency: parseProfilePositiveInteger(input.concurrency, 'concurrency', 1),
  };
}

export function resolveEffectiveWorkspaceCompilerProfile(
  profile: WorkspaceCompilerProfile,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceCompilerProfile {
  return {
    ...profile,
    model: env.AIOCS_LMSTUDIO_MODEL ?? profile.model,
  };
}

export function getLmStudioRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LmStudioRuntimeConfig {
  const rawBaseUrl = env.AIOCS_LMSTUDIO_BASE_URL ?? 'ws://127.0.0.1:1234';
  const baseUrl = rawBaseUrl.startsWith('http://')
    ? `ws://${rawBaseUrl.slice('http://'.length)}`
    : rawBaseUrl.startsWith('https://')
      ? `wss://${rawBaseUrl.slice('https://'.length)}`
      : rawBaseUrl;

  return {
    baseUrl,
    model: env.AIOCS_LMSTUDIO_MODEL ?? DEFAULT_LMSTUDIO_MODEL,
    timeoutMs: parsePositiveInteger(env.AIOCS_LMSTUDIO_TIMEOUT_MS, 'AIOCS_LMSTUDIO_TIMEOUT_MS', 60_000),
  };
}
