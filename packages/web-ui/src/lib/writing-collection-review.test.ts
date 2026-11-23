import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection } from "./writing-collection.ts";
import { collectionRows, compareCollectionPair, type CollectionSource } from "./writing-collection-index.ts";
import { createCollectionReviewPlan, previewCollectionReviewPlan, buildCollectionReviewReport, collectionReviewReportDownload } from "./writing-collection-review.ts";

const now = new Date("2026-11-12T00:00:00.000Z");
async function sources(): Promise<CollectionSource[]> {
  const backup = parseWritingBackup(createWritingBackup({ title: "=PRIVATE_TITLE()", summary: "PRIVATE_SUMMARY", locale: "en", workType: "other", editorState: { root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1, children: [{ type: "text", version: 1, text: "PRIVATE_BODY" }] }] } } }, now));
  const prepared = await createWritingCollection([{ group: "work", backup }], now);
  return ["left", "right"].map(slot => ({ slot: slot as "left" | "right", name: "=PRIVATE_FILE()\u0000.json", opened: { source: "collection", prepared } }));
}
const pair = { left: "left:d1", right: "right:d1" };

test("review plans contain only file-local witnesses; verify before preview and refuse replaced files, unknown fields and digest damage", async () => {
  const input = await sources();
  const built = await createCollectionReviewPlan(input, ["right:d1"], [pair], now);
  assert.doesNotMatch(built.text, /PRIVATE|title|summary|name|authorId|revision|token/);
  const preview = await previewCollectionReviewPlan(built.text, input);
  assert.deepEqual(preview.plan.selected, ["right:d1"]);
  assert.deepEqual(preview.plan.pairs, [pair]);
  const mutated = JSON.parse(built.text); mutated.selected = ["left:d1"];
  await assert.rejects(previewCollectionReviewPlan(JSON.stringify(mutated), input), /摘要/);
  await assert.rejects(previewCollectionReviewPlan(built.text, input.slice(0, 1)), /来源|文件/);
  await assert.rejects(previewCollectionReviewPlan(built.text.replace('"version":1', '"version":2'), input));
  await assert.rejects(previewCollectionReviewPlan(built.text.replace('"version":1', '"version":1,"token":"hidden"'), input));
  await assert.rejects(previewCollectionReviewPlan('{"__proto__":{}}', input));
  await assert.rejects(previewCollectionReviewPlan(" ".repeat(65537), input), /64 KiB/);
  await assert.rejects(createCollectionReviewPlan(input, ["left:missing"], [], now));
  await assert.rejects(createCollectionReviewPlan(input, [], [pair, pair], now));
  await assert.rejects(createCollectionReviewPlan(input, [], [], now));
});

test("reports distinguish unchecked from equivalent/different, carry partial-statistic warnings, and exclude content by construction", async () => {
  const input = await sources(), rows = collectionRows(input);
  const empty = buildCollectionReviewReport(input, [pair], [], "idle", false, now);
  assert.equal(empty.pairs[0]?.state, "unchecked");
  assert.equal(empty.status, "not-started");
  const result = compareCollectionPair(rows, pair);
  const complete = buildCollectionReviewReport(input, [pair], [result], "complete", false, now);
  assert.equal(complete.pairs[0]?.state, "equivalent");
  assert.equal(complete.documents[0]?.statistics.characters, 12);
  const text = collectionReviewReportDownload(complete, "json").text;
  assert.doesNotMatch(text, /PRIVATE|title|summary|name|https:|token|authorId/);
  result.comparison.rows[0]!.difference.truncated = true;
  const partial = buildCollectionReviewReport(input, [pair], [result], "cancelled", false, now);
  assert.equal(partial.pairs[0]?.limited, true);
  assert.equal(partial.status, "partial");
  assert.throws(() => buildCollectionReviewReport(input.slice(0, 1), [], [result], "complete", false, now), /变化|配对/);
  assert.throws(() => buildCollectionReviewReport(input, [pair], [], "complete", false, now), /完整|完成/);
  assert.throws(() => buildCollectionReviewReport(input, [pair], [result, result], "cancelled", false, now));
  assert.throws(() => buildCollectionReviewReport(input, [pair], [], "running", false, now), /运行|停止/);
});

test("optional names require an explicit choice; report CSV protects formula/control cells without including manuscript excerpts", async () => {
  const report = buildCollectionReviewReport(await sources(), [pair], [], "idle", true, now);
  const csv = collectionReviewReportDownload(report, "csv").text;
  assert.match(csv, /'=PRIVATE_TITLE\(\)/);
  assert.match(csv, /'=PRIVATE_FILE\(\)\.json/);
  assert.doesNotMatch(csv, /PRIVATE_BODY|PRIVATE_SUMMARY|\u0000/);
  assert.match(csv, /unchecked/);
  assert.equal(collectionReviewReportDownload(report, "csv").mime, "text/csv;charset=utf-8");
});

test("handoff reports retain bounded content-free changed-block positions, complete coverage and issue counts in both JSON and CSV", async () => {
  const input = await sources();
  const changed = structuredClone(input[1]!.opened.prepared.collection.entries[0]!.backup);
  changed.draft.title = "=PRIVATE_CHANGED()";
  changed.draft.editorState!.root.children = [
    { type: "paragraph", version: 1, children: [{ type: "text", version: 1, text: "PRIVATE_CHANGED_BODY" }] },
    { type: "image", version: 1, src: "https://example.test/private.png", alt: "" },
    { type: "code", version: 1, language: "plain", children: [{ type: "text", version: 1, text: "PRIVATE_CODE" }] },
  ];
  input[1]!.opened = { source: "collection", prepared: await createWritingCollection([{ group: "right", backup: changed }], now) };
  const result = compareCollectionPair(collectionRows(input), pair);
  const report = buildCollectionReviewReport(input, [pair], [result], "complete", false, now);
  const serialized = collectionReviewReportDownload(report, "json").text;
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.coverage, { documents: 2, pairs: 1, checkedPairs: 1, uncheckedPairs: 0, unpairedDocuments: 0, limitedDocuments: 0, limitedPairs: 0 });
  assert.ok(parsed.pairs[0].changes.length > 0);
  assert.deepEqual(parsed.pairs[0].changes[0], { kind: "changed", leftBlock: 1, rightBlock: 1, formatChanged: false, truncated: false });
  assert.ok(parsed.pairs[0].changes.every((change: { kind: string }) => change.kind !== "same"));
  assert.equal(parsed.documents[1].issues["image-alt"], 1);
  const csv = collectionReviewReportDownload(report, "csv").text;
  for (const field of ["coverage", "checkedPairs", "uncheckedPairs", "limitedDocuments", "codeBlocks", "minutes", "entries", "image-alt", "block", "leftBlock", "rightBlock", "formatChanged"]) assert.ok(csv.includes(`"${field}"`), `CSV must preserve ${field}`);
  assert.doesNotMatch(serialized + csv, /PRIVATE|example\.test|summary|url|inserted|removedText/);
  const idle = JSON.parse(collectionReviewReportDownload(buildCollectionReviewReport(input, [pair], [], "idle", false, now), "json").text);
  assert.equal(idle.coverage.uncheckedPairs, 1);
  assert.deepEqual(idle.pairs[0].changes, []);
  result.comparison.rows[0]!.difference.truncated = true;
  const bounded = JSON.parse(collectionReviewReportDownload(buildCollectionReviewReport(input, [pair], [result], "cancelled", false, now), "json").text);
  assert.equal(bounded.coverage.limitedPairs, 1);
  assert.equal(bounded.pairs[0].changes[0].truncated, true);
});

test("review plan previews reject repeated or escaped duplicate field names instead of accepting the parser's last value", async () => {
  const input = await sources();
  const built = await createCollectionReviewPlan(input, ["left:d1"], [], now);
  await assert.rejects(previewCollectionReviewPlan(built.text.replace('"version":1', '"version":2,"\\u0076ersion":1'), input), /重复|歧义/);
});
