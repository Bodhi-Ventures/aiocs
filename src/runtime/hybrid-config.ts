import { AiocsError, AIOCS_ERROR_CODES } from '../errors.js';

export type SearchMode = 'auto' | 'lexical' | 'hybrid' | 'semantic';

export type HybridRuntimeConfig = {
  defaultSearchMode: SearchMode;
  qdrantUrl: string;
  qdrantCollection: string;
  qdrantTimeoutMs: number;
  embeddingProvider: 'ollama';
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  ollamaTimeoutMs: number;
  ollamaMaxInputChars: number;
  embeddingBatchSize: number;
  embeddingJobsPerCycle: number;
  lexicalCandidateWindow: number;
  vectorCandidateWindow: number;
  rrfK: number;
};

function parsePositiveInteger(value: string | undefined, field: string, fallback: number): number {
  if (typeof value === 'undefined' || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingConfigInvalid,
      `${field} must be a positive integer`,
    );
  }

  return parsed;
}

function parseSearchMode(value: string | undefined): SearchMode {
  if (!value) {
    return 'auto';
  }

  if (value === 'auto' || value === 'lexical' || value === 'hybrid' || value === 'semantic') {
    return value;
  }

  throw new AiocsError(
    AIOCS_ERROR_CODES.embeddingConfigInvalid,
    'AIOCS_SEARCH_MODE_DEFAULT must be one of: auto, lexical, hybrid, semantic',
  );
}

export function getHybridRuntimeConfig(env: NodeJS.ProcessEnv = process.env): HybridRuntimeConfig {
  const embeddingProvider = env.AIOCS_EMBEDDING_PROVIDER ?? 'ollama';
  if (embeddingProvider !== 'ollama') {
    throw new AiocsError(
      AIOCS_ERROR_CODES.embeddingConfigInvalid,
      'AIOCS_EMBEDDING_PROVIDER currently supports only ollama',
    );
  }

  return {
    defaultSearchMode: parseSearchMode(env.AIOCS_SEARCH_MODE_DEFAULT),
    qdrantUrl: env.AIOCS_QDRANT_URL ?? 'http://127.0.0.1:6333',
    qdrantCollection: env.AIOCS_QDRANT_COLLECTION ?? 'aiocs_docs_chunks',
    qdrantTimeoutMs: parsePositiveInteger(env.AIOCS_QDRANT_TIMEOUT_MS, 'AIOCS_QDRANT_TIMEOUT_MS', 1_000),
    embeddingProvider: 'ollama',
    ollamaBaseUrl: env.AIOCS_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    ollamaEmbeddingModel: env.AIOCS_OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
    ollamaTimeoutMs: parsePositiveInteger(env.AIOCS_OLLAMA_TIMEOUT_MS, 'AIOCS_OLLAMA_TIMEOUT_MS', 10_000),
    ollamaMaxInputChars: parsePositiveInteger(env.AIOCS_OLLAMA_MAX_INPUT_CHARS, 'AIOCS_OLLAMA_MAX_INPUT_CHARS', 4_000),
    embeddingBatchSize: parsePositiveInteger(env.AIOCS_EMBEDDING_BATCH_SIZE, 'AIOCS_EMBEDDING_BATCH_SIZE', 32),
    embeddingJobsPerCycle: parsePositiveInteger(env.AIOCS_EMBEDDING_JOB_LIMIT_PER_CYCLE, 'AIOCS_EMBEDDING_JOB_LIMIT_PER_CYCLE', 2),
    lexicalCandidateWindow: parsePositiveInteger(env.AIOCS_LEXICAL_CANDIDATE_WINDOW, 'AIOCS_LEXICAL_CANDIDATE_WINDOW', 40),
    vectorCandidateWindow: parsePositiveInteger(env.AIOCS_VECTOR_CANDIDATE_WINDOW, 'AIOCS_VECTOR_CANDIDATE_WINDOW', 40),
    rrfK: parsePositiveInteger(env.AIOCS_RRF_K, 'AIOCS_RRF_K', 60),
  };
}
