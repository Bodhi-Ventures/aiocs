import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  modelRespondMock,
  listLoadedMock,
  modelMock,
  clientConstructorMock,
} = vi.hoisted(() => ({
  modelRespondMock: vi.fn(),
  listLoadedMock: vi.fn(),
  modelMock: vi.fn(),
  clientConstructorMock: vi.fn(),
}));

vi.mock('@lmstudio/sdk', () => ({
  LMStudioClient: class {
    llm = {
      listLoaded: listLoadedMock,
      model: modelMock,
    };

    constructor(config?: unknown) {
      clientConstructorMock(config);
    }
  },
}));

import { compileWithLmStudio, getLmStudioCompilerStatus } from '../../src/workspace/lmstudio.js';
import { resolveWorkspaceCompilerProfile } from '../../src/workspace/compiler-profile.js';

describe('LM Studio workspace compiler', () => {
  beforeEach(() => {
    modelRespondMock.mockReset();
    listLoadedMock.mockReset();
    modelMock.mockReset();
    clientConstructorMock.mockReset();

    listLoadedMock.mockResolvedValue([
      {
        identifier: 'google/gemma-4-26b-a4b',
        modelKey: 'google/gemma-4-26b-a4b',
      },
    ]);
    modelRespondMock.mockResolvedValue({
      content: '# Summary\n\nCompiled workspace note.',
    });
    modelMock.mockResolvedValue({
      respond: modelRespondMock,
    });
  });

  it('reports LM Studio availability and whether the configured model is loaded', async () => {
    const status = await getLmStudioCompilerStatus({
      AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
      AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-26b-a4b',
    });

    expect(clientConstructorMock).toHaveBeenCalledWith({
      baseUrl: 'ws://127.0.0.1:1234',
      logger: expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
        debug: expect.any(Function),
        log: expect.any(Function),
      }),
    });
    expect(status).toEqual({
      baseUrl: 'ws://127.0.0.1:1234',
      configuredModel: 'google/gemma-4-26b-a4b',
      loadedModels: ['google/gemma-4-26b-a4b'],
      modelLoaded: true,
    });
  });

  it('compiles a workspace artifact using the configured model and inference parameters', async () => {
    const result = await compileWithLmStudio({
      profile: resolveWorkspaceCompilerProfile(),
      systemPrompt: 'You are compiling a research wiki.',
      userPrompt: 'Summarize the maker flow.',
      env: {
        AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
        AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-26b-a4b',
      },
    });

    expect(modelMock).toHaveBeenCalledWith('google/gemma-4-26b-a4b');
    expect(modelRespondMock).toHaveBeenCalledWith([
      { role: 'system', content: 'You are compiling a research wiki.' },
      { role: 'user', content: 'Summarize the maker flow.' },
    ], {
      temperature: 0.1,
      topPSampling: 0.9,
      maxTokens: 4_096,
    });
    expect(result).toEqual({
      model: 'google/gemma-4-26b-a4b',
      content: '# Summary\n\nCompiled workspace note.',
    });
  });

  it('strips reasoning and control markers from LM Studio output before returning content', async () => {
    modelRespondMock.mockResolvedValueOnce({
      content: [
        '<|channel>thought',
        '* Goal: produce a summary.',
        '* Requirements: output markdown.',
        '',
        '# Summary',
        '',
        'Compiled workspace note.',
      ].join('\n'),
    });

    const result = await compileWithLmStudio({
      profile: resolveWorkspaceCompilerProfile(),
      systemPrompt: 'You are compiling a research wiki.',
      userPrompt: 'Summarize the maker flow.',
      env: {
        AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
        AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-26b-a4b',
      },
    });

    expect(result.content).toBe('# Summary\n\nCompiled workspace note.');
  });

  it('normalizes common indentation and strips leaked meta commentary from LM Studio output', async () => {
    modelRespondMock.mockResolvedValueOnce({
      content: [
        '# Report',
        '    ',
        '    ## Runtime',
        '    * **Runtime**: [Deno](httpshttps://deno.com)',
        '    * **Note**: stable runtime',
        '    Actually, looking at the text: this line should not ship.',
      ].join('\n'),
    });

    const result = await compileWithLmStudio({
      profile: resolveWorkspaceCompilerProfile(),
      systemPrompt: 'You are compiling a research wiki.',
      userPrompt: 'Write a report.',
      env: {
        AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
        AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-26b-a4b',
      },
    });

    expect(result.content).toBe([
      '# Report',
      '',
      '## Runtime',
      '* **Runtime**: [Deno](https://deno.com)',
      '* **Note**: stable runtime',
    ].join('\n'));
  });
});
