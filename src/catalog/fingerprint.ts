import { createHash } from 'node:crypto';

type SnapshotFingerprintInput = {
  sourceId: string;
  configHash: string;
  revisionKey?: string;
  pages: Array<{
    url: string;
    contentHash: string;
  }>;
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildSnapshotFingerprint(input: SnapshotFingerprintInput): string {
  const normalizedPages = [...input.pages].sort((left, right) => left.url.localeCompare(right.url));
  const payload = JSON.stringify({
    sourceId: input.sourceId,
    configHash: input.configHash,
    revisionKey: input.revisionKey ?? null,
    pages: normalizedPages,
  });

  return sha256(payload);
}
