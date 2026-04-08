import type { SourceContext } from './source-context.js';

export type RetrievalLearning = {
  learningId: string;
  sourceId: string;
  snapshotId: string | null;
  learningType: 'discovery' | 'negative';
  intent: string;
  pageUrl: string | null;
  filePath: string | null;
  title: string | null;
  note: string | null;
  searchTerms: string[];
  createdAt: string;
  updatedAt: string;
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function overlapScore(queryTokens: string[], candidate: string): number {
  const candidateTokens = new Set(tokenize(candidate));
  if (candidateTokens.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  }

  return matches;
}

export function scoreLearning(query: string, learning: RetrievalLearning): number {
  const queryTokens = tokenize(query);
  const candidates = [learning.intent, ...learning.searchTerms];
  const bestOverlap = Math.max(0, ...candidates.map((candidate) => overlapScore(queryTokens, candidate)));
  const exactIntentBoost = learning.intent.trim().toLowerCase() === query.trim().toLowerCase() ? 10 : 0;
  const recencyBoost = learning.learningType === 'discovery' ? 1 : 0;
  return bestOverlap + exactIntentBoost + recencyBoost;
}

export function scoreSourceContext(query: string, context: SourceContext | null): number {
  if (!context) {
    return 0;
  }

  const queryTokens = tokenize(query);
  const candidates = [
    context.purpose ?? '',
    context.summary ?? '',
    ...context.topicHints,
    ...context.gotchas,
    ...context.authNotes,
    ...context.commonLocations.flatMap((location) => [location.label, location.note ?? '', location.url ?? '', location.filePath ?? '']),
  ];

  return Math.max(0, ...candidates.map((candidate) => overlapScore(queryTokens, candidate)));
}
