import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

import { AiocsError, AIOCS_ERROR_CODES } from './errors.js';

const commonLocationSchema = z.object({
  label: z.string().min(1),
  url: z.string().url().optional(),
  filePath: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (!value.url && !value.filePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'common location entries must include url or filePath',
      path: ['url'],
    });
  }
});

export const sourceContextSchema = z.object({
  purpose: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  topicHints: z.array(z.string().min(1)).default([]),
  commonLocations: z.array(commonLocationSchema).default([]),
  gotchas: z.array(z.string().min(1)).default([]),
  authNotes: z.array(z.string().min(1)).default([]),
});

export type SourceContext = z.infer<typeof sourceContextSchema>;
export type CommonLocation = z.infer<typeof commonLocationSchema>;

function parseSourceContext(raw: string, extension: string): unknown {
  if (extension === '.json') {
    return JSON.parse(raw);
  }

  return YAML.parse(raw);
}

export async function loadSourceContextFile(path: string): Promise<SourceContext> {
  try {
    const raw = await readFile(path, 'utf8');
    return sourceContextSchema.parse(parseSourceContext(raw, extname(path).toLowerCase()));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.sourceContextInvalid,
        `Invalid source context file '${path}'`,
        {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }

    if (error instanceof Error) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.sourceContextInvalid,
        `Failed to load source context file '${path}': ${error.message}`,
      );
    }

    throw error;
  }
}
