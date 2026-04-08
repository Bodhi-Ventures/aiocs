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

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function hasTokenCoverage(requiredTokens: string[], candidate: string): boolean {
  if (requiredTokens.length === 0) {
    return false;
  }

  const candidateTokens = new Set(tokenize(candidate));
  return requiredTokens.every((token) => candidateTokens.has(token));
}

const NAVIGATIONAL_TERMS = new Set([
  'api',
  'apis',
  'auth',
  'authentication',
  'docs',
  'documentation',
  'endpoint',
  'endpoints',
  'overview',
  'reference',
  'references',
  'rest',
  'sdk',
  'transport',
  'websocket',
  'ws',
]);

export function classifyRetrievalQuery(query: string): {
  isNavigational: boolean;
  queryTokens: string[];
  routingTokens: string[];
  matchedNavigationalTerms: string[];
} {
  const queryTokens = uniqueTokens(tokenize(query));
  const matchedNavigationalTerms = uniqueTokens(queryTokens.filter((token) => NAVIGATIONAL_TERMS.has(token)));
  return {
    isNavigational: matchedNavigationalTerms.length > 0,
    queryTokens,
    routingTokens: queryTokens,
    matchedNavigationalTerms,
  };
}

export function scorePageCandidate(query: string, input: {
  pageTitle: string;
  pageReference: string;
  sectionTitles: string[];
  bestLexicalScore: number;
  bestVectorScore: number;
  learningScore: number;
  sourceHintScore: number;
  commonLocationScore: number;
}): number {
  const intent = classifyRetrievalQuery(query);
  const routingTokens = intent.routingTokens;
  const titleOverlap = overlapScore(routingTokens, input.pageTitle);
  const referenceOverlap = overlapScore(routingTokens, input.pageReference);
  const sectionOverlap = Math.max(0, ...input.sectionTitles.map((sectionTitle) => overlapScore(routingTokens, sectionTitle)));
  const exactTitleCoverage = hasTokenCoverage(routingTokens, input.pageTitle);
  const exactReferenceCoverage = hasTokenCoverage(routingTokens, input.pageReference);

  const lexicalWeight = intent.isNavigational ? 6 : 4;
  const vectorWeight = intent.isNavigational ? 1 : 3;
  const titleWeight = intent.isNavigational ? 8 : 4;
  const referenceWeight = intent.isNavigational ? 6 : 3;
  const sectionWeight = intent.isNavigational ? 4 : 2;
  const sourceHintWeight = intent.isNavigational ? 3 : 2;
  const commonLocationWeight = intent.isNavigational ? 7 : 4;
  const learningWeight = intent.isNavigational ? 5 : 4;
  const pureVectorPenalty = intent.isNavigational
    && input.bestLexicalScore === 0
    && titleOverlap === 0
    && referenceOverlap === 0
    && input.commonLocationScore === 0
    ? 8
    : 0;

  return (
    (input.bestLexicalScore * lexicalWeight)
    + (input.bestVectorScore * vectorWeight)
    + (titleOverlap * titleWeight)
    + (referenceOverlap * referenceWeight)
    + (sectionOverlap * sectionWeight)
    + (input.sourceHintScore * sourceHintWeight)
    + (input.commonLocationScore * commonLocationWeight)
    + (input.learningScore * learningWeight)
    + (exactTitleCoverage ? 12 : 0)
    + (exactReferenceCoverage ? 10 : 0)
    - pureVectorPenalty
  );
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
