import { randomUUID } from "node:crypto";
import {
  NotionJobError, NOTION_JOB_LEASE_MS, NOTION_JOB_STATUS_RETENTION_MS,
  notionJobRequestKey, assertNotionJobCapacity, assertNotionJobProgress, notionJobBacklog, assertNotionJobFence, assertNotionJobOwner, claimedNotionJob,
  encodeNotionJobInput, encodeNotionJobReport, notionJobReportSucceeded, notionJobStatus, validNotionJobId,
  type EnqueueNotionJob, type NotionJobFence, type NotionJobsPersistencePort,
} from "../application/notion-durable-jobs.ts";
import { NOTION_IMPORT_PLAN_TTL_MS } from "../application/notion-import-plan.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { PgDatabase, PgExecutor, PgTransaction } from "./postgres-driver.ts";

async function clock(tx: PgExecutor): Promise<number> {
  const [row] = await tx.unsafe("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now");
  return Number(row!.now);
}
/** Lock the job BEFORE page/article locks, and retain it until the work commits. */
export async function assertPostgresNotionJobFence(tx: PgTransaction, fence: NotionJobFence): Promise<void> {
  assertNotionJobFence(fence);
  const [row] = await tx.unsafe("SELECT state, lease_token, lease_expires_at, expires_at FROM notion_import_jobs WHERE id = $1 AND owner_id = $2 FOR UPDATE", [fence.jobId, fence.ownerId]);
  // clock_timestamp AFTER lock acquisition: transaction-start now() could admit an expired waiter.
  const now = await clock(tx);
  if (fence.notAfter !== undefined && fence.notAfter <= now) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  if (!row || row.state !== "running" || row.lease_token !== fence.leaseToken || Number(row.lease_expires_at) <= now || Number(row.expires_at) <= now) {
    throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  }
}
const STATUS_COLUMNS = "id, state, completed, total, created_at, updated_at, expires_at, retain_until, report";
export function createPostgresNotionJobsStore(sql: PgDatabase) {
  async function sweep(tx: PgExecutor, now: number): Promise<void> {
    // SKIP LOCKED avoids head-of-line blocking on a job finishing a valid work.
    // A cancelled/expired lease can never write, even while awaiting the next sweep.
    await tx.unsafe(`WITH stale AS (
      SELECT id FROM notion_import_jobs WHERE state IN ('queued', 'running')
      AND (expires_at <= $1 OR (state = 'running' AND lease_expires_at <= $1))
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1000
    ) UPDATE notion_import_jobs j SET state = CASE WHEN j.state = 'running' THEN 'interrupted' ELSE 'expired' END,
      payload = NULL, stored_bytes = 0, lease_token = NULL, lease_expires_at = NULL, updated_at = $1
      FROM stale WHERE j.id = stale.id`, [now]);
    await tx.unsafe(`DELETE FROM notion_import_jobs WHERE id IN (SELECT id FROM notion_import_jobs
      WHERE state NOT IN ('queued', 'running') AND retain_until <= $1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1000)`, [now]);
  }
  async function find(tx: PgExecutor, id: string, actor: string, lock = false) {
    const [row] = await tx.unsafe(`SELECT ${STATUS_COLUMNS}, lease_token, lease_expires_at FROM notion_import_jobs WHERE id = $1 AND owner_id = $2${lock ? " FOR UPDATE" : ""}`, [id, actor]);
    return row;
  }
  const store = {
    async findMyNotionImportJobRequest({ actorId, requestKey }: { actorId: string; requestKey: string }) {
      const hash = notionJobRequestKey(actorId, requestKey);
      return sql.begin(async tx => {
        await sweep(tx, await clock(tx));
        const [row] = await tx.unsafe(`SELECT ${STATUS_COLUMNS} FROM notion_import_jobs
          WHERE owner_id = $1 AND request_key_hash = $2`, [actorId, hash]);
        return row ? notionJobStatus(row) : null;
      });
    },
    async readNextNotionImportJobInput({ afterId }: { afterId?: string }) {
      if (afterId !== undefined && !validNotionJobId(afterId)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const [row] = await sql.unsafe(`SELECT id, owner_id, expires_at, total, fingerprint, payload FROM notion_import_jobs
        WHERE state IN ('queued', 'running') AND id > $1 ORDER BY id LIMIT 1`, [afterId ?? ""]);
      return row ? { id: String(row.id), ownerId: String(row.owner_id), expiresAt: Number(row.expires_at),
        total: Number(row.total), fingerprint: String(row.fingerprint), payload: String(row.payload) } : null;
    },
    async enqueueNotionImportJob(input: EnqueueNotionJob) {
      const payload = encodeNotionJobInput(input);
      return sql.begin(async tx => {
        // One narrow admission lock serializes quota sums and owner/key insertion.
        // It is not held by workers or article writes; those lock individual jobs.
        await tx.unsafe("SELECT pg_advisory_xact_lock(1314343498, 1)");
        const now = await clock(tx);
        await sweep(tx, now);
        const [existing] = await tx.unsafe(`SELECT ${STATUS_COLUMNS}, fingerprint FROM notion_import_jobs WHERE owner_id = $1 AND request_key_hash = $2`, [input.ownerId, input.requestKeyHash]);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) throw new NotionJobError("IMPORT_JOB_IDEMPOTENCY_CONFLICT");
          return notionJobStatus(existing);
        }
        if (input.expiresAt <= now || input.expiresAt > now + NOTION_IMPORT_PLAN_TTL_MS) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        const [capacity] = await tx.unsafe(`SELECT count(*) AS global_rows,
          count(*) FILTER (WHERE owner_id = $1) AS owner_rows,
          count(*) FILTER (WHERE state IN ('queued', 'running')) AS global_active,
          count(*) FILTER (WHERE owner_id = $1 AND state IN ('queued', 'running')) AS owner_active,
          COALESCE(sum(stored_bytes), 0) AS global_bytes,
          COALESCE(sum(stored_bytes) FILTER (WHERE owner_id = $1), 0) AS owner_bytes FROM notion_import_jobs`, [input.ownerId]);
        const bytes = Buffer.byteLength(payload);
        assertNotionJobCapacity({ ownerActive: Number(capacity!.owner_active), globalActive: Number(capacity!.global_active),
          ownerRows: Number(capacity!.owner_rows), globalRows: Number(capacity!.global_rows),
          ownerBytes: Number(capacity!.owner_bytes), globalBytes: Number(capacity!.global_bytes) }, bytes);
        const [row] = await tx.unsafe(`INSERT INTO notion_import_jobs (id, owner_id, request_key_hash, fingerprint, state, total,
          payload, stored_bytes, created_at, updated_at, expires_at, retain_until)
          VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $8, $9, $10) RETURNING *`, [input.id, input.ownerId,
          input.requestKeyHash, input.fingerprint, input.total, payload, bytes, now, input.expiresAt, input.expiresAt + NOTION_JOB_STATUS_RETENTION_MS]);
        return notionJobStatus(row!);
      });
    },
    async getMyNotionImportJob({ actorId, jobId }: { actorId: string; jobId: string }) {
      assertNotionJobOwner(actorId);
      if (!validNotionJobId(jobId)) return null;
      return sql.begin(async tx => {
        await sweep(tx, await clock(tx));
        const row = await find(tx, jobId, actorId);
        return row ? notionJobStatus(row) : null;
      });
    },
    async listMyNotionImportJobs({ actorId, limit = 20 }: { actorId: string; limit?: number }) {
      assertNotionJobOwner(actorId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      return sql.begin(async tx => {
        await sweep(tx, await clock(tx));
        const rows = await tx.unsafe(`SELECT ${STATUS_COLUMNS} FROM notion_import_jobs WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [actorId, limit]);
        return rows.map(notionJobStatus);
      });
    },
    async cancelNotionImportJob({ actorId, jobId }: { actorId: string; jobId: string }) {
      assertNotionJobOwner(actorId);
      if (!validNotionJobId(jobId)) return null;
      return sql.begin(async tx => {
        await sweep(tx, await clock(tx));
        // Wait for an already admitted work, then cancel before the NEXT work.
        const row = await find(tx, jobId, actorId, true);
        if (!row) return null;
        if (row.state !== "queued" && row.state !== "running") return notionJobStatus(row);
        const now = await clock(tx);
        const [cancelled] = await tx.unsafe(`UPDATE notion_import_jobs SET
          state = CASE WHEN expires_at <= $1 OR (state = 'running' AND lease_expires_at <= $1)
            THEN CASE WHEN state = 'running' THEN 'interrupted' ELSE 'expired' END ELSE 'cancelled' END,
          payload = NULL, stored_bytes = 0, lease_token = NULL, lease_expires_at = NULL, updated_at = $1
          WHERE id = $2 RETURNING *`, [now, jobId]);
        return notionJobStatus(cancelled!);
      });
    },
    async claimNotionImportJob() {
      return sql.begin(async tx => {
        const now = await clock(tx);
        await sweep(tx, now);
        const [candidate] = await tx.unsafe(`SELECT id FROM notion_import_jobs WHERE state = 'queued' AND expires_at > $1
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, [now]);
        if (!candidate) return null;
        const [claimed] = await tx.unsafe(`UPDATE notion_import_jobs SET state = 'running', lease_token = $1,
          lease_expires_at = $2, updated_at = $3 WHERE id = $4 AND state = 'queued' RETURNING *`, [randomUUID(),
          now + NOTION_JOB_LEASE_MS, now, candidate.id]);
        return claimedNotionJob(claimed!);
      });
    },
    async heartbeatNotionImportJob({ fence, report }: Parameters<NotionJobsPersistencePort["heartbeatNotionImportJob"]>[0]) {
      assertNotionJobFence(fence);
      const json = report ? encodeNotionJobReport(report) : null;
      return sql.begin(async tx => {
        const row = await find(tx, fence.jobId, fence.ownerId, true);
        const now = await clock(tx);
        if (!row || row.state !== "running" || row.lease_token !== fence.leaseToken || Number(row.lease_expires_at) <= now || Number(row.expires_at) <= now) return false;
        if (report) assertNotionJobProgress(row, report);
        await tx.unsafe(`UPDATE notion_import_jobs SET lease_expires_at = $1, updated_at = $2, completed = $3,
          report = COALESCE($4, report) WHERE id = $5`, [Math.min(now + NOTION_JOB_LEASE_MS, Number(row.expires_at)), now,
          report?.pages.length ?? Number(row.completed), json, fence.jobId]);
        return true;
      });
    },
    async finishNotionImportJob({ fence, state, report }: Parameters<NotionJobsPersistencePort["finishNotionImportJob"]>[0]) {
      assertNotionJobFence(fence);
      if (!["succeeded", "failed", "interrupted"].includes(state)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      const json = report ? encodeNotionJobReport(report) : null;
      return sql.begin(async tx => {
        const row = await find(tx, fence.jobId, fence.ownerId, true);
        const now = await clock(tx);
        if (!row || row.state !== "running" || row.lease_token !== fence.leaseToken || Number(row.lease_expires_at) <= now || Number(row.expires_at) <= now) return false;
        if (report) assertNotionJobProgress(row, report);
        if (state === "succeeded" && (!report || !notionJobReportSucceeded(report, Number(row.total)))) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        await tx.unsafe(`UPDATE notion_import_jobs SET state = $1, payload = NULL, stored_bytes = 0,
          lease_token = NULL, lease_expires_at = NULL, updated_at = $2, completed = $3, report = COALESCE($4, report)
          WHERE id = $5`, [state, now, report?.pages.length ?? Number(row.completed), json, fence.jobId]);
        return true;
      });
    },
    async notionImportJobBacklog() {
      // One statement snapshot; no payload/report columns are selected or decoded.
      const rows = await sql.unsafe(`SELECT state, stored_bytes, created_at, expires_at, retain_until, lease_expires_at,
        floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS sampled_at FROM notion_import_jobs LIMIT 1001`);
      return notionJobBacklog(rows, rows.length ? Number(rows[0]!.sampled_at) : await clock(sql));
    },
    async sweepNotionImportJobs() {
      await sql.begin(async tx => { await sweep(tx, await clock(tx)); });
    },
  } satisfies NotionJobsPersistencePort;
  return Object.freeze(store) satisfies Pick<TypedPersistenceAdapterContract, "findMyNotionImportJobRequest" | "readNextNotionImportJobInput" | "enqueueNotionImportJob" | "getMyNotionImportJob" | "listMyNotionImportJobs" | "cancelNotionImportJob" | "claimNotionImportJob" | "heartbeatNotionImportJob" | "finishNotionImportJob" | "sweepNotionImportJobs" | "notionImportJobBacklog">;
}
