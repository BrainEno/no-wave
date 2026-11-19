import { randomUUID } from "node:crypto";
import {
  NotionJobError, NOTION_JOB_LEASE_MS, NOTION_JOB_STATUS_RETENTION_MS,
  notionJobRequestKey, assertNotionJobCapacity, assertNotionJobProgress, notionJobBacklog, assertNotionJobFence, assertNotionJobOwner, claimedNotionJob,
  encodeNotionJobInput, encodeNotionJobReport, notionJobReportSucceeded, notionJobStatus, validNotionJobId,
  type EnqueueNotionJob, type NotionJobFence, type NotionJobsPersistencePort,
} from "../application/notion-durable-jobs.ts";
import { NOTION_IMPORT_PLAN_TTL_MS } from "../application/notion-import-plan.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRunner } from "./sqlite.ts";

function clock(db: SqliteRunner): number {
  return Number(db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get()!.now);
}
/** Called only inside the SAME work transaction as all article/provenance writes. */
export function assertSqliteNotionJobFence(db: SqliteRunner, fence: NotionJobFence): void {
  assertNotionJobFence(fence);
  const now = clock(db);
  if (fence.notAfter !== undefined && fence.notAfter <= now) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  if (!db.prepare(`SELECT id FROM notion_import_jobs WHERE id = ? AND owner_id = ? AND state = 'running'
    AND lease_token = ? AND lease_expires_at > ? AND expires_at > ?`).get(fence.jobId, fence.ownerId, fence.leaseToken, now, now)) {
    throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  }
}
const STATUS_COLUMNS = "id, state, completed, total, created_at, updated_at, expires_at, retain_until, report";
export function createSqliteNotionJobsStore(db: SqliteRunner) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }
  function sweep(now: number): void {
    db.prepare(`UPDATE notion_import_jobs SET state = CASE WHEN state = 'running' THEN 'interrupted' ELSE 'expired' END,
      payload = NULL, stored_bytes = 0, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE state IN ('queued', 'running') AND (expires_at <= ? OR (state = 'running' AND lease_expires_at <= ?))`).run(now, now, now);
    db.prepare("DELETE FROM notion_import_jobs WHERE state NOT IN ('queued', 'running') AND retain_until <= ?").run(now);
  }
  const get = (id: string, actor: string) => db.prepare(`SELECT ${STATUS_COLUMNS}, lease_token, lease_expires_at FROM notion_import_jobs WHERE id = ? AND owner_id = ?`).get(id, actor);
  const store = {
    findMyNotionImportJobRequest({ actorId, requestKey }: { actorId: string; requestKey: string }) {
      const hash = notionJobRequestKey(actorId, requestKey);
      return transaction(() => {
        sweep(clock(db));
        const row = db.prepare(`SELECT ${STATUS_COLUMNS} FROM notion_import_jobs
          WHERE owner_id = ? AND request_key_hash = ?`).get(actorId, hash);
        return row ? notionJobStatus(row) : null;
      });
    },
    readNextNotionImportJobInput({ afterId }: { afterId?: string }) {
      if (afterId !== undefined && !validNotionJobId(afterId)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const row = db.prepare(`SELECT id, owner_id, expires_at, total, fingerprint, payload FROM notion_import_jobs
        WHERE state IN ('queued', 'running') AND id > ? ORDER BY id LIMIT 1`).get(afterId ?? "");
      return row ? { id: String(row.id), ownerId: String(row.owner_id), expiresAt: Number(row.expires_at),
        total: Number(row.total), fingerprint: String(row.fingerprint), payload: String(row.payload) } : null;
    },
    enqueueNotionImportJob(input: EnqueueNotionJob) {
      const payload = encodeNotionJobInput(input);
      return transaction(() => {
        const now = clock(db);
        sweep(now);
        const existing = db.prepare(`SELECT ${STATUS_COLUMNS}, fingerprint FROM notion_import_jobs WHERE owner_id = ? AND request_key_hash = ?`).get(input.ownerId, input.requestKeyHash);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) throw new NotionJobError("IMPORT_JOB_IDEMPOTENCY_CONFLICT");
          return notionJobStatus(existing);
        }
        if (input.expiresAt <= now || input.expiresAt > now + NOTION_IMPORT_PLAN_TTL_MS) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        const rows = db.prepare(`SELECT owner_id, state, stored_bytes FROM notion_import_jobs`).all();
        const capacity = { ownerActive: 0, globalActive: 0, ownerRows: 0, globalRows: rows.length, ownerBytes: 0, globalBytes: 0 };
        for (const row of rows) {
          const own = row.owner_id === input.ownerId;
          const active = row.state === "queued" || row.state === "running";
          capacity.globalActive += Number(active);
          capacity.ownerActive += Number(own && active);
          capacity.ownerRows += Number(own);
          capacity.globalBytes += Number(row.stored_bytes);
          if (own) capacity.ownerBytes += Number(row.stored_bytes);
        }
        const bytes = Buffer.byteLength(payload);
        assertNotionJobCapacity(capacity, bytes);
        db.prepare(`INSERT INTO notion_import_jobs (id, owner_id, request_key_hash, fingerprint, state, total,
          payload, stored_bytes, created_at, updated_at, expires_at, retain_until)
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.ownerId, input.requestKeyHash,
          input.fingerprint, input.total, payload, bytes, now, now, input.expiresAt, input.expiresAt + NOTION_JOB_STATUS_RETENTION_MS);
        return notionJobStatus(get(input.id, input.ownerId)!);
      });
    },
    getMyNotionImportJob({ actorId, jobId }: { actorId: string; jobId: string }) {
      assertNotionJobOwner(actorId);
      if (!validNotionJobId(jobId)) return null;
      return transaction(() => {
        sweep(clock(db));
        const row = get(jobId, actorId);
        return row ? notionJobStatus(row) : null;
      });
    },
    listMyNotionImportJobs({ actorId, limit = 20 }: { actorId: string; limit?: number }) {
      assertNotionJobOwner(actorId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      return transaction(() => {
        sweep(clock(db));
        return db.prepare(`SELECT ${STATUS_COLUMNS} FROM notion_import_jobs WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(actorId, limit).map(notionJobStatus);
      });
    },
    cancelNotionImportJob({ actorId, jobId }: { actorId: string; jobId: string }) {
      assertNotionJobOwner(actorId);
      if (!validNotionJobId(jobId)) return null;
      return transaction(() => {
        const now = clock(db);
        sweep(now);
        db.prepare(`UPDATE notion_import_jobs SET state = 'cancelled', payload = NULL, stored_bytes = 0,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND owner_id = ? AND state IN ('queued', 'running')`).run(now, jobId, actorId);
        const row = get(jobId, actorId);
        return row ? notionJobStatus(row) : null;
      });
    },
    claimNotionImportJob() {
      return transaction(() => {
        const now = clock(db);
        sweep(now);
        const row = db.prepare("SELECT id FROM notion_import_jobs WHERE state = 'queued' AND expires_at > ? ORDER BY created_at, id LIMIT 1").get(now);
        if (!row) return null;
        db.prepare(`UPDATE notion_import_jobs SET state = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'`).run(randomUUID(), now + NOTION_JOB_LEASE_MS, now, row.id);
        return claimedNotionJob(db.prepare("SELECT * FROM notion_import_jobs WHERE id = ?").get(row.id)!);
      });
    },
    heartbeatNotionImportJob({ fence, report }: Parameters<NotionJobsPersistencePort["heartbeatNotionImportJob"]>[0]) {
      assertNotionJobFence(fence);
      const json = report ? encodeNotionJobReport(report) : null;
      return transaction(() => {
        const now = clock(db);
        const row = get(fence.jobId, fence.ownerId);
        if (!row || row.state !== "running" || row.lease_token !== fence.leaseToken || Number(row.lease_expires_at) <= now || Number(row.expires_at) <= now) return false;
        if (report) assertNotionJobProgress(row, report);
        db.prepare(`UPDATE notion_import_jobs SET lease_expires_at = ?, updated_at = ?, completed = ?, report = COALESCE(?, report)
          WHERE id = ?`).run(Math.min(now + NOTION_JOB_LEASE_MS, Number(row.expires_at)), now, report?.pages.length ?? Number(row.completed), json, fence.jobId);
        return true;
      });
    },
    finishNotionImportJob({ fence, state, report }: Parameters<NotionJobsPersistencePort["finishNotionImportJob"]>[0]) {
      assertNotionJobFence(fence);
      if (!["succeeded", "failed", "interrupted"].includes(state)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const json = report ? encodeNotionJobReport(report) : null;
      return transaction(() => {
        const now = clock(db);
        const row = get(fence.jobId, fence.ownerId);
        if (!row || row.state !== "running" || row.lease_token !== fence.leaseToken || Number(row.lease_expires_at) <= now || Number(row.expires_at) <= now) return false;
        if (report) assertNotionJobProgress(row, report);
        if (state === "succeeded" && (!report || !notionJobReportSucceeded(report, Number(row.total)))) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        db.prepare(`UPDATE notion_import_jobs SET state = ?, payload = NULL, stored_bytes = 0, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?, completed = ?, report = COALESCE(?, report) WHERE id = ?`).run(
          state, now, report?.pages.length ?? Number(row.completed), json, fence.jobId);
        return true;
      });
    },
    notionImportJobBacklog() {
      return transaction(() => {
        const now = clock(db);
        const rows = db.prepare("SELECT state, stored_bytes, created_at, expires_at, retain_until, lease_expires_at FROM notion_import_jobs LIMIT 1001").all();
        return notionJobBacklog(rows, now);
      });
    },
    sweepNotionImportJobs() {
      transaction(() => sweep(clock(db)));
    },
  } satisfies NotionJobsPersistencePort;
  return Object.freeze(store) satisfies Pick<TypedPersistenceAdapterContract, "findMyNotionImportJobRequest" | "readNextNotionImportJobInput" | "enqueueNotionImportJob" | "getMyNotionImportJob" | "listMyNotionImportJobs" | "cancelNotionImportJob" | "claimNotionImportJob" | "heartbeatNotionImportJob" | "finishNotionImportJob" | "sweepNotionImportJobs" | "notionImportJobBacklog">;
}
