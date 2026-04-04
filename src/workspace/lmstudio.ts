import { LMStudioClient } from '@lmstudio/sdk';

import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import {
  getLmStudioRuntimeConfig,
  type LmStudioRuntimeConfig,
} from './compiler-profile.js';
import type { WorkspaceCompilerProfile } from './types.js';

export type LmStudioCompilerStatus = {
  baseUrl: string;
  configuredModel: string;
  loadedModels: string[];
  modelLoaded: boolean;
};

export const LMSTUDIO_SANITIZER_VERSION = 'lmstudio-sanitizer-v2';

export type LmStudioCompileInput = {
  profile: WorkspaceCompilerProfile;
  systemPrompt?: string;
  userPrompt: string;
  env?: NodeJS.ProcessEnv;
};

const silentLmStudioLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  log() {},
};

function createClient(config: LmStudioRuntimeConfig): LMStudioClient {
  return new LMStudioClient({
    baseUrl: config.baseUrl,
    logger: silentLmStudioLogger,
  });
}

function stripTaggedReasoningBlocks(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|start_of_focus\|>[\s\S]*?<\|end_of_focus\|>/gi, '')
    .replace(/<\|start_header_id\|>[\s\S]*?<\|end_header_id\|>/gi, '');
}

function stripChannelMarkers(lines: string[]): string[] {
  return lines.filter((line) => !/^<\|[^>]+>.*$/.test(line.trim()));
}

function normalizeMetaCandidate(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^[*_`]+/, '')
    .replace(/[*_`]+:?\s*$/, '')
    .replace(/^\(([^)]+)\):?/, '$1')
    .trim();
}

function isLikelyDocumentStart(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return (
    trimmed.startsWith('#')
    || trimmed === '---'
    || trimmed.startsWith('<!--')
    || trimmed.startsWith('```')
    || trimmed.startsWith('>')
  );
}

function isLikelyReasoningLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return true;
  }

  return /^(?:[-*]\s+)?(?:goal|requirements?|plan|reasoning|thoughts?|thinking|analysis|approach|notes?)\b[:：]/i.test(trimmed);
}

function isLikelyMetaLeakLine(line: string): boolean {
  const normalized = normalizeMetaCandidate(line);
  return /\b(?:Actually, looking at the text|let'?s check|context says)\b/i.test(normalized)
    || /^(?:user question|workspace context(?: provided)?|the user asks|looking through the text)\b/i.test(normalized);
}

function isLikelyReasoningTailStart(line: string): boolean {
  const normalized = normalizeMetaCandidate(line);
  if (normalized.length === 0) {
    return false;
  }

  return /^(?:final check|double check|sanity check|one detail|one more look|final polish|final structure|self-correction|self correction|wait|actually)\b/i.test(normalized)
    || /^(?:looking at the user question again|looking at the context|one more look at the context|let me check|i will|i'll|i should|i can|i need to|i am going to|since the context)\b/i.test(normalized);
}

function dedentCommonIndentation(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ +/)?.[0].length ?? 0)
    .filter((indent) => indent > 0);
  if (indents.length === 0) {
    return lines;
  }

  const commonIndent = Math.min(...indents);
  if (commonIndent <= 0) {
    return lines;
  }

  return lines.map((line) => (line.startsWith(' '.repeat(commonIndent)) ? line.slice(commonIndent) : line));
}

function sanitizeGeneratedMarkdown(content: string): string {
  const withoutTaggedBlocks = stripTaggedReasoningBlocks(content).replace(/\r\n/g, '\n').trim();
  if (withoutTaggedBlocks.length === 0) {
    return '';
  }

  const lines = stripChannelMarkers(withoutTaggedBlocks.split('\n'));
  const startIndex = lines.findIndex((line) => isLikelyDocumentStart(line));
  const candidateLines = startIndex >= 0 ? lines.slice(startIndex) : lines;

  let firstMeaningfulIndex = 0;
  while (
    firstMeaningfulIndex < candidateLines.length
    && isLikelyReasoningLine(candidateLines[firstMeaningfulIndex] ?? '')
  ) {
    firstMeaningfulIndex += 1;
  }

  const meaningfulLines = candidateLines.slice(firstMeaningfulIndex);
  const reasoningTailIndex = meaningfulLines.findIndex((line) => isLikelyReasoningTailStart(line));
  const boundedLines = reasoningTailIndex >= 0
    ? meaningfulLines.slice(0, reasoningTailIndex)
    : meaningfulLines;
  const cleanedLines = dedentCommonIndentation(
    boundedLines.filter((line) => !isLikelyMetaLeakLine(line)),
  );

  return cleanedLines
    .join('\n')
    .replace(/httpshttps:\/\//g, 'https://')
    .replace(/httphttp:\/\//g, 'http://')
    .replace(/httpss:\/\//g, 'https://')
    .trim();
}

function extractLoadedModelNames(loadedModels: unknown[]): string[] {
  return loadedModels.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const name =
      (typeof candidate.identifier === 'string' ? candidate.identifier : null)
      ?? (typeof candidate.modelKey === 'string' ? candidate.modelKey : null)
      ?? (typeof candidate.id === 'string' ? candidate.id : null);

    return name ? [name] : [];
  });
}

export async function getLmStudioCompilerStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LmStudioCompilerStatus> {
  const config = getLmStudioRuntimeConfig(env);

  try {
    const client = createClient(config);
    const loadedModels = extractLoadedModelNames(await client.llm.listLoaded());

    return {
      baseUrl: config.baseUrl,
      configuredModel: config.model,
      loadedModels,
      modelLoaded: loadedModels.includes(config.model),
    };
  } catch (error) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceCompilerUnavailable,
      `LM Studio is not ready: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function compileWithLmStudio(input: LmStudioCompileInput): Promise<{
  model: string;
  content: string;
}> {
  const config = getLmStudioRuntimeConfig(input.env);
  const modelName = input.env?.AIOCS_LMSTUDIO_MODEL ?? input.profile.model ?? config.model;

  try {
    const client = createClient(config);
    const model = await client.llm.model(modelName);
    const messages = [
      ...(input.systemPrompt ? [{ role: 'system' as const, content: input.systemPrompt }] : []),
      { role: 'user' as const, content: input.userPrompt },
    ];
    const response = await model.respond(messages, {
      temperature: input.profile.temperature,
      topPSampling: input.profile.topP,
      maxTokens: input.profile.maxOutputTokens,
    });
    const content = sanitizeGeneratedMarkdown(response.content);
    if (content.length === 0) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.workspaceCompilerUnavailable,
        `LM Studio compile failed: model '${modelName}' returned no usable Markdown content`,
      );
    }

    return {
      model: modelName,
      content,
    };
  } catch (error) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.workspaceCompilerUnavailable,
      `LM Studio compile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
