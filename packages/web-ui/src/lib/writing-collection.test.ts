import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import type { WritingDraft } from "./writing-session.ts";
import { COLLECTION_BYTE_LIMIT, COLLECTION_DOCUMENT_LIMIT, createWritingCollection, parseWritingCollection, openWritingCollection } from "./writing-collection.ts";
const now = new Date("2026-11-01T00:00:00.000Z");
const draft = (title = "中文文稿", locale = "zh-CN"): WritingDraft => ({ title, summary: "摘要", locale, workType: "essay", editorState: { root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1, children: [{ type: "text", version: 1, text: "正文 👩‍💻", format: 0 }] }] } } });
const backup = (title?: string, locale?: string) => parseWritingBackup(createWritingBackup(draft(title, locale), now));
const inputs = () => [{ group: "server-work-id-must-not-escape", backup: backup() }, { group: "server-work-id-must-not-escape", backup: backup("English", "en") }, { group: "another-server-work", backup: backup("第二篇") }];

test("a collection round trips exact verified drafts and only local keys/groups, not server identity or save credentials", async () => {
  const result = await createWritingCollection(inputs(), now);
  assert.equal(result.bytes, new TextEncoder().encode(result.text).byteLength);
  assert.equal(result.collection.entries.length, 3);
  assert.deepEqual(result.collection.entries.map(entry => [entry.key, entry.group]), [["d1", "w1"], ["d2", "w1"], ["d3", "w2"]]);
  assert.doesNotMatch(result.text, /server-work|another-server|revision|authorId|idempotency|contentBlocks/);
  const parsed = await parseWritingCollection("\ufeff" + result.text);
  assert.deepEqual(parsed.collection, result.collection);
  assert.deepEqual(parsed.collection.entries[0]!.backup.draft, backup().draft);
  assert.match(result.collection.digest, /^[a-f0-9]{64}$/);
});

test("integrity ignores JSON whitespace/object key order but covers text, per-file membership, group and entry order", async () => {
  const original = await createWritingCollection(inputs(), now);
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  assert.equal((await parseWritingCollection(JSON.stringify(reverseKeys(original.collection), null, 2))).collection.digest, original.collection.digest);
  for (const mutate of [
    (value: typeof original.collection) => { value.entries[0]!.backup.draft.title = "changed"; },
    (value: typeof original.collection) => { value.entries.reverse(); },
    (value: typeof original.collection) => { value.entries[0]!.group = "w3"; },
    (value: typeof original.collection) => { value.entries.pop(); },
    (value: typeof original.collection) => { value.createdAt = "2026-11-02T00:00:00.000Z"; },
  ]) { const value = structuredClone(original.collection); mutate(value); await assert.rejects(parseWritingCollection(JSON.stringify(value)), /校验/); }
});

test("unknown envelopes, unsafe fields, duplicate identities/languages and invalid timestamps are rejected, never partly loaded", async () => {
  const result = await createWritingCollection(inputs(), now);
  for (const patch of [ { version: 2 }, { authorId: "forged" }, { createdAt: "2026-02-30T00:00:00.000Z" }, { entries: [] }, { digest: "f".repeat(64) } ]) await assert.rejects(parseWritingCollection(JSON.stringify({ ...result.collection, ...patch })));
  for (const mutate of [
    (value: typeof result.collection) => { value.entries[1]!.key = value.entries[0]!.key; },
    (value: typeof result.collection) => { value.entries[1]!.backup.draft.locale = "zh-CN"; },
    (value: typeof result.collection) => { Object.assign(value.entries[0]!.backup.draft, { revision: "999" }); },
    (value: typeof result.collection) => { value.entries[0]!.backup.draft.editorState!.root.children[0] = { type: "image", version: 1, src: "javascript:alert(1)", alt: "x" }; },
  ]) { const value = structuredClone(result.collection); mutate(value); await assert.rejects(parseWritingCollection(JSON.stringify(value))); }
  await assert.rejects(parseWritingCollection('{"__proto__": {"polluted":true}}'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("document, byte and existing per-draft limits are enforced without silent clipping", async () => {
  await assert.rejects(createWritingCollection([]));
  await assert.rejects(createWritingCollection(Array.from({ length: COLLECTION_DOCUMENT_LIMIT + 1 }, (_, index) => ({ group: String(index), backup: backup(String(index)) }))));
  await assert.rejects(createWritingCollection([{ group: "same", backup: backup() }, { group: "same", backup: backup("another") }]), /语言/);
  const over = inputs(); over[0]!.backup.draft.summary = "x".repeat(2001); await assert.rejects(createWritingCollection(over));
  await assert.rejects(parseWritingCollection(" ".repeat(COLLECTION_BYTE_LIMIT + 1)), /16 MiB/);
  await assert.rejects(parseWritingCollection(" ".repeat(COLLECTION_BYTE_LIMIT / 2) + "汉".repeat(COLLECTION_BYTE_LIMIT / 3)), /16 MiB/);
});

test("legacy single backups remain structure-only inputs, and aborting integrity work never publishes a prepared file", async () => {
  const opened = await openWritingCollection(createWritingBackup(draft(), now));
  assert.equal(opened.source, "single");
  assert.equal(opened.prepared.collection.entries.length, 1);
  const collection = await openWritingCollection(opened.prepared.text);
  assert.equal(collection.source, "collection");
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(createWritingCollection(inputs(), now, cancellation.signal), { name: "AbortError" });
  await assert.rejects(parseWritingCollection(opened.prepared.text, cancellation.signal), { name: "AbortError" });
  await assert.rejects(openWritingCollection('{"format":"foreign"}'));
});

test("ambiguous duplicate JSON fields, including escaped spellings, are rejected before checksum normalization can hide them", async () => {
  const collection = await createWritingCollection(inputs(), now);
  const changed = collection.text.replace('"version":1', '"version":2,"version":1');
  await assert.rejects(parseWritingCollection(changed), /重复|歧义/);
  const escaped = collection.text.replace('"title":"中文文稿"', '"title":"uncovered private data","\\u0074itle":"中文文稿"');
  await assert.rejects(parseWritingCollection(escaped), /重复|歧义/);
  const single = createWritingBackup(draft(), now).replace('"summary": "摘要"', '"summary": "hidden", "summary": "摘要"');
  await assert.rejects(openWritingCollection(single), /重复|歧义/);
  const nested = "[".repeat(100) + "0" + "]".repeat(100);
  await assert.rejects(parseWritingCollection(nested), /层|深/);
  const special = backup('quotes " : { brackets } \\ and braces [ ]');
  special.draft.summary = 'repeated words "key":1,"key":2 remain literal text';
  const valid = await createWritingCollection([{ group: "literal", backup: special }], now);
  assert.equal((await parseWritingCollection(valid.text)).collection.entries[0]!.backup.draft.summary, special.draft.summary);
});
