import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createMediaAssetService, type MediaLibraryPage } from "../application/media-assets.ts";
import { createApiServer } from "../server.ts";
import { Worker } from "node:worker_threads";
import { setTimeout as pause } from "node:timers/promises";
import { createApplicationServices } from "../application/services.ts";
import { importNotionBundle } from "../application/notion-import.ts";
import type { CommitNotionImportWorkInput } from "../application/notion-import-plan.ts";
import { createPostgresStore } from "./postgres.ts";
import type { PgDatabase, PgRow } from "./postgres-driver.ts";
import type { OwnershipWorkerInput, OwnershipWorkerMessage } from "./test-support/notion-ownership-sqlite-worker.ts";
import { ImportConflictError } from "../domain/errors.ts";
import { bilingualBundle, ownerMigration, ownershipEnv, ownershipFixture, sourceBundle, sourcePage, type OwnershipFixture, type Provider } from "./test-support/notion-ownership-fixture.ts";

function databaseOwnerConflict(error: unknown, provider: Provider): boolean {
  if (!(error instanceof Error)) return false;
  if (provider === "sqlite") return "errcode" in error && error.errcode === 1811 && error.message === "external_content_links_page_owner_conflict";
  return "code" in error && error.code === "23P01" && "constraint_name" in error && error.constraint_name === "external_content_links_page_owner_excl";
}

for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run real PostgreSQL ownership tests." };

  test(`direct SQL enforces page ownership on INSERT and UPDATE, but permits the same owner across locales (${provider})`, options, async () => {
    const f = await ownershipFixture(provider);
    try {
      const [a, b] = await Promise.all([f.article(f.actors[0]), f.article(f.actors[1])]);
      await f.insertLink("shared-page", "zh-CN", a.id, f.actors[0]);
      await f.insertLink("shared-page", "en", a.id, f.actors[0]);
      await f.insertLink("separate-page", "zh-TW", b.id, f.actors[1]);
      const before = await f.rows("SELECT * FROM external_content_links ORDER BY external_id, locale");
      await assert.rejects(f.insertLink("shared-page", "zh-TW", b.id, f.actors[1]), (error) => databaseOwnerConflict(error, provider));
      await assert.rejects(f.exec("UPDATE external_content_links SET owner_id = ?, article_id = ? WHERE external_id = 'shared-page' AND locale = 'en'", [f.actors[1], b.id]), (error) => databaseOwnerConflict(error, provider));
      await assert.rejects(f.exec("UPDATE external_content_links SET external_id = 'shared-page' WHERE external_id = 'separate-page'"), (error) => databaseOwnerConflict(error, provider));
      assert.deepEqual(await f.rows("SELECT * FROM external_content_links ORDER BY external_id, locale"), before);
      // An in-place checkpoint update must not conflict with its own row.
      await f.exec("UPDATE external_content_links SET owner_id = owner_id, digest = 'refreshed' WHERE external_id = 'shared-page'");
      await f.exec("UPDATE external_content_links SET owner_id = ?, article_id = ? WHERE external_id = 'separate-page'", [f.actors[0], a.id]);
      assert.equal((await f.rows("SELECT DISTINCT owner_id FROM external_content_links")).length, 1);
    } finally { await f.close(); }
  });

  test(`the adapter translates only its ownership violation into a typed conflict (${provider})`, options, async () => {
    const f = await ownershipFixture(provider);
    try {
      const a = await f.article(f.actors[0]);
      const b = await f.article(f.actors[1]);
      await f.insertLink("adapter-page", "zh-CN", a.id, f.actors[0]);
      const input = { provider: "notion", externalId: "adapter-page", locale: "en", articleId: b.id,
        ownerId: f.actors[1], digest: "fixture", syncedAt: new Date().toISOString() };
      await assert.rejects(f.store.upsertExternalContentLink(input), (error: unknown) => {
        assert.ok(error instanceof ImportConflictError);
        assert.match(error.message, /already owned by another account/i);
        assert.ok(!error.message.includes(f.actors[0]) && !error.message.includes(a.id));
        return true;
      });
      // Foreign-key and CHECK failures must not masquerade as an ownership race.
      for (const malformed of [{ ...input, externalId: "missing-work", articleId: randomUUID() }, { ...input, externalId: "invalid-locale", locale: "xx" }]) {
        await assert.rejects(f.store.upsertExternalContentLink(malformed), (error: unknown) => {
          assert.ok(error instanceof Error && !(error instanceof ImportConflictError));
          return true;
        });
      }
      // A different PostgreSQL exclusion failure shares the SQLSTATE, not the identity.
      if (f.sql) {
        await f.exec("CREATE FUNCTION fail_unrelated_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unrelated exclusion' USING ERRCODE = '23P01', CONSTRAINT = 'unrelated_owner_excl'; END $$");
        await f.exec("CREATE TRIGGER fail_unrelated_exclusion BEFORE INSERT ON external_content_links FOR EACH ROW EXECUTE FUNCTION fail_unrelated_exclusion()");
        await assert.rejects(f.store.upsertExternalContentLink({ ...input, externalId: "unrelated-exclusion" }), (error: unknown) => {
          assert.ok(error instanceof Error && !(error instanceof ImportConflictError));
          assert.match(error.message, /unrelated exclusion/);
          return true;
        });
      } else {
        await f.exec("CREATE TRIGGER fail_unrelated_trigger BEFORE INSERT ON external_content_links BEGIN SELECT RAISE(ABORT, 'unrelated trigger'); END");
        await assert.rejects(f.store.upsertExternalContentLink({ ...input, externalId: "unrelated-trigger" }), /unrelated trigger/);
      }
      assert.equal((await f.rows("SELECT * FROM external_content_links")).length, 1);
    } finally { await f.close(); }
  });

  test(`the owner migration refuses contradictory legacy rows transactionally and succeeds after explicit remediation (${provider})`, options, async () => {
    const f = await ownershipFixture(provider, { legacy: true });
    try {
      const a = await f.article(f.actors[0]);
      const b = await f.article(f.actors[1]);
      await f.insertLink("legacy-conflict", "zh-CN", a.id, f.actors[0]);
      await f.insertLink("legacy-conflict", "en", b.id, f.actors[1]);
      const before = await f.snapshot();
      const history = await f.rows("SELECT version FROM api_schema_migrations ORDER BY version");
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(f.migrate(), /conflicting.*ownership.*0037-import-provenance/i);
        assert.deepEqual(await f.snapshot(), before, "failed upgrades preserve articles, tags, links and journal rows");
        assert.deepEqual(await f.rows("SELECT version FROM api_schema_migrations ORDER BY version"), history);
        if (f.db) {
          assert.deepEqual(await f.rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'external_content_owner_%'"), []);
          assert.deepEqual(await f.rows("SELECT name FROM sqlite_temp_master WHERE name LIKE 'external_content_owner_%'"), []);
        } else assert.deepEqual(await f.rows("SELECT conname FROM pg_constraint WHERE conrelid = 'external_content_links'::regclass AND conname = 'external_content_links_page_owner_excl'"), []);
      }
      // This deletion models an operator-reviewed provenance correction, not automatic cleanup.
      await f.exec("DELETE FROM external_content_links WHERE external_id = 'legacy-conflict' AND owner_id = ?", [f.actors[1]]);
      const migrations = new URL(provider === "sqlite" ? "./migrations/sqlite/" : "./migrations/", import.meta.url);
      const expected = (await readdir(migrations)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name >= ownerMigration[provider]).sort().map((name) => name.slice(0, -4));
      assert.ok(expected.includes(ownerMigration[provider]));
      assert.deepEqual(await f.migrate(), expected);
      assert.deepEqual(await f.migrate(), []);
      await assert.rejects(f.insertLink("legacy-conflict", "en", b.id, f.actors[1]), (error) => databaseOwnerConflict(error, provider));
      await f.insertLink("legacy-conflict", "en", a.id, f.actors[0]);
      assert.equal((await f.rows("SELECT DISTINCT owner_id FROM external_content_links")).length, 1);
    } finally { await f.close(); }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function releaseSqlite(gate: SharedArrayBuffer) {
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
}
function sqliteContender(input: OwnershipWorkerInput) {
  const worker = new Worker(new URL("./test-support/notion-ownership-sqlite-worker.ts", import.meta.url), { workerData: input });
  const received = new Map<OwnershipWorkerMessage["type"], OwnershipWorkerMessage>();
  const waiting = new Map<OwnershipWorkerMessage["type"], { resolve: (value: OwnershipWorkerMessage) => void; reject: (error: Error) => void }>();
  let failure: Error | undefined;
  const fail = (error: Error) => { failure = error; for (const item of waiting.values()) item.reject(error); };
  worker.on("message", (message: OwnershipWorkerMessage) => { received.set(message.type, message); waiting.get(message.type)?.resolve(message); });
  worker.on("error", fail);
  worker.on("exit", (code) => { if (!received.has("done")) fail(new Error(`Ownership SQLite worker exited without a result (${code}).`)); });
  return { worker, wait(type: OwnershipWorkerMessage["type"]): Promise<OwnershipWorkerMessage> {
    if (failure) return Promise.reject(failure);
    const message = received.get(type);
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => waiting.set(type, { resolve, reject }));
  } };
}
async function beforeCompletion<T>(barrier: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return Promise.race([barrier, operation.then(() => { throw new Error("The operation completed without reaching its concurrency barrier."); })]);
}
async function assertPgBlocked(sql: PgDatabase, waiter: number, blocker: number) {
  assert.notEqual(waiter, blocker, "the operations must use independent real PostgreSQL backends");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql.unsafe<{ blocked: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [waiter, blocker]);
    if (row!.blocked) return;
    await pause(10);
  }
  assert.fail("the competing PostgreSQL connection never waited on the winner's real transaction");
}

for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run real PostgreSQL ownership tests.", timeout: 45_000 };
  for (const winner of [0, 1] as const) {
    test(`independent full imports of one page in zh-CN/en have exactly one owner; ${winner === 0 ? "zh-CN" : "en"} wins (${provider})`, options, async () => {
      const f = await ownershipFixture(provider);
      const gate = new SharedArrayBuffer(4);
      const workers: Worker[] = [];
      const release = deferred<void>();
      const outstanding: Promise<unknown>[] = [];
      try {
        const sharedId = randomUUID();
        const tags = [`owner-a-${randomUUID()}`, `owner-b-${randomUUID()}`];
        const sources = [sourceBundle(sourcePage(sharedId, "Chinese claim", [tags[0]!])), bilingualBundle(sharedId, [tags[1]!])] as const;
        const plans = await Promise.all(sources.map((source, index) => f.preview(source, f.actors[index]!)));
        assert.deepEqual(plans.map((plan) => plan.summary.create), [1, 1]);
        const { journal, sessionId } = await f.record();
        const loser = winner === 0 ? 1 : 0;
        let winningReport;
        let losingReport;
        if (f.db) {
          const first = sqliteContender({ filename: f.filename, operation: "import", actorId: f.actors[winner], source: sources[winner], planToken: plans[winner]!.planToken!, gate });
          workers.push(first.worker);
          const firstDone = first.wait("done");
          await beforeCompletion(first.wait("holding"), firstDone);
          const second = sqliteContender({ filename: f.filename, operation: "import", actorId: f.actors[loser], source: sources[loser], planToken: plans[loser]!.planToken!, probeLocked: true });
          workers.push(second.worker);
          const secondDone = second.wait("done");
          await beforeCompletion(second.wait("blocked"), secondDone);
          await beforeCompletion(second.wait("attempting"), secondDone);
          releaseSqlite(gate);
          const results = await Promise.all([firstDone, secondDone]);
          assert.ok(results.every((result) => result.ok), JSON.stringify(results));
          winningReport = results[0]!.report!; losingReport = results[1]!.report!;
        } else {
          const sql = f.sql!;
          const holding = deferred<number>();
          const attempting = deferred<number>();
          let finalWork = false;
          const heldSql: PgDatabase = { unsafe: (query, parameters) => sql.unsafe(query, parameters), end: async () => {},
            begin: (work) => sql.begin(async (tx) => {
              const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              const result = await work(tx);
              if (finalWork) { holding.resolve(backend!.pid); await release.promise; }
              return result;
            }) };
          const observedSql: PgDatabase = { unsafe: (query, parameters) => sql.unsafe(query, parameters), end: async () => {},
            begin: (work) => sql.begin(async (tx) => {
              const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              return work({ unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]> {
                if (query.includes("pg_advisory_xact_lock")) attempting.resolve(backend!.pid);
                return tx.unsafe<TRow>(query, parameters);
              } });
            }) };
          const firstStore = createPostgresStore(heldSql);
          const firstDeps = createApplicationServices({ persistence: { ...firstStore,
            commitNotionImportWork(input: CommitNotionImportWorkInput) { finalWork = input.editions.length > 0; return firstStore.commitNotionImportWork(input); },
          }, env: ownershipEnv });
          const secondDeps = createApplicationServices({ persistence: createPostgresStore(observedSql), env: ownershipEnv });
          const first = importNotionBundle({ actorId: f.actors[winner], bundle: sources[winner], planToken: plans[winner]!.planToken, apply: true, deps: firstDeps });
          outstanding.push(first);
          const blocker = await beforeCompletion(holding.promise, first);
          const second = importNotionBundle({ actorId: f.actors[loser], bundle: sources[loser], planToken: plans[loser]!.planToken, apply: true, deps: secondDeps });
          outstanding.push(second);
          const waiter = await beforeCompletion(attempting.promise, second);
          await assertPgBlocked(sql, waiter, blocker);
          release.resolve();
          [winningReport, losingReport] = await Promise.all([first, second]);
        }
        assert.equal(winningReport.summary.create, 1);
        assert.equal(winningReport.summary.failed + winningReport.summary.refused, 0);
        assert.equal(losingReport.summary.refused, sources[loser].pages.length);
        assert.equal(losingReport.summary.create + losingReport.summary.update + losingReport.summary.failed, 0);
        assert.ok(losingReport.pages.every((item) => /already owned by another account/i.test(item.detail)), JSON.stringify(losingReport));
        assert.ok(!JSON.stringify(losingReport).includes(f.actors[winner]), "conflict reports must not expose another account's identity");
        const claims = await f.rows("SELECT owner_id, locale FROM external_content_links WHERE external_id = ?", [sharedId]);
        assert.deepEqual(claims, [{ owner_id: f.actors[winner], locale: winner === 0 ? "zh-CN" : "en" }]);
        assert.equal((await f.rows("SELECT * FROM articles")).length, 1);
        assert.equal((await f.rows("SELECT * FROM article_translations")).length, sources[winner].pages.length);
        assert.deepEqual(await f.rows("SELECT * FROM articles WHERE author_id = ?", [f.actors[loser]]), []);
        assert.deepEqual(await f.rows("SELECT name FROM taxonomy_translations"), [{ name: tags[winner] }]);
        assert.deepEqual(await f.rows("SELECT id FROM taxonomies WHERE NOT EXISTS (SELECT 1 FROM article_taxonomies WHERE taxonomy_id = taxonomies.id)"), []);
        const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 1 });
        assert.ok(changes.some((change) => change.entityType === "articles"));
        assert.equal(new Set(changes.map((change) => change.transactionId)).size, 1);
        assert.ok(!JSON.stringify(changes).includes(f.actors[loser]), "no losing operation may enter provider replay");
        const nextPreview = await f.preview(sources[loser], f.actors[loser]);
        assert.equal(nextPreview.summary.refused, sources[loser].pages.length);
        assert.ok(nextPreview.pages.every((item) => /another account/i.test(item.detail)), JSON.stringify(nextPreview.pages));
      } finally {
        releaseSqlite(gate); release.resolve();
        await Promise.all(workers.map((worker) => worker.terminate()));
        await Promise.allSettled(outstanding);
        await f.close();
      }
    });
  }

  test(`independent direct SQL transactions cannot claim different locales for different owners (${provider})`, options, async () => {
    const f = await ownershipFixture(provider);
    const gate = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    const release = deferred<void>();
    const outstanding: Promise<unknown>[] = [];
    try {
      const a = await f.article(f.actors[0]);
      const b = await f.article(f.actors[1]);
      const query = "INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest) VALUES ('notion', 'raw-concurrent-page', ?, ?, ?, 'fixture')";
      if (f.db) {
        const first = sqliteContender({ filename: f.filename, operation: "sql", query, values: ["zh-CN", a.id, f.actors[0]], gate }); workers.push(first.worker);
        const firstDone = first.wait("done");
        await beforeCompletion(first.wait("holding"), firstDone);
        const second = sqliteContender({ filename: f.filename, operation: "sql", query, values: ["en", b.id, f.actors[1]], probeLocked: true }); workers.push(second.worker);
        const secondDone = second.wait("done");
        await beforeCompletion(second.wait("blocked"), secondDone);
        await beforeCompletion(second.wait("attempting"), secondDone);
        releaseSqlite(gate);
        assert.equal((await firstDone).ok, true);
        const rejected = await secondDone;
        assert.equal(rejected.ok, false);
        assert.equal(rejected.errcode, 1811);
        assert.equal(rejected.message, "external_content_links_page_owner_conflict");
      } else {
        const sql = f.sql!;
        const held = deferred<number>();
        const attempting = deferred<number>();
        const statement = query.replace(/\?/g, (() => { let i = 0; return () => `$${++i}`; })());
        const first = sql.begin(async (tx) => {
          const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await tx.unsafe(statement, ["zh-CN", a.id, f.actors[0]]);
          held.resolve(backend!.pid); await release.promise;
        }); outstanding.push(first);
        const blocker = await beforeCompletion(held.promise, first);
        const second = sql.begin(async (tx) => {
          const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          attempting.resolve(backend!.pid);
          await tx.unsafe(statement, ["en", b.id, f.actors[1]]);
        });
        const rejected = assert.rejects(second, (error) => databaseOwnerConflict(error, provider)); outstanding.push(rejected);
        await assertPgBlocked(sql, await beforeCompletion(attempting.promise, second), blocker);
        release.resolve(); await first; await rejected;
      }
      assert.deepEqual(await f.rows("SELECT owner_id, locale FROM external_content_links"), [{ owner_id: f.actors[0], locale: "zh-CN" }]);
    } finally {
      releaseSqlite(gate); release.resolve();
      await Promise.all(workers.map((worker) => worker.terminate()));
      await Promise.allSettled(outstanding);
      await f.close();
    }
  });
}

async function injectFailure(f: OwnershipFixture, table: string, event: "INSERT" | "UPDATE", condition = "1 = 1") {
  if (f.db) await f.exec(`CREATE TRIGGER ownership_injected_failure BEFORE ${event} ON ${table}
    WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected unrelated import failure'); END`);
  else {
    await f.exec("CREATE FUNCTION ownership_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected unrelated import failure'; END $$");
    await f.exec(`CREATE TRIGGER ownership_injected_failure BEFORE ${event} ON ${table} FOR EACH ROW
      WHEN (${condition.replace("1 = 1", "true")}) EXECUTE FUNCTION ownership_injected_failure()`);
  }
}
async function localMedia(f: OwnershipFixture) {
  const directory = join(f.directory, "media-objects"); await mkdir(directory);
  const media = createMediaAssetService({ store: f.store, storage: {
    async putObject({ key, bytes }) { const path = join(directory, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
    getObject: (key) => readFile(join(directory, key)),
    deleteObject: (key) => unlink(join(directory, key)), close() {},
  } });
  const png = (color: string) => sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
  return { media, png, files: async () => (await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile()) };
}
const failureStages = ["article-create", "article-update", "translation-create", "translation-update", "tag-create", "tag-translation", "tag-association", "media-references", "provenance-insert", "provenance-update", "journal-capture"] as const;
for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run real PostgreSQL ownership tests." };
  for (const stage of failureStages) {
    test(`failure at ${stage} rolls back the whole work, new tags and replay without deleting existing data (${provider})`, options, async () => {
      const f = await ownershipFixture(provider);
      try {
        const sharedName = `shared-${randomUUID()}`;
        const newName = `new-${randomUUID()}`;
        const sharedTag = await f.store.createTag({ actorId: f.actors[1], name: sharedName });
        await f.store.createArticle({ authorId: f.actors[1], slug: "pre-existing-tag-user", title: "Keep this work and its shared tag",
          contentBlocks: [{ id: "p", type: "paragraph", text: "Existing user data" }], tagIds: [sharedTag.id] });
        let source = bilingualBundle(randomUUID(), [sharedName, newName]);
        if (stage.endsWith("-update")) {
          const initial = structuredClone(source);
          for (const page of initial.pages) page.properties.Tags = { type: "multi_select", multi_select: [{ name: sharedName }] };
          const result = await f.importFresh(initial);
          assert.equal(result.summary.create, 1); assert.equal(result.summary.update, 1);
          source = { ...source, pages: source.pages.map((page, index) => {
            const changed = sourcePage(page.id, `Updated edition ${index}`, [sharedName, newName]);
            return { ...page, properties: { ...page.properties, ...changed.properties }, blocks: changed.blocks };
          }) };
        }
        let copyImage;
        if (stage === "media-references") {
          const { media, png } = await localMedia(f);
          const asset = await media.upload({ ownerId: f.actors[0], bytes: await png("blue"), contentType: "image/png" });
          source.pages[0]!.blocks.push({ object: "block", id: "image", type: "image", has_children: false,
            image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/ownership?signature=fixture" }, caption: [] } });
          copyImage = async () => ({ ok: true as const, src: asset.src });
        }
        const { journal, sessionId } = await f.record();
        const dry = await f.preview(source);
        const before = await f.snapshot();
        switch (stage) {
          case "article-create": await injectFailure(f, "articles", "INSERT"); break;
          case "article-update": await injectFailure(f, "articles", "UPDATE", `OLD.author_id = '${f.actors[0]}'`); break;
          case "translation-create": await injectFailure(f, "article_translations", "INSERT", "NEW.locale = 'en'"); break;
          case "translation-update": await injectFailure(f, "article_translations", "UPDATE", "NEW.locale = 'en'"); break;
          case "tag-create": await injectFailure(f, "taxonomies", "INSERT"); break;
          case "tag-translation": await injectFailure(f, "taxonomy_translations", "INSERT"); break;
          case "tag-association": await injectFailure(f, "article_taxonomies", "INSERT"); break;
          case "media-references": await injectFailure(f, "article_media_refs", "INSERT"); break;
          case "provenance-insert": await injectFailure(f, "external_content_links", "INSERT", "NEW.locale = 'en'"); break;
          case "provenance-update": await injectFailure(f, "external_content_links", "UPDATE", "NEW.locale = 'en'"); break;
          case "journal-capture": await injectFailure(f, "provider_migration_changes", "INSERT", "NEW.entity_type = 'external_content_links' AND NEW.entity_id LIKE '%\"en\"%'"); break;
        }
        const report = await importNotionBundle({ actorId: f.actors[0], bundle: source, planToken: dry.planToken, apply: true, deps: f.services, copyImage });
        assert.equal(report.summary.failed, 2, JSON.stringify(report.pages));
        assert.equal(report.summary.refused + report.summary.create + report.summary.update, 0);
        assert.ok(report.pages.every((page) => /rolled back/i.test(page.detail)));
        assert.ok(report.pages.every((page) => !page.detail.includes("injected unrelated import failure")), "provider diagnostics are not a user-facing refusal");
        assert.deepEqual(await f.snapshot(), before, "a later edition/capture failure also undoes all earlier successful writes");
        assert.deepEqual(await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 1 }), []);
        assert.equal(Number((await f.rows("SELECT next_sequence FROM provider_migration_sessions WHERE session_id = ?", [sessionId]))[0]!.next_sequence), 1);
        assert.equal((await f.store.listTaxonomies({ kind: "tag", query: newName })).length, 0);
        assert.equal((await f.store.listArticleTaxonomies({ articleId: (await f.rows("SELECT id FROM articles WHERE author_id = ?", [f.actors[1]]))[0]!.id as string, kind: "tag" }))[0]!.id, sharedTag.id);
      } finally { await f.close(); }
    });
  }

  test(`a database ownership violation after comparison is refused and rolls back article/tag/journal writes (${provider})`, options, async () => {
    const f = await ownershipFixture(provider);
    try {
      const outsider = await f.article(f.actors[1]);
      const source = sourceBundle(sourcePage(randomUUID(), "Late SQL claim", [`late-tag-${randomUUID()}`]));
      const id = source.pages[0]!.id;
      const dry = await f.preview(source);
      const { journal, sessionId } = await f.record();
      const before = await f.snapshot();
      let deps = f.services;
      let directClaim = false;
      if (f.db) {
        // SQLite cannot admit an independent writer during BEGIN IMMEDIATE.
        // A real trigger injects a late claim inside the current transaction,
        // after the comparison but before the application's provenance INSERT.
        await f.exec(`CREATE TRIGGER inject_late_owner AFTER INSERT ON article_translations
          WHEN NEW.title = 'Late SQL claim' BEGIN
          INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest)
          VALUES ('notion', '${id}', 'en', '${outsider.id}', '${f.actors[1]}', 'late'); END`);
      } else {
        const sql = f.sql!;
        const observed: PgDatabase = { unsafe: (query, values) => sql.unsafe(query, values), end: async () => {},
          begin: (work) => sql.begin((tx) => work({ async unsafe<TRow = PgRow>(query: string, values?: readonly unknown[]): Promise<TRow[]> {
            if (!directClaim && query.trimStart().startsWith("INSERT INTO external_content_links")) {
              directClaim = true;
              // A different real connection bypasses the application advisory
              // lock. The exclusion constraint, not serialization, must stop us.
              await f.insertLink(id, "en", outsider.id, f.actors[1]);
            }
            return tx.unsafe<TRow>(query, values);
          } })) };
        deps = createApplicationServices({ persistence: createPostgresStore(observed), env: ownershipEnv });
      }
      const report = await importNotionBundle({ actorId: f.actors[0], bundle: source, planToken: dry.planToken, apply: true, deps });
      assert.equal(report.summary.refused, 1, JSON.stringify(report.pages));
      assert.equal(report.summary.failed + report.summary.create + report.summary.update, 0);
      assert.match(report.pages[0]!.detail, /already owned by another account/);
      assert.ok(!report.pages[0]!.detail.includes(f.actors[1]) && !report.pages[0]!.detail.includes(outsider.id));
      const after = await f.snapshot();
      if (f.sql) {
        assert.equal(directClaim, true);
        assert.deepEqual(await f.rows("SELECT owner_id FROM external_content_links WHERE external_id = ?", [id]), [{ owner_id: f.actors[1] }]);
        after.external_content_links = before.external_content_links!;
      }
      assert.deepEqual(after, before);
      assert.deepEqual(await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 1 }), []);
    } finally { await f.close(); }
  });
}

function accessToken(sub: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" })}.${encode({ sub,
    iss: ownershipEnv.AUTH_JWT_ISSUER, aud: ownershipEnv.AUTH_JWT_AUDIENCE, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, sid: `ownership-${sub}`, jti: randomUUID() })}`;
  return `${unsigned}.${createHmac("sha256", ownershipEnv.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}
for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run real PostgreSQL ownership tests." };
  test(`unused images after rollback stay visible and owner-removable over HTTP; referenced/shared files stay protected (${provider})`, options, async () => {
    const f = await ownershipFixture(provider);
    let server: ReturnType<typeof createApiServer> | undefined;
    try {
      const { media, files, png } = await localMedia(f);
      const shared = await media.upload({ ownerId: f.actors[0], bytes: await png("blue"), contentType: "image/png" });
      await f.store.createArticle({ authorId: f.actors[1], slug: "keep-shared-image", title: "Another author's reference",
        contentBlocks: [{ id: "img", type: "image", src: shared.src, alt: "shared" }] });
      const source = bilingualBundle(randomUUID(), [`media-rollback-${randomUUID()}`]);
      source.pages[0]!.blocks.push({ object: "block", id: "img", type: "image", has_children: false,
        image: { type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/image?signature=fixture" }, caption: [] } });
      const dry = await f.preview(source);
      const { journal, sessionId } = await f.record();
      await injectFailure(f, "provider_migration_changes", "INSERT", "NEW.entity_type = 'external_content_links' AND NEW.entity_id LIKE '%\"en\"%'");
      let uploadedId: string | undefined;
      const report = await importNotionBundle({ actorId: f.actors[0], bundle: source, apply: true, planToken: dry.planToken, deps: f.services,
        copyImage: async () => {
          const asset = await media.upload({ ownerId: f.actors[0], bytes: await png("red"), contentType: "image/png" });
          uploadedId = asset.id; return { ok: true, src: asset.src };
        } });
      assert.ok(uploadedId);
      assert.equal(report.summary.failed, 2);
      assert.ok(report.pages.every((page) => /media library.*remove unused images/i.test(page.detail)));
      assert.equal((await f.rows("SELECT * FROM articles")).length, 1);
      assert.deepEqual(await f.rows("SELECT * FROM external_content_links"), []);
      assert.deepEqual(await f.rows("SELECT * FROM taxonomies"), []);
      assert.deepEqual(await f.rows("SELECT asset_id FROM article_media_refs"), [{ asset_id: shared.id }]);
      const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 });
      assert.equal(changes.length, 1, "only the outside-transaction media upload survives capture");
      assert.equal(changes[0]!.entityType, "media_assets");
      server = createApiServer({ store: f.store, env: ownershipEnv, mediaAssets: media, logger: () => {} });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address(); assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}/api/v1/me/media`;
      const request = (suffix = "", actor = f.actors[0], method = "GET") => fetch(base + suffix, { method, headers: { authorization: `Bearer ${accessToken(actor)}` } });
      const list = await request(); assert.equal(list.status, 200);
      const library = (await list.json() as { data: MediaLibraryPage }).data;
      assert.equal(library.items.find((item) => item.id === uploadedId)!.orphan, true);
      const referenced = library.items.find((item) => item.id === shared.id)!;
      assert.equal(referenced.orphan, false); assert.ok(referenced.referencedBy.length > 0);
      const otherList = await request("", f.actors[1]);
      assert.ok(!(await otherList.text()).includes(uploadedId));
      assert.equal((await request(`/${uploadedId}`, f.actors[1], "DELETE")).status, 404);
      assert.equal((await request(`/${shared.id}`, f.actors[0], "DELETE")).status, 409);
      assert.equal((await files()).length, 2);
      assert.equal((await request(`/${uploadedId}`, f.actors[0], "DELETE")).status, 200);
      assert.equal(await f.store.getMediaAsset({ id: uploadedId }), null);
      assert.ok(await f.store.getMediaAsset({ id: shared.id }));
      assert.equal((await files()).length, 1);
      assert.ok((await media.getPublic({ id: shared.id })).bytes.length > 0);
      assert.equal((await media.listLibrary({ ownerId: f.actors[0] })).items.length, 1);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await f.close();
    }
  });
}
