import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.ts";
import { INTERCHANGE_ISSUE_CODES, type InterchangeIssueCode } from "./notion-interchange.ts";
import type { NotionImportAction, NotionImportPageReport } from "./notion-import.ts";
import type { NotionImportJob } from "./notion-import-job.ts";
import type { EncryptedNotionJobPayload } from "./notion-import-job-payload.ts";
import type { PersistenceResult } from "./persistence-ports.ts";

export const NOTION_JOB_LEASE_MS = 60_000;
export const NOTION_JOB_STATUS_RETENTION_MS = 24 * 60 * 60 * 1000;
export const NOTION_JOB_MAX_STORED_BYTES = 12 * 1024 * 1024;
export const NOTION_JOB_OWNER_ACTIVE_LIMIT = 2;
export const NOTION_JOB_GLOBAL_ACTIVE_LIMIT = 32;
export const NOTION_JOB_OWNER_ROW_LIMIT = 20;
export const NOTION_JOB_GLOBAL_ROW_LIMIT = 1000;
export const NOTION_JOB_OWNER_BYTE_LIMIT = 24 * 1024 * 1024;
export const NOTION_JOB_GLOBAL_BYTE_LIMIT = 64 * 1024 * 1024;
export const NOTION_JOB_MAX_REPORT_BYTES = 128 * 1024;
export const NOTION_JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "expired"] as const;
export type NotionJobState = NotionImportJob["state"] | "cancelled" | "interrupted" | "expired";
export type NotionJobFence = { jobId: string; ownerId: string; leaseToken: string; notAfter?: number };
export type SafeNotionJobReport = {
  summary: Record<NotionImportAction, number>;
  pages: { ordinal: number; action: NotionImportAction; locale: string; articleId: string | null; issueCodes: string[] }[];
};
export type NotionJobStatus = {
  id: string; state: NotionJobState; completed: number; total: number;
  createdAt: number; updatedAt: number; expiresAt: number; retainUntil: number;
  report: SafeNotionJobReport | null;
  recovery: "none" | "preview-again" | "review-media-and-preview";
};
export type NotionJobPayload = { keyId: string; bundle: EncryptedNotionJobPayload; plan: EncryptedNotionJobPayload };
export type EnqueueNotionJob = {
  id: string; ownerId: string; requestKeyHash: string; fingerprint: string;
  payload: NotionJobPayload; expiresAt: number; total: number;
};
export type ClaimedNotionJob = { status: NotionJobStatus; fence: NotionJobFence; payload: string };
export type NotionJobInputSnapshot = { id: string; ownerId: string; expiresAt: number; total: number; fingerprint: string; payload: string };
export type NotionJobsPersistencePort = {
  findMyNotionImportJobRequest(input: { actorId: string; requestKey: string }): PersistenceResult<NotionJobStatus | null>;
  readNextNotionImportJobInput(input: { afterId?: string }): PersistenceResult<NotionJobInputSnapshot | null>;
  enqueueNotionImportJob(input: EnqueueNotionJob): PersistenceResult<NotionJobStatus>;
  getMyNotionImportJob(input: { actorId: string; jobId: string }): PersistenceResult<NotionJobStatus | null>;
  listMyNotionImportJobs(input: { actorId: string; limit?: number }): PersistenceResult<NotionJobStatus[]>;
  cancelNotionImportJob(input: { actorId: string; jobId: string }): PersistenceResult<NotionJobStatus | null>;
  claimNotionImportJob(): PersistenceResult<ClaimedNotionJob | null>;
  heartbeatNotionImportJob(input: { fence: NotionJobFence; report?: SafeNotionJobReport }): PersistenceResult<boolean>;
  finishNotionImportJob(input: { fence: NotionJobFence; state: "succeeded" | "failed" | "interrupted"; report?: SafeNotionJobReport }): PersistenceResult<boolean>;
  sweepNotionImportJobs(): PersistenceResult<void>;
  notionImportJobBacklog(): PersistenceResult<NotionJobBacklog>;
};
const ERRORS = {
  IMPORT_STATUS_BUSY: [503, "Import status capacity is unavailable. Retry later."],
  IMPORT_STATUS_UNAVAILABLE: [503, "Import status is unavailable. Retry the status read; do not restart the import."],
  IMPORT_QUEUE_FULL: [429, "Import job capacity is unavailable. Try later; do not change your idempotency key to retry."],
  IMPORT_JOB_INPUT_INVALID: [400, "The import job input or Idempotency-Key is invalid. Supply only a bundle and its preview plan; never send a Notion credential."],
  IMPORT_JOB_IDEMPOTENCY_CONFLICT: [409, "This idempotency key belongs to a different import job request."],
  IMPORT_JOB_LEASE_LOST: [409, "The import job is no longer running under this lease. Review your works and media, then preview again."],
  IMPORT_JOBS_DISABLED: [409, "Durable import jobs are not enabled on this instance. Synchronous import remains available."],
} as const;
export class NotionJobError extends DomainError {
  readonly status: number;
  constructor(code: keyof typeof ERRORS) {
    const [status, message] = ERRORS[code];
    super("NotionJobError", code, message);
    this.status = status;
  }
}
const ACTIONS: readonly NotionImportAction[] = ["create", "update", "skip", "refused", "failed"];
const ISSUE_CODES = new Set<string>(INTERCHANGE_ISSUE_CODES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const emptyNotionJobSummary = (): SafeNotionJobReport["summary"] => ({ create: 0, update: 0, skip: 0, refused: 0, failed: 0 });

export function notionJobHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function notionJobRequestKey(actorId: string, key: unknown): string {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  assertNotionJobOwner(actorId);
  return notionJobHash(JSON.stringify([actorId, key]));
}
export function assertNotionJobOwner(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 200 || /[\u0000-\u001f\u007f]/.test(ownerId)) {
    throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  }
}
export function validNotionJobKeyId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id);
}
export function validNotionJobId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}
export function assertNotionJobFence(fence: NotionJobFence): void {
  if (!fence || !validNotionJobId(fence.jobId) || !validNotionJobId(fence.leaseToken)) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
  assertNotionJobOwner(fence.ownerId);
  if (fence.notAfter !== undefined && (!Number.isSafeInteger(fence.notAfter) || fence.notAfter <= 0)) throw new NotionJobError("IMPORT_JOB_LEASE_LOST");
}

/** Allowlisted facts only: no source ids/titles/details, plan, URL, raw error or content. */
export function safeNotionJobReport(pages: readonly NotionImportPageReport[]): SafeNotionJobReport {
  if (pages.length > 200) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  const summary = emptyNotionJobSummary();
  const safe = pages.map((page, index) => {
    if (!ACTIONS.includes(page.action)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    summary[page.action] += 1;
    return {
      ordinal: index + 1, action: page.action,
      locale: ["zh-CN", "zh-TW", "en"].includes(page.locale) ? page.locale : "",
      articleId: validNotionJobId(page.articleId) ? page.articleId : null,
      issueCodes: [...new Set(page.issues.map(issue => issue.code).filter(code => ISSUE_CODES.has(code)))].sort(),
    };
  });
  return { summary, pages: safe };
}

/** Validate stored reports as rigorously as fresh reports; a database is not a serializer. */
export function encodeNotionJobReport(report: SafeNotionJobReport): string {
  if (!report || !Array.isArray(report.pages) || report.pages.length > 200) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  const synthetic = report.pages.map((page, index): NotionImportPageReport => {
    if (!page || page.ordinal !== index + 1 || !ACTIONS.includes(page.action) ||
        !["zh-CN", "zh-TW", "en", ""].includes(page.locale) ||
        (page.articleId !== null && !validNotionJobId(page.articleId)) ||
        !Array.isArray(page.issueCodes) || page.issueCodes.length > ISSUE_CODES.size ||
        page.issueCodes.some(code => !ISSUE_CODES.has(code))) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    return { externalId: "", title: "", slug: "", detail: "", action: page.action, locale: page.locale,
      articleId: page.articleId, issues: page.issueCodes.map(code => ({ code: code as InterchangeIssueCode, detail: "" })) };
  });
  const normalized = safeNotionJobReport(synthetic);
  if (!report.summary || ACTIONS.some(action => report.summary[action] !== normalized.summary[action])) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > NOTION_JOB_MAX_REPORT_BYTES) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  return json;
}
export function decodeNotionJobReport(value: unknown): SafeNotionJobReport | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > NOTION_JOB_MAX_REPORT_BYTES) throw new Error();
    const report = JSON.parse(value) as SafeNotionJobReport;
    return JSON.parse(encodeNotionJobReport(report)) as SafeNotionJobReport;
  } catch { throw new Error("Stored import job status is invalid."); }
}
export function notionJobReportSucceeded(report: SafeNotionJobReport, total: number): boolean {
  encodeNotionJobReport(report);
  return report.pages.length === total && report.summary.failed === 0 && report.summary.refused === 0 &&
    !report.pages.some(page => page.issueCodes.includes("image-copy-failed"));
}
export function encodeNotionJobInput(input: EnqueueNotionJob): string {
  assertNotionJobOwner(input.ownerId);
  if (!validNotionJobId(input.id) || !HASH.test(input.requestKeyHash) || !HASH.test(input.fingerprint) ||
      !Number.isSafeInteger(input.total) || input.total < 0 || input.total > 200 || !Number.isSafeInteger(input.expiresAt)) {
    throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  }
  if (!validNotionJobKeyId(input.payload?.keyId)) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  const projected: Partial<NotionJobPayload> = { keyId: input.payload.keyId };
  for (const [kind, envelope] of [["bundle", input.payload?.bundle], ["plan", input.payload?.plan]] as const) {
    if (!envelope || envelope.version !== 1 || envelope.ownerId !== input.ownerId || envelope.expiresAt !== input.expiresAt ||
        envelope.jobId !== `${input.id}:${kind}:${input.payload.keyId}` ||
        typeof envelope.nonce !== "string" || envelope.nonce.length !== 16 ||
        typeof envelope.tag !== "string" || envelope.tag.length !== 24 || typeof envelope.ciphertext !== "string") {
      throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    }
    for (const [value, maximum] of [[envelope.nonce, 16], [envelope.tag, 24], [envelope.ciphertext, NOTION_JOB_MAX_STORED_BYTES]] as const) {
      if (value.length > maximum || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || Buffer.from(value, "base64").toString("base64") !== value) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    }
    projected[kind] = { jobId: envelope.jobId, ownerId: envelope.ownerId, expiresAt: envelope.expiresAt,
      version: 1, nonce: envelope.nonce, tag: envelope.tag, ciphertext: envelope.ciphertext };
  }
  const json = JSON.stringify(projected);
  if (Buffer.byteLength(json) > NOTION_JOB_MAX_STORED_BYTES) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  return json;
}
export function assertNotionJobCapacity(input: { ownerActive: number; globalActive: number; ownerRows: number; globalRows: number; ownerBytes: number; globalBytes: number }, addedBytes: number): void {
  if (input.ownerActive >= NOTION_JOB_OWNER_ACTIVE_LIMIT || input.globalActive >= NOTION_JOB_GLOBAL_ACTIVE_LIMIT ||
      input.ownerRows >= NOTION_JOB_OWNER_ROW_LIMIT || input.globalRows >= NOTION_JOB_GLOBAL_ROW_LIMIT ||
      input.ownerBytes + addedBytes > NOTION_JOB_OWNER_BYTE_LIMIT || input.globalBytes + addedBytes > NOTION_JOB_GLOBAL_BYTE_LIMIT) {
    throw new NotionJobError("IMPORT_QUEUE_FULL");
  }
}

/** Iterative traversal bounds canonical hashing and rejects credential metadata before persistence. */
export function assertNotionJobContent(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++visited > 1_000_000 || next.depth > 64) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    if (next.value === null || typeof next.value !== "object") continue;
    for (const [key, child] of Object.entries(next.value)) {
      if (/^(?:notion[-_]?token|access[-_]?token|refresh[-_]?token|authorization|api[-_]?key|password|secret|token)$/i.test(key)) {
        throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
      }
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

type JobRow = Record<string, unknown>;
function statusInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") throw new Error("Stored import job status is invalid.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum ||
      typeof value === "string" && value !== String(number)) throw new Error("Stored import job status is invalid.");
  return number;
}
export function notionJobStatus(row: JobRow): NotionJobStatus {
  const report = decodeNotionJobReport(row.report);
  const state = row.state as NotionJobState;
  if (!(NOTION_JOB_STATES as readonly unknown[]).includes(state) || !validNotionJobId(row.id)) throw new Error("Stored import job status is invalid.");
  const total = statusInteger(row.total, 200), completed = statusInteger(row.completed, total);
  const createdAt = statusInteger(row.created_at), updatedAt = statusInteger(row.updated_at);
  const expiresAt = statusInteger(row.expires_at), retainUntil = statusInteger(row.retain_until);
  if (!expiresAt || !retainUntil || (report?.pages.length ?? 0) !== completed || state === "queued" && completed !== 0 ||
      state === "succeeded" && (!report || !notionJobReportSucceeded(report, total))) throw new Error("Stored import job status is invalid.");
  return {
    id: row.id, state, completed, total, createdAt, updatedAt, expiresAt, retainUntil,
    report, recovery: state === "queued" || state === "running" || state === "succeeded" ? "none" :
      state === "expired" ? "preview-again" : "review-media-and-preview",
  };
}
export function claimedNotionJob(row: JobRow): ClaimedNotionJob {
  if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > NOTION_JOB_MAX_STORED_BYTES || !validNotionJobId(row.lease_token)) {
    throw new Error("Stored import job input is invalid.");
  }
  return { status: notionJobStatus(row), fence: { jobId: String(row.id), ownerId: String(row.owner_id), leaseToken: row.lease_token },
    // Parse only AFTER the claim commits: malformed ciphertext must fail once, not poison the queue head.
    payload: row.payload };
}

export type NotionJobBacklog = {
  states: Record<NotionJobState, number>; inputBytes: number; oldestQueuedAgeMs: number;
  overdueInputs: number; overdueLeases: number; overdueStatuses: number;
};
/** A bounded operational snapshot, deliberately containing no account/job/source identifiers. */
export function notionJobBacklog(rows: readonly Record<string, unknown>[], now: number): NotionJobBacklog {
  if (!Number.isSafeInteger(now) || now < 0 || rows.length > NOTION_JOB_GLOBAL_ROW_LIMIT) throw new Error("Invalid import job backlog.");
  const states: NotionJobBacklog["states"] = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, expired: 0 };
  let inputBytes = 0, oldestQueuedAgeMs = 0, overdueInputs = 0, overdueLeases = 0, overdueStatuses = 0;
  for (const row of rows) {
    const state = row.state as NotionJobState;
    if (!(NOTION_JOB_STATES as readonly unknown[]).includes(state)) throw new Error("Invalid import job backlog.");
    const bytes = Number(row.stored_bytes), created = Number(row.created_at), expires = Number(row.expires_at), retain = Number(row.retain_until);
    if (![bytes, created, expires, retain].every(value => Number.isSafeInteger(value) && value >= 0) || bytes > NOTION_JOB_MAX_STORED_BYTES) throw new Error("Invalid import job backlog.");
    states[state] += 1;
    inputBytes += bytes;
    const active = state === "queued" || state === "running";
    if (state === "queued") oldestQueuedAgeMs = Math.max(oldestQueuedAgeMs, now - created);
    if (active && expires <= now) overdueInputs += 1;
    if (state === "running") {
      const lease = Number(row.lease_expires_at);
      if (!Number.isSafeInteger(lease) || lease <= 0) throw new Error("Invalid import job backlog.");
      if (lease <= now) overdueLeases += 1;
    }
    if (!active && retain <= now) overdueStatuses += 1;
  }
  return { states, inputBytes, oldestQueuedAgeMs, overdueInputs, overdueLeases, overdueStatuses };
}

/** Reports are append-only acknowledgements; a heartbeat may not rewrite earlier outcomes. */
export function assertNotionJobProgress(row: Record<string, unknown>, next: SafeNotionJobReport): void {
  const prior = decodeNotionJobReport(row.report);
  if (next.pages.length < Number(row.completed) || next.pages.length > Number(row.total) ||
      (prior && JSON.stringify(next.pages.slice(0, prior.pages.length)) !== JSON.stringify(prior.pages))) {
    throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
  }
}
