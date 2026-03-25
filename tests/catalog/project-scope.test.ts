import { describe, expect, it } from 'vitest';

import { resolveProjectScope } from '../../src/catalog/project-scope.js';

describe('resolveProjectScope', () => {
  it('prefers the deepest matching linked project', () => {
    const scope = resolveProjectScope('/workspace/apps/trader/src', [
      {
        projectPath: '/workspace',
        sourceIds: ['root-docs'],
      },
      {
        projectPath: '/workspace/apps/trader',
        sourceIds: ['trader-docs'],
      },
    ]);

    expect(scope?.projectPath).toBe('/workspace/apps/trader');
    expect(scope?.sourceIds).toEqual(['trader-docs']);
  });

  it('returns null when cwd is outside linked projects', () => {
    const scope = resolveProjectScope('/other/place', [
      {
        projectPath: '/workspace/apps/trader',
        sourceIds: ['trader-docs'],
      },
    ]);

    expect(scope).toBeNull();
  });
});
