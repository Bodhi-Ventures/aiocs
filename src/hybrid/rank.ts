export type RankedCandidate = {
  chunkId: number;
  rank: number;
  signal: 'lexical' | 'vector';
  score?: number;
};

export function reciprocalRankFusion(
  candidateLists: RankedCandidate[][],
  rrfK: number,
): Array<{
  chunkId: number;
  fusedScore: number;
  signals: Array<'lexical' | 'vector'>;
}> {
  const byChunkId = new Map<number, { fusedScore: number; signals: Set<'lexical' | 'vector'> }>();

  for (const candidates of candidateLists) {
    for (const candidate of candidates) {
      const current = byChunkId.get(candidate.chunkId) ?? {
        fusedScore: 0,
        signals: new Set<'lexical' | 'vector'>(),
      };
      current.fusedScore += 1 / (rrfK + candidate.rank);
      current.signals.add(candidate.signal);
      byChunkId.set(candidate.chunkId, current);
    }
  }

  return [...byChunkId.entries()]
    .map(([chunkId, value]) => ({
      chunkId,
      fusedScore: value.fusedScore,
      signals: [...value.signals],
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore || left.chunkId - right.chunkId);
}
