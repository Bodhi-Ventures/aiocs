export const AIOCS_ERROR_CODES = {
  invalidArgument: 'INVALID_ARGUMENT',
  sourceNotFound: 'SOURCE_NOT_FOUND',
  snapshotNotFound: 'SNAPSHOT_NOT_FOUND',
  snapshotDiffBaseNotFound: 'SNAPSHOT_DIFF_BASE_NOT_FOUND',
  noPagesFetched: 'NO_PAGES_FETCHED',
  noProjectScope: 'NO_PROJECT_SCOPE',
  chunkNotFound: 'CHUNK_NOT_FOUND',
  pageNotFound: 'PAGE_NOT_FOUND',
  referenceFileNotFound: 'REFERENCE_FILE_NOT_FOUND',
  invalidReferenceFile: 'INVALID_REFERENCE_FILE',
  sourceContextInvalid: 'SOURCE_CONTEXT_INVALID',
  authEnvMissing: 'AUTH_ENV_MISSING',
  canaryFailed: 'CANARY_FAILED',
  backupConflict: 'BACKUP_CONFLICT',
  backupInvalid: 'BACKUP_INVALID',
  backupSourceMissing: 'BACKUP_SOURCE_MISSING',
  embeddingConfigInvalid: 'EMBEDDING_CONFIG_INVALID',
  embeddingProviderUnavailable: 'EMBEDDING_PROVIDER_UNAVAILABLE',
  vectorStoreUnavailable: 'VECTOR_STORE_UNAVAILABLE',
  embeddingJobNotFound: 'EMBEDDING_JOB_NOT_FOUND',
  internalError: 'INTERNAL_ERROR',
} as const;

export type AiocsErrorCode = typeof AIOCS_ERROR_CODES[keyof typeof AIOCS_ERROR_CODES];

export class AiocsError extends Error {
  readonly code: AiocsErrorCode;
  readonly details?: unknown;

  constructor(code: AiocsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AiocsError';
    this.code = code;
    this.details = details;
  }
}

export function isAiocsError(error: unknown): error is AiocsError {
  return error instanceof AiocsError;
}

export function toAiocsError(error: unknown): AiocsError {
  if (isAiocsError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new AiocsError(AIOCS_ERROR_CODES.internalError, error.message);
  }

  return new AiocsError(AIOCS_ERROR_CODES.internalError, String(error));
}
