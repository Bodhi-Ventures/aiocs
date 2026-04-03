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
export type WorkspaceAnswerFormat = WorkspaceOutputFormat | 'note';
export type WorkspaceCompileJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type WorkspaceArtifactLinkRelationKind =
  | 'explicit_link'
  | 'derived_from'
  | 'mentions'
  | 'related_to'
  | 'expands'
  | 'index_entry'
  | 'summary_of'
  | 'concept_of'
  | 'output_depends_on';
export type WorkspaceRawInputKind = 'markdown-dir' | 'pdf' | 'image';
export type WorkspaceSyncTargetKind = 'obsidian';

export type WorkspaceRecord = {
  id: string;
  label: string;
  purpose: string | null;
  autoCompileEnabled: boolean;
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

export type WorkspaceCompileJobRecord = {
  workspaceId: string;
  status: WorkspaceCompileJobStatus;
  requestedSourceIds: string[];
  requestedRawInputIds: string[];
  requestedFingerprint: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
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

export type WorkspaceArtifactRawInputProvenanceInput = {
  rawInputId: string;
  chunkIds: number[];
};

export type WorkspaceArtifactRawInputProvenanceRecord = {
  workspaceId: string;
  path: string;
  rawInputId: string;
  chunkIds: number[];
};

export type WorkspaceArtifactLinkInput = {
  fromPath: string;
  toPath: string;
  relationKind: WorkspaceArtifactLinkRelationKind;
  anchorText?: string | null;
  source?: 'deterministic' | 'compiler';
  broken?: boolean;
};

export type WorkspaceArtifactLinkRecord = {
  workspaceId: string;
  fromPath: string;
  toPath: string;
  relationKind: WorkspaceArtifactLinkRelationKind;
  anchorText: string | null;
  source: 'deterministic' | 'compiler';
  broken: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRawInputChunkInput = {
  sectionTitle: string;
  markdown: string;
  filePath?: string | null;
};

export type WorkspaceRawInputRecord = {
  id: string;
  workspaceId: string;
  kind: WorkspaceRawInputKind;
  label: string;
  sourcePath: string;
  storagePath: string;
  extractedTextPath: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSyncTargetRecord = {
  workspaceId: string;
  kind: WorkspaceSyncTargetKind;
  targetPath: string;
  exportSubdir: string;
  lastSyncedAt: string | null;
  lastSyncStatus: 'success' | 'failed' | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceQuestionRunRecord = {
  id: string;
  workspaceId: string;
  question: string;
  format: WorkspaceAnswerFormat;
  artifactPath: string;
  status: 'success' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  completedAt: string;
};

export type WorkspaceHealthSummary = {
  status: 'healthy' | 'degraded';
  staleArtifactCount: number;
  pendingCompileJobs: number;
  failedCompileJobs: number;
  brokenLinkCount: number;
  orphanArtifactCount: number;
  rawInputCount: number;
  lintFindingCount: number;
};
