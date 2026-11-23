import assert from "node:assert/strict";
import test from "node:test";
import { CatalogueDocumentReader } from "./authoring-catalogue-open.ts";
import { canLeaveWriting } from "./writing-session.ts";
const intent = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", actor: "author-a" };
const article = { id: intent.id, authorId: intent.actor, locale: "en", slug: "one", title: "One", summary: "", workType: "other", status: "draft", revision: "23", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", publishedAt: null, contentBlocksVersion: 0, contentBlocks: [{ type: "paragraph", text: "Private body" }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("catalogue document reads are exact account/id/language intents and preserve the revision used for later saves", async () => {
  const reader = new CatalogueDocumentReader(async (url, init) => {
    assert.equal(url, `/api/authoring/catalogue/${intent.id}?locale=en`);
    assert.equal(new Headers(init?.headers).get("x-expected-author"), "author-a");
    assert.equal(init?.cache, "no-store");
    return Response.json({ data: article });
  });
  const loaded = await reader.read(intent, () => true);
  assert.equal(loaded?.revision, "23");
  assert.equal(loaded?.contentBlocks.length, 1);
  for (const patch of [{ id: "a13dbadf-0000-4000-8000-000000000002" }, { locale: "zh-CN" }, { authorId: "author-b" }, { revision: "90071992547409930000" }, { contentBlocks: null }]) {
    const invalid = new CatalogueDocumentReader(async () => Response.json({ data: { ...article, ...patch } }));
    await assert.rejects(() => invalid.read(intent, () => true));
  }
});

test("newer editor intent, further typing or pending create invalidates an uncooperative late detail response", async () => {
  for (const changed of ["key", "revision", "pending", "cancel"]) {
    const late = deferred<Response>();
    const reader = new CatalogueDocumentReader(async () => late.promise);
    let key = "new-1", revision = 1, pending = false;
    const token = { editorKey: key, revision };
    const running = reader.read(intent, () => canLeaveWriting(token, key, { dirty: true, revision }, pending));
    if (changed === "key") key = "new-2";
    if (changed === "revision") revision++;
    if (changed === "pending") pending = true;
    if (changed === "cancel") reader.cancel();
    late.resolve(Response.json({ data: article }));
    assert.equal(await running, null, changed);
  }
});

test("late error JSON is ignored too, while an active account refusal never silently opens another account", async () => {
  const late = deferred<unknown>();
  const response = Response.json({}, { status: 409 }); response.json = () => late.promise;
  const reader = new CatalogueDocumentReader(async () => response);
  const first = reader.read(intent, () => true);
  await new Promise(resolve => setImmediate(resolve)); reader.cancel();
  late.resolve({ error: { code: "ACCOUNT_CHANGED" } });
  assert.equal(await first, null);
  const refused = new CatalogueDocumentReader(async () => Response.json({ error: { code: "ACCOUNT_CHANGED" } }, { status: 409 }));
  await assert.rejects(() => refused.read(intent, () => true), /账户/);
});
