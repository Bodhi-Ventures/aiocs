export type WorkspaceCompilerProvider = 'lmstudio';

export type WorkspaceCompilerProfile = {
  provider: WorkspaceCompilerProvider;
  model: string;
  temperature: number;
  topP: number;
  maxInputChars: number;
  maxOutputTokens: number;
  concurrency: number;
};

export type WorkspaceArtifactKind =
  | 'concept'
  | 'summary'
  | 'report'
  | 'slides'
  | 'image'
  | 'index'
  | 'note';

export type WorkspaceOutputFormat = 'report' | 'slides' | 'summary';

export type WorkspaceRecord = {
  id: string;
  label: string;
  purpose: string | null;
  compilerProfile: WorkspaceCompilerProfile;
  defaultOutputFormats: WorkspaceOutputFormat[];
  bindingCount: number;
  artifactCount: number;
  lastCompileRunId: string | null;
  lastCompileStatus: 'success' | 'failed' | null;
  lastCompiledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSourceBindingRecord = {
  workspaceId: string;
  sourceId: string;
  createdAt: string;
};

export type WorkspaceCompileRunStatus = 'success' | 'failed';

export type WorkspaceCompileRunRecord = {
  runId: string;
  workspaceId: string;
  status: WorkspaceCompileRunStatus;
  sourceFingerprint: string;
  artifactCount: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string;
};

export type WorkspaceArtifactChunkInput = {
  sectionTitle: string;
  markdown: string;
};

export type WorkspaceArtifactProvenanceInput = {
  sourceId: string;
  snapshotId: string;
  chunkIds: number[];
};

export type WorkspaceArtifactRecord = {
  workspaceId: string;
  path: string;
  kind: WorkspaceArtifactKind;
  contentHash: string;
  compilerMetadata: Record<string, unknown>;
  stale: boolean;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceArtifactProvenanceRecord = {
  workspaceId: string;
  path: string;
  sourceId: string;
  snapshotId: string;
  chunkIds: number[];
};
