import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

const patternSchema = z.string().min(1);
const positiveIntSchema = z.number().int().positive();
const scheduleSchema = z.object({
  everyHours: positiveIntSchema,
});

const interactionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('hover'),
    selector: z.string().min(1),
    timeoutMs: positiveIntSchema.optional(),
  }),
  z.object({
    action: z.literal('click'),
    selector: z.string().min(1),
    timeoutMs: positiveIntSchema.optional(),
  }),
  z.object({
    action: z.literal('press'),
    key: z.string().min(1),
  }),
  z.object({
    action: z.literal('wait'),
    timeoutMs: positiveIntSchema,
  }),
]);

const clipboardExtractSchema = z.object({
  strategy: z.literal('clipboardButton'),
  interactions: z.array(interactionSchema).min(1),
  clipboardTimeoutMs: positiveIntSchema.default(10_000),
  fallback: z.object({
    strategy: z.literal('readability'),
  }).optional(),
});

const selectorExtractSchema = z.object({
  strategy: z.literal('selector'),
  selector: z.string().min(1),
});

const readabilityExtractSchema = z.object({
  strategy: z.literal('readability'),
});

const webAuthHeaderSchema = z.object({
  name: z.string().min(1),
  valueFromEnv: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1).optional(),
  include: z.array(patternSchema).min(1).optional(),
});

const webAuthCookieSchema = z.object({
  name: z.string().min(1),
  valueFromEnv: z.string().min(1),
  domain: z.string().min(1),
  path: z.string().min(1).default('/'),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

const webCanaryCheckSchema = z.object({
  url: z.string().url(),
  expectedTitle: z.string().min(1).optional(),
  expectedText: z.string().min(1).optional(),
  minMarkdownLength: positiveIntSchema.default(40),
});

const gitAuthSchema = z.object({
  tokenFromEnv: z.string().min(1),
  username: z.string().min(1).default('x-access-token'),
  scheme: z.enum(['basic', 'bearer']).default('basic'),
});

const gitCanaryCheckSchema = z.object({
  path: z.string().min(1),
  expectedTitle: z.string().min(1).optional(),
  expectedText: z.string().min(1).optional(),
  minContentLength: positiveIntSchema.default(40),
});

const baseSourceSpecSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  schedule: scheduleSchema,
});

const webSourceSpecSchema = baseSourceSpecSchema.extend({
  kind: z.literal('web').default('web'),
  startUrls: z.array(z.string().url()).min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  discovery: z.object({
    include: z.array(patternSchema).min(1),
    exclude: z.array(patternSchema).default([]),
    maxPages: positiveIntSchema,
  }),
  extract: z.discriminatedUnion('strategy', [
    clipboardExtractSchema,
    selectorExtractSchema,
    readabilityExtractSchema,
  ]),
  normalize: z.object({
    prependSourceComment: z.boolean().default(true),
  }),
  auth: z.object({
    headers: z.array(webAuthHeaderSchema).default([]),
    cookies: z.array(webAuthCookieSchema).default([]),
  }).optional(),
  canary: z.object({
    everyHours: positiveIntSchema.optional(),
    checks: z.array(webCanaryCheckSchema).min(1),
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

const gitSourceSpecSchema = baseSourceSpecSchema.extend({
  kind: z.literal('git'),
  repo: z.object({
    url: z.string().url(),
    ref: z.string().min(1).default('HEAD'),
    include: z.array(patternSchema).min(1),
    exclude: z.array(patternSchema).default([]),
    maxFiles: positiveIntSchema.default(2_000),
    textFileMaxBytes: positiveIntSchema.default(262_144),
    auth: gitAuthSchema.optional(),
  }),
  canary: z.object({
    everyHours: positiveIntSchema.optional(),
    checks: z.array(gitCanaryCheckSchema).min(1),
  }).optional(),
}).superRefine((spec, context) => {
  const protocol = new URL(spec.repo.url).protocol;
  if (!['https:', 'http:', 'file:'].includes(protocol)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repo', 'url'],
      message: `Unsupported git source protocol '${protocol}'. Use https:// or file://.`,
    });
  }
});

const sourceSpecSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  if (!('kind' in candidate)) {
    return {
      ...candidate,
      kind: 'web',
    };
  }

  return candidate;
}, z.discriminatedUnion('kind', [
  webSourceSpecSchema,
  gitSourceSpecSchema,
]));

export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export type WebSourceSpec = z.infer<typeof webSourceSpecSchema>;
export type GitSourceSpec = z.infer<typeof gitSourceSpecSchema>;
export type ExtractStrategy = WebSourceSpec['extract'];
export type DiscoveryConfig = WebSourceSpec['discovery'];
export type SourceCanaryCheck = z.infer<typeof webCanaryCheckSchema>;
export type GitSourceCanaryCheck = z.infer<typeof gitCanaryCheckSchema>;
export type ResolvedSourceCanary =
  | {
      kind: 'web';
      everyHours: number;
      checks: SourceCanaryCheck[];
    }
  | {
      kind: 'git';
      everyHours: number;
      checks: GitSourceCanaryCheck[];
    };

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

export function isWebSourceSpec(spec: SourceSpec): spec is WebSourceSpec {
  return spec.kind === 'web';
}

export function isGitSourceSpec(spec: SourceSpec): spec is GitSourceSpec {
  return spec.kind === 'git';
}

export function resolveSourceCanary(spec: WebSourceSpec): {
  kind: 'web';
  everyHours: number;
  checks: SourceCanaryCheck[];
};
export function resolveSourceCanary(spec: GitSourceSpec): {
  kind: 'git';
  everyHours: number;
  checks: GitSourceCanaryCheck[];
};
export function resolveSourceCanary(spec: SourceSpec): ResolvedSourceCanary {
  if (spec.kind === 'git') {
    return {
      kind: 'git',
      everyHours: spec.canary?.everyHours ?? Math.max(1, Math.min(spec.schedule.everyHours, 6)),
      checks: spec.canary?.checks ?? [
        {
          path: 'README.md',
          minContentLength: 40,
        },
      ],
    };
  }

  return {
    kind: 'web',
    everyHours: spec.canary?.everyHours ?? Math.max(1, Math.min(spec.schedule.everyHours, 6)),
    checks: spec.canary?.checks ?? [
      {
        url: spec.startUrls[0]!,
        minMarkdownLength: 40,
      },
    ],
  };
}
