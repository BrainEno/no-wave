import { runNotionJobCheck } from "../application/notion-job-check.ts";
import { createNotionJobKeyring } from "../infrastructure/notion-job-keys.ts";
import { transferProviderData, ProviderTransferError } from "./provider-migration-transfer.ts";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplicationServices } from "../application/services.ts";
import { importNotionBundle } from "../application/notion-import.ts";
import { createNotionJobService, executeNextNotionJob } from "../application/notion-job-service.ts";
import { NotionJobError, NOTION_JOB_LEASE_MS } from "../application/notion-durable-jobs.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createPostgresStore } from "./postgres.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";
import { createApiServer, shutdownApiServer } from "../server.ts";

const env = {
  AUTH_JWT_SECRET: "durable-job-test-only-secret-more-than-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test", AUTH_JWT_AUDIENCE: "bot-thk-api",
  NOTION_IMPORT_JOBS_ENABLED: "true", NOTION_IMPORT_JOB_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const rich = (plain_text: string) => ({ type: "text", plain_text, text: { content: plain_text } });
function source(label = "Durable input", images = 0) {
  return { version: 1, database: { id: "durable-test" }, pages: [{ id: randomUUID(), properties: {
    Page: { type: "title", title: [rich(label)] }, Published: { type: "checkbox", checkbox: true },
  }, blocks: [{ id: "p", type: "paragraph", paragraph: { rich_text: [rich("A safe manuscript")] } },
    ...Array.from({ length: images }, (_, index) => ({ id: `image-${index}`, type: "image", image: {
      type: "file", file: { url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/object-${index}?X-Amz-Signature=never-disclose-this` },
    } })),
  ] }] };
}
function token(sub: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" })}.${encode({ sub,
    iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, sid: `durable-${sub}`, jti: randomUUID(),
  })}`;
  return `${body}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(body).digest("base64url")}`;
}
async function fixture(t: import("node:test").TestContext, provider: "sqlite" | "postgres", file?: string) {
  const db = provider === "sqlite" ? createSqliteClient({ filename: file ?? ":memory:" }) : null;
  if (db) await runSqliteMigrations(db);
  const pg = provider === "postgres" ? await createIsolatedPostgresTestSchema(process.env.TEST_DATABASE_URL!) : null;
  const store = db ? createSqliteStore(db) : createPostgresStore(pg!.sql);
  const deps = createApplicationServices({ persistence: store, env });
  const jobs = createNotionJobService({ store, deps, env })!;
  const actorId = randomUUID();
  t.after(async () => { db?.close(); await pg?.cleanup(); });
  const enqueue = async (bundle = source(), key = randomUUID()) => {
    const dry = await importNotionBundle({ actorId, bundle, apply: false, deps });
    return jobs.start({ actorId, bundle, planToken: dry.planToken, idempotencyKey: key });
  };
  async function query(sql: string, values: unknown[] = []) {
    if (db) return db.prepare(sql).all(...values);
    let index = 0;
    return pg!.sql.unsafe(sql.replaceAll("?", () => `$${++index}`), values);
  }
  return { db, sql: pg?.sql, store, deps, jobs, actorId, enqueue, query };
}
for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for the identical durable Notion job contract." };
  test(`${provider}: encrypted input survives enqueue, idempotent retry and a separately acquired worker`, options, async t => {
    const f = await fixture(t, provider);
    const bundle = source("Keep this title private", 1);
    const dry = await importNotionBundle({ actorId: f.actorId, bundle, apply: false, deps: f.deps });
    const args = { actorId: f.actorId, bundle, planToken: dry.planToken, idempotencyKey: randomUUID() };
    const first = await f.jobs.start(args);
    assert.deepEqual(await f.jobs.start(args), first);
    const otherBundle = source();
    const otherDry = await importNotionBundle({ actorId: f.actorId, bundle: otherBundle, apply: false, deps: f.deps });
    await assert.rejects(f.jobs.start({ ...args, bundle: otherBundle, planToken: otherDry.planToken }),
      (error: unknown) => error instanceof NotionJobError && error.code === "IMPORT_JOB_IDEMPOTENCY_CONFLICT");
    const rows = await f.query("SELECT * FROM notion_import_jobs");
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /Keep this title private|never-disclose-this|X-Amz-Signature/);
    assert.equal(await f.store.getMyNotionImportJob({ actorId: "another-owner", jobId: first.id }), null);
    const worker = createNotionJobService({ store: f.store, deps: f.deps, env })!;
    const done = await executeNextNotionJob({ jobs: worker, store: f.store, deps: f.deps,
      copyImage: async () => ({ ok: false, reason: "private upstream diagnostic never-disclose-this" }),
    });
    assert.equal(done, true);
    const status = (await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: first.id }))!;
    assert.equal(status.state, "failed", "an omitted image cannot be called successful");
    assert.equal(status.completed, 1);
    assert.equal(status.report?.summary.create, 1);
    assert.equal(status.report?.pages[0]?.issueCodes.includes("image-copy-failed"), true);
    assert.doesNotMatch(JSON.stringify(status), /Keep this title private|never-disclose-this|X-Amz|leaseToken|ownerId|planToken/);
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs"))[0].payload, null);
    assert.equal((await f.store.listMyArticles({ actorId: f.actorId })).length, 1);
    assert.equal(await executeNextNotionJob({ jobs: worker, store: f.store, deps: f.deps }), false);
  });
  test(`${provider}: a malformed encrypted input is failed once and discarded rather than poisoning the queue head`, options, async t => {
    const f = await fixture(t, provider);
    const bad = await f.enqueue();
    const good = await f.enqueue();
    // Still satisfies the physical byte constraint, but is not a JSON envelope.
    await f.query("UPDATE notion_import_jobs SET payload = ?, stored_bytes = ? WHERE id = ?", ["malformed", 9, bad.id]);
    await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps });
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: bad.id }))?.state, "failed");
    await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps });
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: good.id }))?.state, "succeeded");
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs WHERE id = ?", [bad.id]))[0].payload, null);
    assert.equal((await f.store.listMyArticles({ actorId: f.actorId })).length, 1);
  });
  test(`${provider}: one queued job is claimed once, and cancellation fences article writes`, options, async t => {
    const f = await fixture(t, provider);
    const job = await f.enqueue();
    const claims = await Promise.all(Array.from({ length: 4 }, () => f.store.claimNotionImportJob()));
    const [claim] = claims.filter(Boolean);
    assert.ok(claim);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await f.store.cancelNotionImportJob({ actorId: "other", jobId: job.id }), null);
    assert.equal((await f.store.cancelNotionImportJob({ actorId: f.actorId, jobId: job.id }))?.state, "cancelled");
    const input = f.jobs.open(claim);
    await assert.rejects(importNotionBundle({ actorId: f.actorId, ...input, apply: true, deps: f.deps,
      beforeWork: async () => { throw new Error("cancelled worker must stop"); },
    }));
    const plan = f.deps.verifyNotionImportPlan(input.planToken);
    await assert.rejects(async () => f.deps.commitNotionImportWork({ actorId: f.actorId, generation: plan.generation,
      expiresAt: plan.expiresAt, expected: plan.works[0], editions: [], jobFence: claim.fence,
    }), NotionJobError);
    assert.equal(await f.store.heartbeatNotionImportJob({ fence: claim.fence }), false);
    assert.equal(await f.store.finishNotionImportJob({ fence: claim.fence, state: "succeeded" }), false);
    assert.equal((await f.store.listMyArticles({ actorId: f.actorId })).length, 0);
  });
  test(`${provider}: expired running jobs are interrupted, never replayed or renewed`, options, async t => {
    const f = await fixture(t, provider);
    const job = await f.enqueue();
    const claim = (await f.store.claimNotionImportJob())!;
    assert.ok(claim.fence.leaseToken);
    assert.equal(await f.store.heartbeatNotionImportJob({ fence: claim.fence }), true);
    await f.query("UPDATE notion_import_jobs SET lease_expires_at = ? WHERE id = ?", [Date.now() - NOTION_JOB_LEASE_MS, job.id]);
    assert.equal(await f.store.heartbeatNotionImportJob({ fence: claim.fence }), false);
    assert.equal(await f.store.claimNotionImportJob(), null);
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: job.id }))?.state, "interrupted");
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs"))[0].payload, null);
    assert.equal((await f.store.listMyArticles({ actorId: f.actorId })).length, 0);
  });
  test(`${provider}: bounded queues, expired input and retained-status deletion are enforced by the database adapter`, options, async t => {
    const f = await fixture(t, provider);
    const first = await f.enqueue();
    await f.enqueue();
    await assert.rejects(f.enqueue(), (error: unknown) => error instanceof NotionJobError && error.code === "IMPORT_QUEUE_FULL");
    await f.query("UPDATE notion_import_jobs SET expires_at = ? WHERE id = ?", [Date.now() - 1, first.id]);
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: first.id }))?.state, "expired");
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs WHERE id = ?", [first.id]))[0].payload, null);
    await f.enqueue();
    await f.query("UPDATE notion_import_jobs SET retain_until = ? WHERE id = ?", [Date.now() - 1, first.id]);
    await f.store.sweepNotionImportJobs();
    assert.equal(await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: first.id }), null);
  });
  test(`${provider}: cancellation during media preparation prevents commit, with no automatic mutation retry`, options, async t => {
    const f = await fixture(t, provider);
    const job = await f.enqueue(source("Cancel during download", 1));
    let copied = 0;
    await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps, copyImage: async () => {
      copied += 1;
      await f.store.cancelNotionImportJob({ actorId: f.actorId, jobId: job.id });
      return { ok: false, reason: "cancelled" };
    } });
    assert.equal(copied, 1);
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: job.id }))?.state, "cancelled");
    assert.equal((await f.store.listMyArticles({ actorId: f.actorId })).length, 0);
    assert.equal(await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps }), false);
  });
  test(`${provider}: provider transfer refuses active local jobs but never copies ciphertext or terminal status`, options, async t => {
    const f = await fixture(t, provider), target = await fixture(t, "sqlite");
    const job = await f.enqueue();
    const endpoints = { source: f.db ? { provider: "sqlite" as const, db: f.db } : { provider: "postgres" as const, sql: f.sql! },
      target: { provider: "sqlite" as const, db: target.db! } };
    await assert.rejects(transferProviderData({ ...endpoints, dryRun: true }),
      (error: unknown) => error instanceof ProviderTransferError && error.code === "ACTIVE_IMPORT_JOBS");
    await f.store.cancelNotionImportJob({ actorId: f.actorId, jobId: job.id });
    const report = await transferProviderData(endpoints);
    assert.ok(report.ok);
    assert.equal(report.tables.some(table => table.table === "notion_import_jobs"), false);
    assert.equal((await target.query("SELECT id FROM notion_import_jobs")).length, 0);
    await target.enqueue();
    await assert.rejects(transferProviderData({ ...endpoints, dryRun: true }),
      (error: unknown) => error instanceof ProviderTransferError && error.code === "ACTIVE_IMPORT_JOBS");
    await assert.rejects(transferProviderData(endpoints),
      (error: unknown) => error instanceof ProviderTransferError && error.code === "ACTIVE_IMPORT_JOBS");
  });
  test(`${provider}: losing a lease inside a work rolls back article, tags, provenance and checkpoint together`, options, async t => {
    const f = await fixture(t, provider);
    const bundle = source();
    bundle.pages[0].properties.Tags = { type: "multi_select", multi_select: [{ name: "Must rollback" }] };
    const job = await f.enqueue(bundle);
    if (f.db) f.db.exec(`CREATE TRIGGER expire_job_in_article AFTER INSERT ON articles BEGIN
      UPDATE notion_import_jobs SET lease_expires_at = 1 WHERE state = 'running'; END`);
    else await f.sql!.unsafe(`CREATE FUNCTION expire_job_in_article() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE notion_import_jobs SET lease_expires_at = 1 WHERE state = 'running'; RETURN NEW; END $$;
      CREATE TRIGGER expire_job_in_article AFTER INSERT ON articles FOR EACH ROW EXECUTE FUNCTION expire_job_in_article()`);
    await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps });
    assert.equal((await f.query("SELECT id FROM articles")).length, 0);
    assert.equal((await f.query("SELECT id FROM taxonomies")).length, 0);
    assert.equal((await f.query("SELECT article_id FROM external_content_links")).length, 0);
    const status = (await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: job.id }))!;
    assert.equal(status.state, "failed");
    assert.equal(status.report?.summary.create, 0);
    assert.equal(status.report?.summary.failed, 1);
  });
  test(`${provider}: API shutdown drains a disconnected physical job read before closing persistence`, options, async t => {
    const f = await fixture(t, provider), job = await f.enqueue();
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let closed = false;
    const server = createApiServer({ env, logger: () => {}, store: { ...f.store,
      async getMyNotionImportJob(input) { enter(); await held; return f.store.getMyNotionImportJob(input); },
    } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { release(); server.closeAllConnections(); server.close(); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/api/v1/imports/notion/jobs/${job.id}`, {
      headers: { authorization: `Bearer ${token(f.actorId)}` }, signal: controller.signal,
    });
    const rejected = assert.rejects(request, { name: "AbortError" });
    try {
      await started;
      controller.abort(); await rejected;
      const stop = shutdownApiServer(server, { closePersistence: () => { closed = true; } });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(closed, false, "the HTTP socket cannot release the database's physical owner");
      release();
      const result = await stop;
      assert.equal(closed, true);
      assert.equal(result.forced, false);
      assert.equal(result.exitCode, 0);
    } finally { release(); controller.abort(); await rejected; }
  });
  test(`${provider}: authenticated conditional polling is private, waits for change, and never exposes a foreign ETag`, options, async t => {
    const f = await fixture(t, provider), job = await f.enqueue();
    const server = createApiServer({ store: f.store, env, logger: () => {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/v1/imports/notion/jobs/${job.id}`;
    const headers = { authorization: `Bearer ${token(f.actorId)}` };
    const initial = await fetch(url, { headers });
    assert.equal(initial.status, 200);
    const etag = initial.headers.get("etag")!;
    assert.match(etag, /^"[A-Za-z0-9_-]{43}"$/);
    await initial.arrayBuffer();
    const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get("cache-control"), "no-store");
    assert.equal(unchanged.headers.get("retry-after"), "2");
    assert.equal(await unchanged.text(), "");
    const waiting = fetch(url, { headers: { ...headers, "if-none-match": etag, prefer: "wait=5" } });
    await new Promise(resolve => setTimeout(resolve, 30));
    await f.store.cancelNotionImportJob({ actorId: f.actorId, jobId: job.id });
    const changed = await waiting;
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.equal((await changed.json()).data.state, "cancelled");
    const foreign = await fetch(url, { headers: { authorization: `Bearer ${token("foreign-owner")}`, "if-none-match": etag } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.headers.get("etag"), null);
    await foreign.arrayBuffer();
  });
  test(`${provider}: a lost admission response can be recovered by its original owner/key after preview expiry and admission shutdown`, options, async t => {
    const f = await fixture(t, provider), key = randomUUID();
    const job = await f.enqueue(source(), key);
    await f.query("UPDATE notion_import_jobs SET expires_at = ? WHERE id = ?", [Date.now() - 1, job.id]);
    const server = createApiServer({ store: f.store, env: { ...env, NOTION_IMPORT_JOBS_ENABLED: "false", NOTION_IMPORT_JOB_KEY: undefined }, logger: () => {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1/imports/notion/jobs`;
    const lookup = async (actorId: string, requestKey: string, query = "") => {
      const response = await fetch(base + query, { headers: { authorization: `Bearer ${token(actorId)}`, "idempotency-key": requestKey } });
      return { status: response.status, data: (await response.json()).data };
    };
    const found = await lookup(f.actorId, key);
    assert.equal(found.status, 200);
    assert.deepEqual(found.data.map(item => [item.id, item.state]), [[job.id, "expired"]]);
    assert.deepEqual((await lookup("another-owner", key)).data, []);
    assert.deepEqual((await lookup(f.actorId, randomUUID())).data, []);
    assert.equal((await lookup(f.actorId, key, "?limit=20")).status, 400);
    assert.equal((await lookup(f.actorId, "bad key")).status, 400);
    assert.equal(Number((await f.query("SELECT count(*) AS n FROM notion_import_jobs"))[0].n), 1);
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs"))[0].payload, null);
    assert.doesNotMatch(JSON.stringify(found), /request_key|fingerprint|payload|ownerId/);
  });
  test(`${provider}: read-only input check qualifies a staged key change and refuses stale signing/generation without claiming work`, options, async t => {
    const f = await fixture(t, provider);
    await f.enqueue(source("never-output-private-input"));
    const before = await f.query("SELECT * FROM notion_import_jobs");
    const rotated = createNotionJobKeyring({ NOTION_IMPORT_JOB_KEYS: `primary:${env.NOTION_IMPORT_JOB_KEY},next:${randomBytes(32).toString("base64")}`,
      NOTION_IMPORT_JOB_ACTIVE_KEY: "next" });
    const valid = await runNotionJobCheck({ store: f.store, deps: f.deps, keyring: rotated });
    assert.equal(valid.stopReason, "complete");
    assert.equal(valid.checked, 1);
    assert.equal(valid.inputs.ready, 1);
    assert.equal(valid.keys.previous, 1);
    assert.doesNotMatch(JSON.stringify(valid), /never-output-private-input|ownerId|payload|planToken|primary/);
    assert.deepEqual(await f.query("SELECT * FROM notion_import_jobs"), before, "check is observational, never claim/renew/sweep");
    const missing = await runNotionJobCheck({ store: f.store, deps: f.deps,
      keyring: createNotionJobKeyring({ NOTION_IMPORT_JOB_KEY: randomBytes(32).toString("base64") }) });
    assert.equal(missing.inputs.unreadable, 1);
    const wrongSigner = createApplicationServices({ persistence: f.store, env: { ...env, AUTH_JWT_SECRET: "different-signing-fixture-secret-over-thirty-two-bytes" } });
    const unsigned = await runNotionJobCheck({ store: f.store, deps: wrongSigner, keyring: rotated });
    assert.equal(unsigned.inputs.stalePlan, 1);
    assert.deepEqual(await f.query("SELECT * FROM notion_import_jobs"), before);
    await f.query("UPDATE import_plan_generation SET generation = ?", [randomBytes(16).toString("hex")]);
    const stale = await runNotionJobCheck({ store: f.store, deps: f.deps, keyring: rotated });
    assert.equal(stale.inputs.stalePlan, 1);
    assert.equal((await f.query("SELECT state FROM notion_import_jobs"))[0].state, "queued");
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await runNotionJobCheck({ store: f.store, deps: f.deps, keyring: rotated, signal: aborted.signal })).checked, 0);
  });
  test(`${provider}: a legal 8 MiB bundle completes without shrinking the import or encryption limits`, options, async t => {
    const f = await fixture(t, provider);
    const bundle = { ...source(), padding: "" };
    bundle.padding = "x".repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(bundle)));
    assert.equal(Buffer.byteLength(JSON.stringify(bundle)), 8 * 1024 * 1024);
    const job = await f.enqueue(bundle);
    await executeNextNotionJob({ jobs: f.jobs, store: f.store, deps: f.deps });
    assert.equal((await f.store.getMyNotionImportJob({ actorId: f.actorId, jobId: job.id }))?.state, "succeeded");
    assert.equal((await f.query("SELECT payload FROM notion_import_jobs"))[0].payload, null);
  });
  test(`${provider}: authenticated HTTP start/list/status/cancel never expose another owner's jobs`, options, async t => {
    const f = await fixture(t, provider);
    const server = createApiServer({ store: f.store, env, logger: () => {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/v1/imports/notion/jobs`;
    const call = async (path: string, method: string, actor: string | null, body?: unknown, key?: string) => {
      const response = await fetch(base + path, { method, headers: {
        ...(actor ? { authorization: `Bearer ${token(actor)}` } : {}), "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call("", "GET", null)).status, 401);
    const bundle = source();
    const dry = await importNotionBundle({ actorId: f.actorId, bundle, apply: false, deps: f.deps });
    const started = await call("", "POST", f.actorId, { bundle, planToken: dry.planToken }, randomUUID());
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const id = started.body.data.id;
    assert.equal((await call(`/${id}`, "GET", "other-owner")).status, 404);
    assert.equal((await call(`/${id}`, "DELETE", "other-owner")).status, 404);
    assert.deepEqual((await call("", "GET", "other-owner")).body.data, []);
    assert.equal((await call("", "POST", f.actorId, { bundle, planToken: dry.planToken })).status, 400);
    const cancelled = await call(`/${id}`, "DELETE", f.actorId);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.state, "cancelled");
    assert.equal((await call("", "GET", f.actorId)).body.data.length, 1);
    assert.doesNotMatch(JSON.stringify(cancelled), /leaseToken|ownerId|payload|planToken/);
  });
}

test("SQLite queue survives an actual connection close and reopen without plaintext input", async t => {
  const dir = await mkdtemp(join(tmpdir(), "notion-durable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "jobs.sqlite");
  const first = createSqliteClient({ filename: path });
  await runSqliteMigrations(first);
  const store = createSqliteStore(first);
  const deps = createApplicationServices({ persistence: store, env });
  const jobs = createNotionJobService({ store, deps, env })!;
  const actorId = "restart-author", bundle = source();
  const dry = await importNotionBundle({ actorId, bundle, apply: false, deps });
  const job = await jobs.start({ actorId, bundle, planToken: dry.planToken, idempotencyKey: randomUUID() });
  first.close();
  const second = createSqliteClient({ filename: path });
  t.after(() => second.close());
  const nextStore = createSqliteStore(second), nextDeps = createApplicationServices({ persistence: nextStore, env });
  const nextJobs = createNotionJobService({ store: nextStore, deps: nextDeps, env })!;
  await executeNextNotionJob({ store: nextStore, deps: nextDeps, jobs: nextJobs });
  assert.equal((await nextStore.getMyNotionImportJob({ actorId, jobId: job.id }))?.state, "succeeded");
  const wrong = createNotionJobService({ store: nextStore, deps: nextDeps,
    env: { ...env, NOTION_IMPORT_JOB_KEY: randomBytes(32).toString("base64") },
  })!;
  assert.equal(await executeNextNotionJob({ store: nextStore, deps: nextDeps, jobs: wrong }), false);
});
