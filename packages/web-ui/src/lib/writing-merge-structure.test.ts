import assert from "node:assert/strict";
import { test } from "node:test";
import type { WritingMergeUnit } from "./writing-merge.ts";
import { inspectWritingMergeStructure } from "./writing-merge-structure.ts";
const unit = (
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): WritingMergeUnit => ({
  id: "body:0:1",
  kind: "body",
  start: 0,
  end: 1,
  status: "current",
  recommended: "current",
  reason: "exact",
  values: { base: before, current: after, incoming: before },
});

test("structural review exposes format and link targets even when visible text is identical", () => {
  const base = [
    {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "https://before.test/private",
          children: [{ type: "text", text: "相同文字", format: 0 }],
        },
      ],
    },
  ];
  const current = structuredClone(base);
  current[0]!.children[0]!.url = "https://after.test/private";
  current[0]!.children[0]!.children[0]!.format = 2;
  const result = inspectWritingMergeStructure(unit(base, current), "current");
  assert.equal(result.limited, false);
  assert.ok(
    result.changes.some(
      (change) =>
        change.path === "$/0/children/0/url" &&
        change.before.includes("before.test") &&
        change.after.includes("after.test"),
    ),
  );
  assert.ok(
    result.changes.some(
      (change) =>
        change.path === "$/0/children/0/children/0/format" &&
        change.before === "0" &&
        change.after === "2",
    ),
  );
});

test("missing, null, scalar type and array-length changes stay distinct without guessed index edits", () => {
  const source = unit(
    [{ type: "paragraph", children: [], direction: null, indent: 0 }],
    [
      {
        type: "paragraph",
        children: [{ type: "text", text: "新内容" }],
        indent: "0",
      },
    ],
  );
  const result = inspectWritingMergeStructure(source, "current");
  assert.ok(
    result.changes.some(
      (change) => change.path === "$/0/direction" && change.afterMissing,
    ),
  );
  assert.ok(
    result.changes.some(
      (change) => change.path === "$/0/indent" && change.kind === "type",
    ),
  );
  assert.ok(
    result.changes.some(
      (change) =>
        change.path === "$/0/children" && change.kind === "array-length",
    ),
  );
  assert.ok(
    !result.changes.some((change) => change.path.startsWith("$/0/children/")),
  );
});

test("diagnostic budgets are visible and do not read an entire large candidate or claim equality", () => {
  const before = Array.from({ length: 5000 }, (_, index) => ({
    text: `相同${index}`,
  }));
  const after = structuredClone(before);
  after.at(-1)!.text = "末尾不同";
  const result = inspectWritingMergeStructure(unit(before, after), "current");
  assert.equal(result.limited, true);
  assert.ok(result.visited <= 4096);
  const many = inspectWritingMergeStructure(
    unit(
      before.slice(0, 100),
      after.slice(0, 100).map((node) => ({ ...node, text: "不同" })),
    ),
    "current",
  );
  assert.equal(many.limited, true);
  assert.equal(many.changes.length, 40);
});

test("opaque duplicate/move conflicts never acquire misleading positional matches, and values remain literal", () => {
  const source = unit(
    [{ text: "<img src=x onerror=alert(1)>" }],
    [{ text: "<script>inert</script>" }],
  );
  const before = structuredClone(source);
  const result = inspectWritingMergeStructure(source, "current");
  assert.ok(result.changes[0]!.after.includes("<script>"));
  assert.deepEqual(source, before);
  source.reason = "ambiguous-order";
  assert.deepEqual(inspectWritingMergeStructure(source, "current").changes, []);
  assert.equal(inspectWritingMergeStructure(source, "current").ambiguous, true);
});

test("a very long scalar produces an explicit truncated excerpt, not a silently shortened value", () => {
  const source: WritingMergeUnit = {
    id: "field:summary",
    kind: "field",
    field: "summary",
    status: "current",
    recommended: "current",
    reason: "exact",
    values: {
      base: "原摘要",
      current: "文字".repeat(1000),
      incoming: "原摘要",
    },
  };
  const result = inspectWritingMergeStructure(source, "current");
  assert.equal(result.changes[0]!.truncated, true);
  assert.equal(source.values.current.length, 2000);
});
