import type { openCatalog } from '../catalog/catalog.js';
import { compileWorkspace, resolveWorkspaceCompileContext } from './compile.js';

type Catalog = ReturnType<typeof openCatalog>;

export type WorkspaceCompileWorkerResult = {
  processedJobs: number;
  succeededJobs: Array<{
    workspaceId: string;
    sourceFingerprint: string;
    changedSourceIds: string[];
    changedRawInputIds: string[];
  }>;
  failedJobs: Array<{
    workspaceId: string;
    errorMessage: string;
  }>;
};

export function enqueueWorkspaceCompileIfEligible(input: {
  catalog: Catalog;
  workspaceId: string;
  sourceIds?: string[];
  rawInputIds?: string[];
  requestedFingerprint?: string | null;
}): {
  enqueued: boolean;
  reason: 'no-inputs' | 'missing-snapshots' | null;
} {
  const compileContext = resolveWorkspaceCompileContext({
    catalog: input.catalog,
    workspaceId: input.workspaceId,
  });

  if (!compileContext.eligible) {
    return {
      enqueued: false,
      reason: compileContext.ineligibleReason,
    };
  }

  input.catalog.enqueueWorkspaceCompile({
    workspaceId: input.workspaceId,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    ...(input.rawInputIds ? { rawInputIds: input.rawInputIds } : {}),
    ...(typeof input.requestedFingerprint !== 'undefined'
      ? { requestedFingerprint: input.requestedFingerprint }
      : {}),
  });

  return {
    enqueued: true,
    reason: null,
  };
}

export async function processQueuedWorkspaceCompileJobs(input: {
  catalog: Catalog;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  maxJobs?: number;
}): Promise<WorkspaceCompileWorkerResult> {
  const succeededJobs: WorkspaceCompileWorkerResult['succeededJobs'] = [];
  const failedJobs: WorkspaceCompileWorkerResult['failedJobs'] = [];
  const maxJobs = input.maxJobs ?? Number.POSITIVE_INFINITY;
  let processedJobs = 0;

  while (processedJobs < maxJobs) {
    const job = input.catalog.claimNextWorkspaceCompileJob();
    if (!job) {
      break;
    }

    try {
      const result = await compileWorkspace({
        catalog: input.catalog,
        dataDir: input.dataDir,
        workspaceId: job.workspaceId,
        ...(input.env ? { env: input.env } : {}),
      });
      input.catalog.completeWorkspaceCompileJob({
        workspaceId: job.workspaceId,
        completedFingerprint: result.sourceFingerprint,
      });
      succeededJobs.push({
        workspaceId: job.workspaceId,
        sourceFingerprint: result.sourceFingerprint,
        changedSourceIds: result.changedSourceIds,
        changedRawInputIds: result.changedRawInputIds,
      });
    } catch (error) {
      input.catalog.failWorkspaceCompileJob({
        workspaceId: job.workspaceId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      failedJobs.push({
        workspaceId: job.workspaceId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    processedJobs += 1;
  }

  return {
    processedJobs,
    succeededJobs,
    failedJobs,
  };
}
