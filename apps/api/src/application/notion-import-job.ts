/**
 * Pure state transitions for a durable Notion import job. Persistence must apply
 * each transition atomically (including the version check); these helpers alone
 * do not provide a queue, a lease, or authorization for a storage adapter.
 * Bundles and signed image URLs deliberately do not belong in this status object.
 */
export type NotionImportJob = {
  id: string;
  ownerId: string;
  state: "queued" | "running" | "succeeded" | "failed";
  version: number;
  completed: number;
  total: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
};

export function createNotionImportJob(id: string, ownerId: string, total: number): NotionImportJob {
  if (!id || !ownerId || !Number.isSafeInteger(total) || total < 0) throw new Error("Invalid import job");
  return { id, ownerId, state: "queued", version: 0, completed: 0, total, leaseToken: null, leaseExpiresAt: null };
}

/** A status lookup must never disclose the existence of another owner's job. */
export function visibleNotionImportJob(job: NotionImportJob | null, actorId: string): NotionImportJob | null {
  return job?.ownerId === actorId ? { ...job, leaseToken: null } : null;
}

/** Claim queued or expired work. A fresh unpredictable token is supplied by the worker. */
export function claimNotionImportJob(job: NotionImportJob, token: string, now: number, leaseMs: number): NotionImportJob | null {
  if (!token || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) throw new Error("Invalid lease");
  if (job.state !== "queued" && !(job.state === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now)) return null;
  if (job.state === "running" && job.leaseToken === token) throw new Error("A reclaimed lease needs a fresh token");
  return { ...job, state: "running", version: job.version + 1, leaseToken: token, leaseExpiresAt: now + leaseMs };
}

/** Stale, expired or replaced workers must not change the durable status. */
function holdsLease(job: NotionImportJob, token: string, now: number): boolean {
  return Number.isSafeInteger(now) && job.state === "running" && !!token && job.leaseToken === token && job.leaseExpiresAt !== null && now < job.leaseExpiresAt;
}

export function advanceNotionImportJob(job: NotionImportJob, token: string, now: number, completed: number, leaseMs: number): NotionImportJob | null {
  if (!holdsLease(job, token, now)) return null;
  if (!Number.isSafeInteger(completed) || completed < job.completed || completed > job.total || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) throw new Error("Invalid progress");
  return { ...job, completed, leaseExpiresAt: now + leaseMs, version: job.version + 1 };
}

export function finishNotionImportJob(job: NotionImportJob, token: string, now: number, state: "succeeded" | "failed"): NotionImportJob | null {
  if (!holdsLease(job, token, now)) return null;
  if (state !== "succeeded" && state !== "failed") throw new Error("Invalid terminal state");
  if (state === "succeeded" && job.completed !== job.total) throw new Error("Incomplete job cannot succeed");
  return { ...job, state, leaseToken: null, leaseExpiresAt: null, version: job.version + 1 };
}
