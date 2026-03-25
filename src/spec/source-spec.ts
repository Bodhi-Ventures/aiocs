import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

const patternSchema = z.string().min(1);

const interactionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('hover'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal('click'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal('press'),
    key: z.string().min(1),
  }),
  z.object({
    action: z.literal('wait'),
    timeoutMs: z.number().int().positive(),
  }),
]);

const clipboardExtractSchema = z.object({
  strategy: z.literal('clipboardButton'),
  interactions: z.array(interactionSchema).min(1),
  clipboardTimeoutMs: z.number().int().positive().default(10_000),
});

const selectorExtractSchema = z.object({
  strategy: z.literal('selector'),
  selector: z.string().min(1),
});

const readabilityExtractSchema = z.object({
  strategy: z.literal('readability'),
});

const sourceSpecSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  startUrls: z.array(z.string().url()).min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  discovery: z.object({
    include: z.array(patternSchema).min(1),
    exclude: z.array(patternSchema),
    maxPages: z.number().int().positive(),
  }),
  extract: z.discriminatedUnion('strategy', [
    clipboardExtractSchema,
    selectorExtractSchema,
    readabilityExtractSchema,
  ]),
  normalize: z.object({
    prependSourceComment: z.boolean().default(true),
  }),
  schedule: z.object({
    everyHours: z.number().int().positive(),
  }),
});

export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export type ExtractStrategy = SourceSpec['extract'];
export type DiscoveryConfig = SourceSpec['discovery'];

function parseSourceSpec(raw: string, ext: string): unknown {
  if (ext === '.json') {
    return JSON.parse(raw);
  }

  return YAML.parse(raw);
}

export async function loadSourceSpec(path: string): Promise<SourceSpec> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseSourceSpec(raw, extname(path).toLowerCase());
  return sourceSpecSchema.parse(parsed);
}

export function parseSourceSpecObject(value: unknown): SourceSpec {
  return sourceSpecSchema.parse(value);
}
