import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';
import type { HybridRuntimeConfig } from '../runtime/hybrid-config.js';

export type EmbeddingProviderStatus = {
  ok: boolean;
  modelPresent: boolean;
  baseUrl: string;
  model: string;
  availableModels: string[];
};

export function getEmbeddingModelKey(config: HybridRuntimeConfig): string {
  return `${config.embeddingProvider}:${config.ollamaEmbeddingModel}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Ollama returned a non-JSON response with status ${response.status}`,
    );
  }
}

export async function embedTexts(
  config: HybridRuntimeConfig,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const response = await fetch(`${normalizeBaseUrl(config.ollamaBaseUrl)}/api/embed`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(config.ollamaTimeoutMs),
    body: JSON.stringify({
      model: config.ollamaEmbeddingModel,
      input: texts,
    }),
  }).catch((error: unknown) => {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Unable to reach Ollama at ${config.ollamaBaseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Ollama embed request failed with status ${response.status}`,
      body ? { body } : undefined,
    );
  }

  const payload = await parseJsonResponse(response) as { embeddings?: unknown };
  if (!Array.isArray(payload.embeddings)) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      'Ollama embed response did not include an embeddings array',
    );
  }

  const embeddings = payload.embeddings.map((entry) => {
    if (!Array.isArray(entry) || !entry.every((value) => typeof value === 'number')) {
      throw new AiocsError(
        AIOCS_ERROR_CODES.embeddingProviderUnavailable,
        'Ollama embed response contained an invalid embedding vector',
      );
    }

    return entry;
  });

  if (embeddings.length !== texts.length) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs`,
    );
  }

  return embeddings;
}

export async function getEmbeddingProviderStatus(
  config: HybridRuntimeConfig,
): Promise<EmbeddingProviderStatus> {
  const response = await fetch(`${normalizeBaseUrl(config.ollamaBaseUrl)}/api/tags`, {
    signal: AbortSignal.timeout(config.ollamaTimeoutMs),
  }).catch((error: unknown) => {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Unable to reach Ollama at ${config.ollamaBaseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!response.ok) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingProviderUnavailable,
      `Ollama tags request failed with status ${response.status}`,
    );
  }

  const payload = await parseJsonResponse(response) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  const availableModels = (payload.models ?? [])
    .map((entry) => entry.name ?? entry.model)
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  const modelPresent = availableModels.some((name) =>
    name === config.ollamaEmbeddingModel || name.startsWith(`${config.ollamaEmbeddingModel}:`),
  );

  return {
    ok: modelPresent,
    modelPresent,
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaEmbeddingModel,
    availableModels,
  };
}
