import { randomUUID } from "node:crypto";
import { notionJobSettings } from "../infrastructure/notion-job-settings.ts";
import { parseNotionBundle } from "./notion-bundle.ts";
import { MAX_NOTION_JOB_PAYLOAD_BYTES } from "./notion-import-job-payload.ts";
import { assertNotionImportPlan, notionBundleHash } from "./notion-import-plan.ts";
import { importNotionBundle, MAX_IMPORT_PAGES, type NotionImportDeps } from "./notion-import.ts";
import type { NotionImageCopier } from "./notion-import-images.ts";
import {
  NotionJobError, NOTION_JOB_LEASE_MS, assertNotionJobContent, notionJobHash, notionJobRequestKey,
  notionJobReportSucceeded, safeNotionJobReport,
  type NotionJobPayload, type ClaimedNotionJob, type NotionJobsPersistencePort, type SafeNotionJobReport, type NotionJobState,
} from "./notion-durable-jobs.ts";

/** A one-shot approved input, not a Notion client, scheduler or new import planner. */
export function createNotionJobService({ store, deps, env = process.env }: {
  store: NotionJobsPersistencePort; deps: NotionImportDeps; env?: NodeJS.ProcessEnv;
}) {
  const settings = notionJobSettings(env);
  if (!settings) return null;
  const { keyring } = settings;
  return Object.freeze({
    async start(input: { actorId: string; bundle: unknown; planToken: unknown; idempotencyKey: unknown }) {
      const requestKeyHash = notionJobRequestKey(input.actorId, input.idempotencyKey);
      assertNotionJobContent(input.bundle);
      let json: string;
      try { json = JSON.stringify(input.bundle); } catch { throw new NotionJobError("IMPORT_JOB_INPUT_INVALID"); }
      if (typeof json !== "string" || Buffer.byteLength(json) > MAX_NOTION_JOB_PAYLOAD_BYTES) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const bundle = parseNotionBundle(input.bundle);
      if (bundle.pages.length > MAX_IMPORT_PAGES) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const plan = deps.verifyNotionImportPlan(input.planToken);
      const now = Date.now();
      assertNotionImportPlan(plan, { actorId: input.actorId, bundleHash: notionBundleHash(input.bundle),
        generation: await deps.getImportPlanGeneration(), now });
      const id = randomUUID(), expiresAt = plan.expiresAt;
      const context = { jobId: id, ownerId: input.actorId, expiresAt };
      const bytes = Buffer.from(json), planBytes = Buffer.from(String(input.planToken));
      try {
        return await store.enqueueNotionImportJob({ id, ownerId: input.actorId, total: bundle.pages.length,
          expiresAt, requestKeyHash, fingerprint: notionJobHash(JSON.stringify([plan.bundleHash, input.planToken])),
          payload: keyring.seal({ ...context, bundle: bytes, plan: planBytes, now }) });
      } finally { bytes.fill(0); planBytes.fill(0); }
    },
    open(claim: ClaimedNotionJob): { bundle: unknown; planToken: string } {
      const expected = { jobId: claim.fence.jobId, ownerId: claim.fence.ownerId, expiresAt: claim.status.expiresAt };
      let opened: { bundle: Buffer; plan: Buffer };
      try { opened = keyring.open(JSON.parse(claim.payload) as NotionJobPayload, expected, Date.now()); }
      catch { throw new NotionJobError("IMPORT_JOB_INPUT_INVALID"); }
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        return { bundle: JSON.parse(decoder.decode(opened.bundle)) as unknown, planToken: decoder.decode(opened.plan) };
      } catch { throw new NotionJobError("IMPORT_JOB_INPUT_INVALID"); }
      finally { opened.bundle.fill(0); opened.plan.fill(0); }
    },
  });
}
export type NotionJobService = NonNullable<ReturnType<typeof createNotionJobService>>;
export type NotionJobImageCopier = (url: string, previousSrc: string | undefined, ownerId: string) => ReturnType<NotionImageCopier>;

/** Physical ownership lasts until all work and heartbeat calls settle; no detached writes. */
export async function executeNextNotionJob({ jobs, store, deps, copyImage, signal, onOutcome, executionDeadlineAt }: {
  jobs: NotionJobService; store: NotionJobsPersistencePort; deps: NotionImportDeps;
  copyImage?: NotionJobImageCopier; signal?: AbortSignal; executionDeadlineAt?: number;
  onOutcome?: (state: NotionJobState | "unavailable") => void;
}): Promise<boolean> {
  if (executionDeadlineAt !== undefined && (!Number.isSafeInteger(executionDeadlineAt) || executionDeadlineAt <= 0)) throw new RangeError("Invalid import execution deadline.");
  if (signal?.aborted || executionDeadlineAt !== undefined && Date.now() >= executionDeadlineAt) return false;
  const claim = await store.claimNotionImportJob();
  if (!claim) return false;
  const { fence } = claim;
  const writeFence = executionDeadlineAt === undefined ? fence : { ...fence, notAfter: executionDeadlineAt };
  let lost = false, importing = false, stopping = false;
  let report: SafeNotionJobReport | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  function assertRunning(): void {
    if (lost || signal?.aborted || executionDeadlineAt !== undefined && Date.now() >= executionDeadlineAt) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  }
  function renew(progress?: SafeNotionJobReport): Promise<void> {
    const next = pending.then(async () => {
      assertRunning();
      if (!await store.heartbeatNotionImportJob({ fence, ...(progress ? { report: progress } : {}) })) {
        lost = true;
        throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
      }
    });
    // Retain the physical promise even on failure; there is never an overlapping heartbeat.
    pending = next.catch(() => { lost = true; });
    return next;
  }
  function schedule(): void {
    if (stopping) return;
    heartbeat = setTimeout(() => {
      renew().catch(() => { lost = true; }).finally(schedule);
    }, Math.floor(NOTION_JOB_LEASE_MS / 3));
    heartbeat.unref();
  }
  schedule();
  try {
    const input = jobs.open(claim);
    const fencedDeps: NotionImportDeps = { ...deps, commitNotionImportWork: async input => {
      assertRunning();
      return deps.commitNotionImportWork({ ...input, jobFence: writeFence });
    } };
    let attempts = 0;
    const copies = new Map<string, Awaited<ReturnType<NotionImageCopier>>>();
    const boundedCopy: NotionImageCopier = async (url, previous) => {
      await renew();
      const cached = copies.get(url);
      if (cached) return cached;
      if (attempts >= 8) return { ok: false, reason: "image copy limit reached; preview and retry the import" };
      attempts += 1;
      const copied = await (copyImage ?? (async () => ({ ok: false as const, reason: "media storage is not configured" })))(url, previous, fence.ownerId);
      await renew();
      // Cache failures too: repeated blocks cannot spend another network attempt.
      copies.set(url, copied);
      return copied;
    };
    importing = true;
    const result = await importNotionBundle({ actorId: fence.ownerId, ...input, apply: true, deps: fencedDeps,
      copyImage: boundedCopy, beforeWork: () => renew(),
      onProgress: async pages => {
        report = safeNotionJobReport(pages);
        await renew(report);
      },
    });
    report = safeNotionJobReport(result.pages);
    stopping = true;
    clearTimeout(heartbeat);
    await pending;
    assertRunning();
    const state = notionJobReportSucceeded(report, claim.status.total) ? "succeeded" : "failed";
    await store.finishNotionImportJob({ fence, state, report });
  } catch {
    stopping = true;
    clearTimeout(heartbeat);
    await pending;
    // Never replay a possibly committed work. Even a lost response demands a fresh preview.
    await store.finishNotionImportJob({ fence, state: importing ? "interrupted" : "failed", ...(report ? { report } : {}) });
  } finally {
    stopping = true;
    clearTimeout(heartbeat);
    await pending;
  }
  if (onOutcome) {
    const status = await store.getMyNotionImportJob({ actorId: fence.ownerId, jobId: fence.jobId });
    onOutcome(status?.state ?? "unavailable");
  }
  return true;
}
