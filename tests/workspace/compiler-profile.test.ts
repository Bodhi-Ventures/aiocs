import { describe, expect, it } from 'vitest';

import { AiocsError, AIOCS_ERROR_CODES } from '../../src/errors.js';
import {
  DEFAULT_LMSTUDIO_MODEL,
  getLmStudioRuntimeConfig,
  resolveEffectiveWorkspaceCompilerProfile,
  resolveWorkspaceCompilerProfile,
} from '../../src/workspace/compiler-profile.js';

describe('workspace compiler profile', () => {
  it('uses LM Studio Gemma 4 defaults for workspace compilation', () => {
    expect(resolveWorkspaceCompilerProfile()).toEqual({
      provider: 'lmstudio',
      model: DEFAULT_LMSTUDIO_MODEL,
      temperature: 0.1,
      topP: 0.9,
      maxInputChars: 12_000,
      maxOutputTokens: 4_096,
      concurrency: 1,
    });
  });

  it('allows controlled overrides while preserving lmstudio as the provider', () => {
    expect(resolveWorkspaceCompilerProfile({
      model: 'google/gemma-4-27b-it',
      temperature: 0.2,
      topP: 0.95,
      maxInputChars: 16_000,
      maxOutputTokens: 2_048,
      concurrency: 2,
    })).toEqual({
      provider: 'lmstudio',
      model: 'google/gemma-4-27b-it',
      temperature: 0.2,
      topP: 0.95,
      maxInputChars: 16_000,
      maxOutputTokens: 2_048,
      concurrency: 2,
    });
  });

  it('parses LM Studio runtime config from env with stable defaults', () => {
    expect(getLmStudioRuntimeConfig({
      AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:2345',
      AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-27b-it',
      AIOCS_LMSTUDIO_TIMEOUT_MS: '45000',
    })).toEqual({
      baseUrl: 'ws://127.0.0.1:2345',
      model: 'google/gemma-4-27b-it',
      timeoutMs: 45_000,
    });
  });

  it('lets env override the stored model for existing workspaces at runtime', () => {
    expect(resolveEffectiveWorkspaceCompilerProfile({
      provider: 'lmstudio',
      model: 'stored-model',
      temperature: 0.1,
      topP: 0.9,
      maxInputChars: 12_000,
      maxOutputTokens: 4_096,
      concurrency: 1,
    }, {
      AIOCS_LMSTUDIO_MODEL: 'env-model',
    })).toEqual({
      provider: 'lmstudio',
      model: 'env-model',
      temperature: 0.1,
      topP: 0.9,
      maxInputChars: 12_000,
      maxOutputTokens: 4_096,
      concurrency: 1,
    });
  });

  it('fails fast on invalid LM Studio runtime config', () => {
    expect(() => getLmStudioRuntimeConfig({
      AIOCS_LMSTUDIO_TIMEOUT_MS: '0',
    })).toThrowError(
      expect.objectContaining<Partial<AiocsError>>({
        code: AIOCS_ERROR_CODES.workspaceCompilerConfigInvalid,
      }),
    );
  });
});
