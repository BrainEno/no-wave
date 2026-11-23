import assert from "node:assert/strict";
import test from "node:test";
import { CatalogueController } from "./authoring-catalogue-controller.ts";
import type { CatalogueEntry } from "./authoring-catalogue.ts";

const row: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "one", title: "One", summary: "", status: "draft", workType: "other", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };
const page = (items = [row], cursor: string | null = null) => Response.json({ data: { items, total: items.length, works: items.length, facets: [], nextCursor: cursor } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("older list responses cannot replace a newer filter and selection resets only when its criteria change", async () => {
  const old = deferred<Response>(); let reads = 0;
  const controller = new CatalogueController(async (url) => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    return ++reads === 1 ? old.promise : page([{ ...row, title: "New filter" }]);
  });
  const initial = controller.connect();
  await new Promise(resolve => setImmediate(resolve));
  await controller.apply({ ...controller.getSnapshot().filters, q: "New" });
  old.resolve(page([{ ...row, title: "Old filter" }])); await initial;
  assert.equal(controller.getSnapshot().page?.items[0]?.title, "New filter");
  controller.toggle(row);
  assert.equal(controller.getSnapshot().selected.length, 1);
  await controller.refresh();
  assert.equal(controller.getSnapshot().selected.length, 1);
  await controller.apply({ ...controller.getSnapshot().filters, locale: "en" });
  assert.equal(controller.getSnapshot().selected.length, 0);
});

test("paging keeps a cursor trail, errors do not advance it, and account changes erase private state", async () => {
  let mode = "first";
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (mode === "error") return Response.json({ error: { code: "SERVICE_UNAVAILABLE" } }, { status: 503 });
    if (mode === "changed") return Response.json({ error: { code: "ACCOUNT_CHANGED" } }, { status: 409 });
    return page([{ ...row, title: mode }], mode === "first" ? "cursor-one" : null);
  });
  await controller.connect(); controller.toggle(row);
  mode = "error"; await controller.next();
  assert.equal(controller.getSnapshot().pageIndex, 0);
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().page?.items[0]?.title, "first");
  mode = "second"; await controller.next();
  assert.equal(controller.getSnapshot().pageIndex, 1);
  mode = "first"; await controller.previous();
  assert.equal(controller.getSnapshot().pageIndex, 0);
  mode = "changed"; await controller.refresh();
  assert.equal(controller.getSnapshot().status, "account-changed");
  assert.equal(controller.getSnapshot().page, null);
  assert.equal(controller.getSnapshot().selected.length, 0);
});

test("429 respects Retry-After without automatic retry, even after changing filters", async () => {
  let now = 1000, reads = 0;
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    reads++; return Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429, headers: { "retry-after": "5" } });
  }, () => now);
  await controller.connect(); assert.equal(reads, 1);
  await controller.refresh(); await controller.apply({ ...controller.getSnapshot().filters, q: "another" });
  assert.equal(reads, 1);
  now = 6000; await controller.refresh(); assert.equal(reads, 2);
});

test("a cancelled/obsolete restore intent cannot write, and a confirmed restore is not auto-replayed", async () => {
  let posts = 0;
  const trashRow = { ...row, deletedAt: row.updatedAt };
  const controller = new CatalogueController(async (url, init) => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (init?.method === "POST") { posts++; throw new Error("uncertain response"); }
    return page([trashRow]);
  });
  await controller.connect(); await controller.apply({ ...controller.getSnapshot().filters, scope: "trash" });
  controller.requestRestore(trashRow); controller.cancelRestore(); await controller.confirmRestore();
  assert.equal(posts, 0);
  controller.requestRestore(trashRow); await controller.apply({ ...controller.getSnapshot().filters, q: "One" }); await controller.confirmRestore();
  assert.equal(posts, 0);
  controller.requestRestore(trashRow); await controller.confirmRestore();
  assert.equal(posts, 1);
  assert.equal(controller.getSnapshot().status, "failed");
  assert.match(controller.getSnapshot().error, /核对/);
  await controller.refresh(); assert.equal(posts, 1, "refresh is a read, not a retry of the uncertain write");
});

test("disconnect invalidates late identity/page completions and refuses selection outside the visible page", async () => {
  const late = deferred<Response>();
  const controller = new CatalogueController(async () => late.promise);
  const running = controller.connect(); controller.disconnect();
  const snapshot = controller.getSnapshot();
  late.resolve(Response.json({ data: { id: "author-a" } })); await running;
  assert.equal(controller.getSnapshot(), snapshot);
  controller.toggle(row); assert.equal(controller.getSnapshot().selected.length, 0);
});

test("a late rejected-response body cannot erase a newer successful page or account", async () => {
  const late = deferred<unknown>(); let reads = 0;
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (++reads > 1) return page([{ ...row, title: "Newer page" }]);
    const response = Response.json({}, { status: 409 });
    response.json = () => late.promise;
    return response;
  });
  const first = controller.connect();
  await new Promise(resolve => setImmediate(resolve));
  await controller.apply({ ...controller.getSnapshot().filters, q: "Newer" });
  late.resolve({ error: { code: "ACCOUNT_CHANGED" } }); await first;
  assert.equal(controller.getSnapshot().status, "ready");
  assert.equal(controller.getSnapshot().page?.items[0]?.title, "Newer page");
});

test("a restore server error is an unconfirmed write, not a successful local removal or an automatically replayed request", async () => {
  const trash = { ...row, deletedAt: row.updatedAt }; let posts = 0;
  const controller = new CatalogueController(async (url, init) => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (init?.method === "POST") { posts++; return Response.json({}, { status: 503 }); }
    return page([trash]);
  });
  await controller.connect(); await controller.apply({ ...controller.getSnapshot().filters, scope: "trash" });
  controller.toggle(trash); controller.requestRestore(trash); await controller.confirmRestore();
  assert.match(controller.getSnapshot().error, /还原.*确认/);
  assert.equal(controller.getSnapshot().selected.length, 1);
  assert.equal(controller.getSnapshot().page?.items.length, 1);
  await controller.refresh(); assert.equal(posts, 1);
});

test("changing criteria during a waiting period clears the old page instead of labelling active rows as trash", async () => {
  let limited = false;
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    return limited ? Response.json({}, { status: 429, headers: { "retry-after": "5" } }) : page();
  }, () => 1000);
  await controller.connect(); limited = true; await controller.refresh();
  await controller.apply({ ...controller.getSnapshot().filters, scope: "trash" });
  assert.equal(controller.getSnapshot().page, null);
  assert.equal(controller.getSnapshot().filters.scope, "trash");
});

test("focus-time identity checks preserve same-account selection but synchronously erase it after an account change", async () => {
  let actor = "author-a";
  const controller = new CatalogueController(async url => url.endsWith("/session") ? Response.json({ data: { id: actor } }) : page());
  await controller.connect(); controller.toggle(row);
  await controller.verifyAccount(); assert.equal(controller.getSnapshot().selected.length, 1);
  actor = "author-b"; await controller.verifyAccount();
  assert.equal(controller.getSnapshot().status, "account-changed");
  assert.equal(controller.getSnapshot().page, null);
  assert.equal(controller.getSnapshot().selected.length, 0);
});

test("page suspension clears private snapshots and invalidates both a pending read and its identity probe", async () => {
  let delayed = false;
  const late = deferred<Response>();
  const controller = new CatalogueController(async url => url.endsWith("/session") ? delayed ? late.promise : Response.json({ data: { id: "author-a" } }) : page());
  await controller.connect(); controller.toggle(row); delayed = true;
  const probe = controller.verifyAccount(); controller.suspend();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.actor, null); assert.equal(snapshot.page, null);
  assert.equal(snapshot.filters.q, ""); assert.equal(snapshot.selected.length, 0);
  late.resolve(Response.json({ data: { id: "author-a" } })); await probe;
  assert.equal(controller.getSnapshot(), snapshot);
});

test("complete-language inspection ignores filtered page coverage and discards late bodies after closing or changing filters", async () => {
  const body = deferred<unknown>(); const requested: string[] = [];
  const controller = new CatalogueController(async (url, init) => {
    requested.push(url);
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (url.includes("/editions")) {
      assert.equal(new Headers(init?.headers).get("x-expected-author"), "author-a");
      assert.equal(init?.cache, "no-store");
      const response = Response.json({}); response.json = () => body.promise; return response;
    }
    return page();
  });
  await controller.connect(); await controller.apply({ ...controller.getSnapshot().filters, locale: "en" });
  const first = controller.inspect(row); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.at(-1), `/api/authoring/catalogue/${row.id}/editions?scope=active`);
  controller.closeInspection(); body.resolve({ data: [row, { ...row, locale: "zh-CN" }] }); await first;
  assert.equal(controller.getSnapshot().inspection, null);
  await controller.inspect(row);
  assert.equal(controller.getSnapshot().inspection?.editions.length, 2);
  await controller.apply({ ...controller.getSnapshot().filters, q: "One" });
  assert.equal(controller.getSnapshot().inspection, null);
});

test("inspection refuses malformed/foreign editions, keeps 404 uncertainty and clears all private state for an account refusal", async () => {
  let mode = "missing";
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) return Response.json({ data: { id: "author-a" } });
    if (!url.includes("/editions")) return page();
    if (mode === "missing") return Response.json({}, { status: 404 });
    if (mode === "foreign") return Response.json({ data: [{ ...row, id: "a13dbadf-0000-4000-8000-000000000002" }] });
    return Response.json({ error: { code: "ACCOUNT_CHANGED" } }, { status: 409 });
  });
  await controller.connect(); controller.toggle(row);
  await controller.inspect(row);
  assert.equal(controller.getSnapshot().status, "ready");
  assert.equal(controller.getSnapshot().inspection?.status, "failed");
  assert.match(controller.getSnapshot().inspection?.error ?? "", /可能/);
  mode = "foreign"; await controller.inspect(row);
  assert.equal(controller.getSnapshot().inspection?.editions.length, 0);
  assert.equal(controller.getSnapshot().selected.length, 1);
  mode = "changed"; await controller.inspect(row);
  assert.equal(controller.getSnapshot().status, "account-changed");
  assert.equal(controller.getSnapshot().inspection, null);
  assert.equal(controller.getSnapshot().page, null); assert.equal(controller.getSnapshot().selected.length, 0);
});

test("CSV download checks the actual current session even without focus and never releases another account's selected snapshot", async () => {
  let actor = "author-a", probes = 0;
  const controller = new CatalogueController(async url => {
    if (url.endsWith("/session")) { probes++; return Response.json({ data: { id: actor } }); }
    return page();
  });
  await controller.connect(); controller.toggle(row);
  const { catalogueSelectionFingerprint } = await import("./authoring-catalogue-review.ts");
  const fingerprint = catalogueSelectionFingerprint(controller.getSnapshot().selected);
  assert.equal(await controller.authorizeExport("author-a", fingerprint), true);
  actor = "author-b";
  assert.equal(await controller.authorizeExport("author-a", fingerprint), false);
  assert.equal(probes, 3);
  assert.equal(controller.getSnapshot().page, null);
  assert.deepEqual(controller.getSnapshot().selected, []);
});

test("an export's session response cannot authorize a changed selection, disconnected view, pending identity probe or unverified session failure", async () => {
  for (const boundary of ["selection", "disconnect", "pending", "failed"]) {
    const late = deferred<Response>(); let delayed = false;
    const controller = new CatalogueController(async url => {
      if (url.endsWith("/session")) return delayed ? late.promise : Response.json({ data: { id: "author-a" } });
      return page();
    });
    await controller.connect(); controller.toggle(row); delayed = true;
    const { catalogueSelectionFingerprint } = await import("./authoring-catalogue-review.ts");
    const fingerprint = catalogueSelectionFingerprint(controller.getSnapshot().selected);
    const probe = boundary === "pending" ? controller.verifyAccount() : null;
    const pending = controller.authorizeExport("author-a", fingerprint);
    if (boundary === "selection") { controller.clearSelection(); controller.toggle(row); }
    if (boundary === "disconnect") controller.disconnect();
    late.resolve(boundary === "failed" ? Response.json({}, { status: 503 }) : Response.json({ data: { id: "author-a" } }));
    assert.equal(await pending, false, boundary);
    await probe;
  }
});
