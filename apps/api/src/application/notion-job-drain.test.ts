import assert from "node:assert/strict";
import test from "node:test";
import { createSqlitePersistence } from "../persistence/sqlite-store.ts";
import { runNotionJobDrain } from "./notion-job-drain.ts";
import { notionDrainSettings, notionJobSettings } from "../infrastructure/notion-job-settings.ts";
import { createNotionJobService } from "./notion-job-service.ts";
import { importNotionBundle } from "./notion-import.ts";
import { createApplicationServices } from "./services.ts";
import { parseNotionJobCommand } from "../persistence/notion-job-command.ts";
import { notionJobBacklog, safeNotionJobReport, encodeNotionJobReport } from "./notion-durable-jobs.ts";
import { randomUUID } from "node:crypto";

const env = { AUTH_JWT_SECRET: "drain-unit-tests-only-secret-of-sufficient-length", AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api", NOTION_IMPORT_JOBS_ENABLED: "true", NOTION_IMPORT_JOB_KEY: Buffer.alloc(32, 8).toString("base64") };
async function queued(t: import("node:test").TestContext) {
  const runtime = await createSqlitePersistence({ filename: ":memory:" });
  t.after(runtime.close);
  const store = runtime.adapter, deps = createApplicationServices({ persistence: store, env });
  const jobs = createNotionJobService({ store, deps, env })!;
  const bundle = { version: 1, pages: [{ id: randomUUID(), properties: { Page: { type: "title", title: [{ type: "text", plain_text: "Drain work", text: { content: "Drain work" } }] } },
    blocks: [{ id: "p", type: "paragraph", paragraph: { rich_text: [{ plain_text: "A body for the job" }] } }] }] };
  const dry = await importNotionBundle({ actorId: "drain-author", bundle, apply: false, deps });
  const job = await jobs.start({ actorId: "drain-author", bundle, planToken: dry.planToken, idempotencyKey: randomUUID() });
  return { store, deps, jobs, job };
}
test("drain settings and CLI validate before acquiring resources; inspect/sweep do not need a key", () => {
  assert.deepEqual(notionDrainSettings({}), { maxJobs: 1, deadlineMs: 300000 });
  for (const value of ["", "0", "11", "01", "1.2", "NaN"]) assert.throws(() => notionDrainSettings({ NOTION_IMPORT_DRAIN_MAX_JOBS: value }), RangeError);
  assert.equal(notionJobSettings({}), null);
  assert.equal(notionJobSettings({ NOTION_IMPORT_JOBS_ENABLED: "false", NOTION_IMPORT_JOB_KEY: "ignored-disabled-key" }), null);
  assert.throws(() => notionJobSettings({ NOTION_IMPORT_JOBS_ENABLED: "true", NOTION_IMPORT_JOB_KEY: "do-not-echo-this" }), error => !String(error).includes("do-not-echo-this"));
  assert.deepEqual(parseNotionJobCommand(["inspect"]), { command: "inspect" });
  assert.deepEqual(parseNotionJobCommand(["sweep"]), { command: "sweep" });
  assert.deepEqual(parseNotionJobCommand([]), { command: "drain" });
  for (const args of [["restart"], ["drain", "--force"], ["inspect", "extra"]]) assert.throws(() => parseNotionJobCommand(args));
});
test("finite drain distinguishes a job cap, an empty queue and cancellation", async t => {
  const f = await queued(t);
  const result = await runNotionJobDrain({ ...f, maxJobs: 1, deadlineMs: 1000 });
  assert.equal(result.claimed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.stopReason, "job-limit");
  assert.equal((await f.store.notionImportJobBacklog()).states.succeeded, 1);
  const empty = await runNotionJobDrain({ ...f, maxJobs: 2, deadlineMs: 1000 });
  assert.equal(empty.stopReason, "empty");
  assert.equal(empty.claimed, 0);
  const controller = new AbortController(); controller.abort(new Error("private reason"));
  const cancelled = await runNotionJobDrain({ ...f, signal: controller.signal });
  assert.equal(cancelled.stopReason, "aborted");
  assert.doesNotMatch(JSON.stringify(cancelled), /private reason/);
});
test("a physical in-flight worker settles before drain returns and closes its resource", { timeout: 10000 }, async t => {
  const f = await queued(t);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const blocked = { ...f.deps, commitNotionImportWork: async (input: Parameters<typeof f.deps.commitNotionImportWork>[0]) => {
    if (input.editions.length) { began(); await held; }
    return f.deps.commitNotionImportWork(input);
  } };
  let returned = false;
  const work = runNotionJobDrain({ ...f, deps: blocked, signal: controller.signal, deadlineMs: 10000 }).then(result => { returned = true; return result; });
  await Promise.race([started, work.then(() => { throw new Error("The worker returned without reaching the held write."); })]);
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false, "a cancellation is not physical completion");
  release();
  const result = await work;
  assert.equal(result.stopReason, "aborted");
  assert.equal((await f.store.getMyNotionImportJob({ actorId: "drain-author", jobId: f.job.id }))?.state, "interrupted");
});
test("backlog reports only bounded aggregate facts, including overdue leases/input and retention", () => {
  const rows = [
    { state: "queued", stored_bytes: 20, created_at: 100, expires_at: 2000, retain_until: 3000, lease_expires_at: null },
    { state: "running", stored_bytes: 30, created_at: 100, expires_at: 1000, retain_until: 3000, lease_expires_at: 500 },
    { state: "failed", stored_bytes: 0, created_at: 100, expires_at: 500, retain_until: 900, lease_expires_at: null },
  ];
  const result = notionJobBacklog(rows, 1000);
  assert.equal(result.states.queued, 1);
  assert.equal(result.states.running, 1);
  assert.equal(result.inputBytes, 50);
  assert.equal(result.oldestQueuedAgeMs, 900);
  assert.equal(result.overdueInputs, 1);
  assert.equal(result.overdueLeases, 1);
  assert.equal(result.overdueStatuses, 1);
  assert.throws(() => notionJobBacklog([{ ...rows[0], state: "https://signed-secret" }], 1000));
});
test("safe reports strip source secrets and reject forged summary and secret-bearing issue codes", () => {
  const report = safeNotionJobReport([{ externalId: "private source", title: "signed secret", slug: "not-carried", detail: "not-carried",
    locale: "en", action: "failed", articleId: null, issues: [{ code: "image-copy-failed", detail: "https://secret?credential=value" }] }]);
  assert.doesNotMatch(encodeNotionJobReport(report), /private source|signed secret|not-carried|credential|https/);
  assert.throws(() => encodeNotionJobReport({ ...report, summary: { ...report.summary, create: 1 } }));
  assert.throws(() => encodeNotionJobReport({ ...report, pages: [{ ...report.pages[0], issueCodes: ["https://signed-secret"] }] }));
});

test("a delayed physical write may settle after a drain deadline, but cannot commit new works after it", { timeout: 10000 }, async t => {
  const f = await queued(t);
  const deps = { ...f.deps, commitNotionImportWork: async (input: Parameters<typeof f.deps.commitNotionImportWork>[0]) => {
    if (input.editions.length) await new Promise(resolve => setTimeout(resolve, 1200));
    return f.deps.commitNotionImportWork(input);
  } };
  const result = await runNotionJobDrain({ ...f, deps, deadlineMs: 1000 });
  assert.equal(result.stopReason, "deadline");
  assert.equal((await f.store.listMyArticles({ actorId: "drain-author", locale: "en" })).length, 0, "the English fixture would be an `en` edition");
  assert.equal((await f.store.getMyNotionImportJob({ actorId: "drain-author", jobId: f.job.id }))?.state, "interrupted");
});
