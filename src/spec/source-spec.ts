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

const authHeaderSchema = z.object({
  name: z.string().min(1),
  valueFromEnv: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1).optional(),
  include: z.array(patternSchema).min(1).optional(),
});

const authCookieSchema = z.object({
  name: z.string().min(1),
  valueFromEnv: z.string().min(1),
  domain: z.string().min(1),
  path: z.string().min(1).default('/'),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

const canaryCheckSchema = z.object({
  url: z.string().url(),
  expectedTitle: z.string().min(1).optional(),
  expectedText: z.string().min(1).optional(),
  minMarkdownLength: z.number().int().positive().default(40),
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
  auth: z.object({
    headers: z.array(authHeaderSchema).default([]),
    cookies: z.array(authCookieSchema).default([]),
  }).optional(),
  canary: z.object({
    everyHours: z.number().int().positive().optional(),
    checks: z.array(canaryCheckSchema).min(1),
  }).optional(),
}).superRefine((spec, context) => {
  for (const [index, header] of (spec.auth?.headers ?? []).entries()) {
    if (!header.hosts) {
      continue;
    }

    for (const host of header.hosts) {
      if (!spec.allowedHosts.includes(host)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['auth', 'headers', index, 'hosts'],
          message: `Authenticated header host '${host}' must be included in allowedHosts`,
        });
      }
    }
  }
});

export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export type ExtractStrategy = SourceSpec['extract'];
export type DiscoveryConfig = SourceSpec['discovery'];
export type SourceCanaryCheck = z.infer<typeof canaryCheckSchema>;

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

export function resolveSourceCanary(spec: SourceSpec): {
  everyHours: number;
  checks: SourceCanaryCheck[];
} {
  return {
    everyHours: spec.canary?.everyHours ?? Math.max(1, Math.min(spec.schedule.everyHours, 6)),
    checks: spec.canary?.checks ?? [
      {
        url: spec.startUrls[0]!,
        minMarkdownLength: 40,
      },
    ],
  };
}
