import { performance } from "node:perf_hooks";
import { MAX_NOTION_JOB_PAYLOAD_BYTES } from "./notion-import-job-payload.ts";
import { parseNotionBundle } from "./notion-bundle.ts";
import { assertNotionImportPlan, MAX_NOTION_PLAN_TOKEN_BYTES, notionBundleHash } from "./notion-import-plan.ts";
import { assertNotionJobContent, assertNotionJobOwner, NOTION_JOB_GLOBAL_ACTIVE_LIMIT, NOTION_JOB_MAX_STORED_BYTES,
  notionJobHash, validNotionJobId, validNotionJobKeyId,
  type NotionJobInputSnapshot, type NotionJobPayload, type NotionJobsPersistencePort } from "./notion-durable-jobs.ts";
import type { NotionImportDeps } from "./notion-import.ts";
import type { createNotionJobKeyring } from "../infrastructure/notion-job-keys.ts";

type Keyring = ReturnType<typeof createNotionJobKeyring>;
type Condition = "ready" | "expired" | "unreadable" | "invalidInput" | "stalePlan";
type KeyUse = "active" | "previous" | "unknown";
type CheckedInput = { condition: Condition; key: KeyUse };
export type NotionJobCheckResult = {
  checked: number; inputs: Record<Condition, number>; keys: Record<KeyUse, number>;
  stopReason: "complete" | "input-limit" | "deadline" | "aborted" | "generation-changed";
  durationMs: number;
};

/** No return value can contain a source field, identity, key id, token or raw diagnostic. */
function checkInput(row: NotionJobInputSnapshot, keyring: Keyring, deps: NotionImportDeps, generation: string): CheckedInput {
  let key: KeyUse = "unknown";
  const outcome = (condition: Condition): CheckedInput => ({ condition, key });
  if (row.expiresAt <= Date.now()) return outcome("expired");
  let payload: NotionJobPayload;
  try {
    assertNotionJobOwner(row.ownerId);
    if (!validNotionJobId(row.id) || !Number.isSafeInteger(row.total) || row.total < 0 || row.total > 200 ||
        !Number.isSafeInteger(row.expiresAt) || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
        typeof row.payload !== "string" || Buffer.byteLength(row.payload) > NOTION_JOB_MAX_STORED_BYTES) return outcome("invalidInput");
    payload = JSON.parse(row.payload) as NotionJobPayload;
    if (!payload || !validNotionJobKeyId(payload.keyId)) return outcome("invalidInput");
    key = payload.keyId === keyring.activeId ? "active" : "previous";
  } catch { return outcome("invalidInput"); }
  let opened: { bundle: Buffer; plan: Buffer };
  try { opened = keyring.open(payload, { jobId: row.id, ownerId: row.ownerId, expiresAt: row.expiresAt }, Date.now()); }
  catch { return { condition: "unreadable", key: "unknown" }; }
  try {
    if (opened.bundle.length > MAX_NOTION_JOB_PAYLOAD_BYTES || opened.plan.length > MAX_NOTION_PLAN_TOKEN_BYTES) return outcome("invalidInput");
    let bundle: unknown, planToken: string;
    try {
      const decode = new TextDecoder("utf-8", { fatal: true });
      bundle = JSON.parse(decode.decode(opened.bundle)) as unknown;
      planToken = decode.decode(opened.plan);
      assertNotionJobContent(bundle);
      const parsed = parseNotionBundle(bundle);
      if (parsed.pages.length !== row.total) return outcome("invalidInput");
    } catch { return outcome("invalidInput"); }
    try {
      const plan = deps.verifyNotionImportPlan(planToken);
      assertNotionImportPlan(plan, { actorId: row.ownerId, bundleHash: notionBundleHash(bundle), generation, now: Date.now() });
      if (plan.expiresAt !== row.expiresAt || notionJobHash(JSON.stringify([plan.bundleHash, planToken])) !== row.fingerprint) return outcome("invalidInput");
      return outcome("ready");
    } catch { return outcome(row.expiresAt <= Date.now() ? "expired" : "stalePlan"); }
  } finally { opened.bundle.fill(0); opened.plan.fill(0); }
}

/**
 * Read-only, finite key/restore preflight. It does not claim, sweep, renew, repair,
 * refresh an expiring source URL, or certify that a later article write will pass.
 * Quiesce API submissions and drain processes for an authoritative rotation check.
 */
export async function runNotionJobCheck({ store, deps, keyring, maxInputs = NOTION_JOB_GLOBAL_ACTIVE_LIMIT, deadlineMs = 30_000, signal }: {
  store: NotionJobsPersistencePort; deps: NotionImportDeps; keyring: Keyring;
  maxInputs?: number; deadlineMs?: number; signal?: AbortSignal;
}): Promise<NotionJobCheckResult> {
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > NOTION_JOB_GLOBAL_ACTIVE_LIMIT ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 300_000) throw new RangeError("Invalid Notion input check bounds.");
  const started = performance.now();
  const result: NotionJobCheckResult = { checked: 0,
    inputs: { ready: 0, expired: 0, unreadable: 0, invalidInput: 0, stalePlan: 0 },
    keys: { active: 0, previous: 0, unknown: 0 }, stopReason: "complete", durationMs: 0 };
  function stopped(): boolean {
    if (signal?.aborted) { result.stopReason = "aborted"; return true; }
    if (performance.now() - started >= deadlineMs) { result.stopReason = "deadline"; return true; }
    return false;
  }
  if (!stopped()) {
    const generation = await deps.getImportPlanGeneration();
    let afterId: string | undefined;
    while (!stopped()) {
      // One bounded row, not a buffer containing the entire encrypted queue.
      const row = await store.readNextNotionImportJobInput({ afterId });
      if (stopped()) break;
      if (!row) break;
      if (!validNotionJobId(row.id) || afterId !== undefined && row.id <= afterId) throw new Error("Import input check received an invalid cursor.");
      if (result.checked === maxInputs) { result.stopReason = "input-limit"; break; }
      const checked = checkInput(row, keyring, deps, generation);
      result.inputs[checked.condition] += 1;
      result.keys[checked.key] += 1;
      result.checked += 1;
      afterId = row.id;
    }
    // A restore/transfer between reads must not produce a misleading success.
    if (!stopped() && await deps.getImportPlanGeneration() !== generation) result.stopReason = "generation-changed";
    stopped();
  }
  result.durationMs = Math.max(0, Math.round(performance.now() - started));
  return result;
}
