import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getLmStudioCompilerStatusMock } = vi.hoisted(() => ({
  getLmStudioCompilerStatusMock: vi.fn(),
}));

vi.mock('../../src/workspace/lmstudio.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/workspace/lmstudio.js')>('../../src/workspace/lmstudio.js');
  return {
    ...actual,
    getLmStudioCompilerStatus: getLmStudioCompilerStatusMock,
  };
});

import { runDoctor } from '../../src/doctor.js';

describe('doctor LM Studio reporting', () => {
  beforeEach(() => {
    getLmStudioCompilerStatusMock.mockReset();
  });

  it('reports a warning when LM Studio is reachable but the configured model is not loaded', async () => {
    getLmStudioCompilerStatusMock.mockResolvedValue({
      baseUrl: 'ws://127.0.0.1:1234',
      configuredModel: 'google/gemma-4-26b-a4b',
      loadedModels: ['google/gemma-4-9b-it'],
      modelLoaded: false,
    });

    const report = await runDoctor({
      ...process.env,
      AIOCS_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
      AIOCS_LMSTUDIO_MODEL: 'google/gemma-4-26b-a4b',
    });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lmstudio',
        status: 'warn',
      }),
    ]));
  });
});
