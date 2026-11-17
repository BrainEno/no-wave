import assert from "node:assert/strict";
import test from "node:test";
import { CollectionExportController } from "./writing-collection-export.ts";
import { parseWritingCollection } from "./writing-collection.ts";
import type { CatalogueEntry } from "./authoring-catalogue.ts";
const row: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "first", title: "One", summary: "Summary", workType: "essay", status: "draft", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };
const second = { ...row, id: "a13dbadf-0000-4000-8000-000000000002", slug: "second", title: "Two" };
function details(entry = row) { return Response.json({ data: { ...entry, authorId: "author-a", revision: "7", contentBlocksVersion: 1, publishedAt: null, contentBlocks: [{ id: "p1", type: "paragraph", text: "PRIVATE-BODY" }] } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function source(selected = [row]) { return { actor: "author-a", ready: true, scope: "active" as const, selected }; }

test("body export reads only explicit exact editions sequentially, strips server facts and rechecks actual session before download", async () => {
  const current = source([row, { ...row, locale: "zh-CN" }]); const calls: string[] = []; let verified = 0;
  const controller = new CollectionExportController({ current: () => current, authorize: async () => { verified++; return true; }, fetcher: async (url, init) => {
    calls.push(url); assert.equal(new Headers(init.headers).get("x-expected-author"), "author-a");
    assert.equal(init.cache, "no-store"); assert.equal(init.method ?? "GET", "GET");
    return details({ ...row, locale: new URL(url, "https://unused.test").searchParams.get("locale")! });
  } });
  await controller.start(); assert.equal(calls.length, 2);
  const state = controller.getSnapshot(); assert.equal(state.status, "complete");
  assert.equal(state.completed, 2); assert.equal(verified, 0);
  const artifact = await controller.authorizedDownload(); assert.equal(verified, 1);
  const parsed = await parseWritingCollection(artifact!.text);
  assert.equal(parsed.collection.entries.length, 2);
  assert.deepEqual(parsed.collection.entries.map(entry => entry.group), ["w1", "w1"]);
  assert.match(artifact!.text, /PRIVATE-BODY/);
  assert.doesNotMatch(artifact!.text, /author-a|revision|publishedAt|a13dbadf|first|contentBlocksVersion/);
});

test("changing source or stopping invalidates a late full body, and never proceeds to another version", async () => {
  const current = source([row, second]), pending = deferred<Response>(); let calls = 0;
  const controller = new CollectionExportController({ current: () => current, authorize: async () => true, fetcher: async () => { calls++; return pending.promise; } });
  const task = controller.start(); controller.cancel(); const cancelled = controller.getSnapshot();
  pending.resolve(details()); await task;
  assert.equal(calls, 1); assert.equal(controller.getSnapshot(), cancelled);
  assert.equal(cancelled.prepared, null); assert.equal(cancelled.status, "cancelled");
  assert.equal(await controller.authorizedDownload(), null);
});

test("account refusals clear all private progress, 429 stops and preserves deadline, other failures do not fake a complete backup", async () => {
  for (const status of [401, 409, 404, 429, 503]) {
    let calls = 0, refused = "", deadline = 0;
    const current = source([row, second]);
    const controller = new CollectionExportController({ current: () => current, authorize: async () => true,
      onRefused: reason => { refused = reason; }, onLimited: value => { deadline = value; }, fetcher: async () => { calls++; return Response.json({ error: { code: status === 409 ? "ACCOUNT_CHANGED" : "ERROR" } }, { status, headers: { "retry-after": "60" } }); } });
    await controller.start(); assert.equal(calls, 1); assert.equal(controller.getSnapshot().prepared, null);
    assert.notEqual(controller.getSnapshot().status, "complete");
    if (status === 401 || status === 409) { assert.ok(refused); assert.equal(controller.getSnapshot().plan, null); }
    if (status === 429) { assert.ok(deadline > Date.now()); await controller.start(); assert.equal(calls, 1); }
    assert.equal(await controller.authorizedDownload(), null);
  }
});

test("unsupported content/changed selections and late account refusals cannot leak or overwrite the next export", async () => {
  const current = source(); let mode = "unsupported";
  const late = deferred<unknown>();
  const controller = new CollectionExportController({ current: () => current, authorize: async () => true, fetcher: async () => {
    if (mode === "unsupported") { const response = details(); const payload = await response.json(); payload.data.contentBlocks = [{ type: "unknown" }]; return Response.json(payload); }
    if (mode === "late") { const response = Response.json({}, { status: 409 }); response.json = () => late.promise; return response; }
    return details();
  } });
  await controller.start(); assert.equal(controller.getSnapshot().status, "failed");
  mode = "late"; const old = controller.start(); await new Promise(resolve => setImmediate(resolve));
  controller.invalidate(); mode = "ready"; await controller.start(); const newer = controller.getSnapshot();
  late.resolve({ error: { code: "ACCOUNT_CHANGED" } }); await old;
  assert.equal(controller.getSnapshot(), newer); assert.equal(newer.status, "complete");
  current.selected = [second]; assert.equal(await controller.authorizedDownload(), null);
});

test("limits and trash are refused before body fetch; a post-preparation account/selection change cannot release old bytes", async () => {
  let selected = [row], ready = true, allow = true, calls = 0;
  const controller = new CollectionExportController({ current: () => ({ ...source(selected), ready }), authorize: async () => allow, fetcher: async () => { calls++; return details(); } });
  selected = Array.from({ length: 21 }, (_, index) => ({ ...row, id: `a13dbadf-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  await controller.start(); assert.equal(calls, 0);
  selected = [row]; ready = false; await controller.start(); assert.equal(calls, 0);
  ready = true; await controller.start(); allow = false; assert.equal(await controller.authorizedDownload(), null);
  assert.equal(controller.getSnapshot().downloading, false);
  controller.invalidate(); assert.equal(controller.getSnapshot().prepared, null);
});

test("changing away and back to equal selection values is still a new export intent", async () => {
  const original = [row]; const current = source(original); const pending = deferred<Response>();
  const controller = new CollectionExportController({ current: () => current, authorize: async () => true, fetcher: () => pending.promise });
  const run = controller.start(); current.selected = [row]; pending.resolve(details()); await run;
  assert.equal(controller.getSnapshot().prepared, null);
  assert.equal(controller.getSnapshot().status, "idle");
});
