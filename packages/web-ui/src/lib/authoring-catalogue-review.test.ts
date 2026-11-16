import assert from "node:assert/strict";
import test from "node:test";
import { CatalogueReviewController, catalogueSelectionFingerprint, planCatalogueReview, reviewedCatalogueSelection } from "./authoring-catalogue-review.ts";
import { CatalogueController } from "./authoring-catalogue-controller.ts";
import type { CatalogueEntry } from "./authoring-catalogue.ts";
const row: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "one", title: "One", summary: "Before", status: "draft", workType: "essay", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };
const second = { ...row, id: "a13dbadf-0000-4000-8000-000000000002", slug: "two", title: "Two" };
const input = (selected = [row]) => ({ actor: "author-a", scope: "active" as const, selected });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("review plans group explicitly selected editions by work, bind their snapshots and cap independent work reads", () => {
  const plan = planCatalogueReview(input([row, { ...row, locale: "zh-CN" }]));
  assert.equal(plan.works.length, 1);
  assert.equal(plan.selected.length, 2);
  assert.equal(catalogueSelectionFingerprint([row, second]), catalogueSelectionFingerprint([second, row]));
  assert.notEqual(catalogueSelectionFingerprint([row]), catalogueSelectionFingerprint([{ ...row, summary: "New" }]));
  for (const selection of [[], [row, row], Array.from({ length: 21 }, (_, index) => ({ ...row, id: `a13dbadf-0000-4000-8000-${String(index).padStart(12, "0")}` }))]) assert.throws(() => planCatalogueReview(input(selection)));
  assert.throws(() => planCatalogueReview({ ...input(), scope: "trash" }));
  assert.throws(() => planCatalogueReview({ ...input(), actor: "bad\naccount" }));
});

test("read-only review compares exact chosen metadata and never silently selects newly discovered translations", async () => {
  const calls: string[] = [];
  const controller = new CatalogueReviewController(async (url, init) => {
    calls.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("x-expected-author"), "author-a");
    return Response.json({ data: [{ ...row, summary: "After", status: "published" }, { ...row, locale: "zh-TW", title: "繁體" }] });
  });
  controller.configure(input()); await controller.start();
  const state = controller.getSnapshot();
  assert.equal(calls.length, 1);
  assert.equal(state.status, "complete");
  assert.equal(state.works[0]!.editions.length, 2);
  const comparison = state.works[0]!.differences[0]!;
  assert.equal(comparison.kind, "changed");
  assert.deepEqual(comparison.fields, ["summary", "status"]);
  const accepted = reviewedCatalogueSelection(state);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.locale, "en");
  assert.equal(accepted[0]!.summary, "After");
});

test("review is sequential, cancellable and cannot publish late bodies into a changed selection", async () => {
  const late = deferred<unknown>(); let calls = 0;
  const response = Response.json({}); response.json = () => late.promise;
  const controller = new CatalogueReviewController(async () => { calls++; return response; });
  controller.configure(input([row, second])); const running = controller.start();
  await new Promise(resolve => setImmediate(resolve));
  controller.configure(input([second])); const snapshot = controller.getSnapshot();
  late.resolve({ data: [row] }); await running;
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(snapshot.works[0]!.id, second.id);
  const pending = deferred<Response>();
  const cancelled = new CatalogueReviewController(async () => pending.promise);
  cancelled.configure(input([row, second])); const task = cancelled.start(); cancelled.cancel();
  pending.resolve(Response.json({ data: [row] })); await task;
  assert.equal(cancelled.getSnapshot().status, "cancelled");
  assert.throws(() => reviewedCatalogueSelection(cancelled.getSnapshot()));
});

test("unavailable language/work is not declared deleted, and no incomplete or failed review may replace selection", async () => {
  for (const value of [Response.json({ data: [{ ...row, locale: "zh-CN" }] }), Response.json({}, { status: 404 }), Response.json({ data: [second] })]) {
    const controller = new CatalogueReviewController(async () => value);
    controller.configure(input()); await controller.start();
    assert.throws(() => reviewedCatalogueSelection(controller.getSnapshot()));
  }
});

test("a throttled queue stops before further work, keeps Retry-After across reconfiguration and retries only manually", async () => {
  let calls = 0, now = 1000;
  const controller = new CatalogueReviewController(async () => { calls++; return Response.json({}, { status: 429, headers: { "retry-after": "5" } }); }, () => now);
  controller.configure(input([row, second])); await controller.start();
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot().status, "limited");
  controller.configure(input([second])); await controller.start(); assert.equal(calls, 1);
  now = 6000; await controller.start(); assert.equal(calls, 2);
});

test("account refusals synchronously erase review metadata and notify the parent; late refusals cannot do so", async () => {
  for (const status of [401, 409]) {
    const refused: string[] = [];
    const controller = new CatalogueReviewController(async () => Response.json({ error: { code: status === 409 ? "ACCOUNT_CHANGED" : "UNAUTHENTICATED" } }, { status }), Date.now, reason => refused.push(reason));
    controller.configure(input([row, second])); await controller.start();
    assert.equal(controller.getSnapshot().works.length, 0);
    assert.equal(controller.getSnapshot().plan, null);
    assert.deepEqual(refused, [status === 409 ? "account-changed" : "unauthenticated"]);
  }
  const late = deferred<unknown>(), refusals: string[] = [];
  const response = Response.json({}, { status: 409 }); response.json = () => late.promise;
  const controller = new CatalogueReviewController(async () => response, Date.now, reason => refusals.push(reason));
  controller.configure(input()); const task = controller.start(); await new Promise(resolve => setImmediate(resolve));
  controller.configure(input([second])); late.resolve({ error: { code: "ACCOUNT_CHANGED" } }); await task;
  assert.deepEqual(refusals, []);
});

test("server/network errors stop the queue without auto-retry or fabricated success", async () => {
  for (const fail of [async () => Response.json({}, { status: 503 }), async () => { throw new Error("offline"); }]) {
    let reads = 0;
    const controller = new CatalogueReviewController(async () => { reads++; return fail(); });
    controller.configure(input([row, second])); await controller.start();
    assert.equal(reads, 1);
    assert.equal(controller.getSnapshot().status, "partial");
    assert.equal(controller.getSnapshot().works[1]!.status, "waiting");
    assert.throws(() => reviewedCatalogueSelection(controller.getSnapshot()));
  }
});

test("accepting a reviewed snapshot is explicit, all-or-nothing and bound to the exact current selection/account", async () => {
  const controller = new CatalogueController(async url => url.endsWith("/session") ? Response.json({ data: { id: "author-a" } }) : Response.json({ data: { items: [row], total: 1, works: 1, facets: [], nextCursor: null } }));
  await controller.connect(); controller.toggle(row);
  const fingerprint = catalogueSelectionFingerprint([row]);
  const changed = { ...row, summary: "Reviewed" };
  assert.equal(controller.adoptReviewedSelection("author-b", fingerprint, [changed]), false);
  assert.equal(controller.adoptReviewedSelection("author-a", fingerprint, [changed, second]), false);
  assert.equal(controller.getSnapshot().selected[0]!.summary, "Before");
  assert.equal(controller.adoptReviewedSelection("author-a", fingerprint, [changed]), true);
  assert.equal(controller.getSnapshot().selected[0]!.summary, "Reviewed");
  assert.equal(controller.adoptReviewedSelection("author-a", fingerprint, [row]), false, "a consumed/older snapshot cannot overwrite the reviewed choice");
});
