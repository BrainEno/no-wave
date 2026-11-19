import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWritingBackup,
  parseWritingBackup,
  type WritingBackup,
} from "./writing-backup.ts";
import type { WritingDraft } from "./writing-session.ts";
import {
  analyzeWritingMerge,
  parseWritingMergeSource,
  prepareWritingMerge,
  validateWritingMergeDecisions,
  writingMergeProgress,
} from "./writing-merge.ts";

const now = new Date("2026-11-12T00:00:00.000Z");
function backup(
  texts: string[],
  fields: Partial<WritingDraft> = {},
): WritingBackup {
  return parseWritingBackup(
    createWritingBackup(
      {
        title: "标题",
        summary: "摘要",
        locale: "zh-CN",
        workType: "essay",
        editorState: {
          root: {
            type: "root",
            version: 1,
            children: texts.map((text) => ({
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text }],
            })),
          },
        },
        ...fields,
      },
      now,
    ),
  );
}
const sources = (
  base: WritingBackup,
  current: WritingBackup,
  incoming: WritingBackup,
) => ({ base, current, incoming });
const text = (value: WritingBackup) =>
  value.draft
    .editorState!.root.children.map((node) => JSON.stringify(node))
    .join("\n");

test("strict local merge input rejects duplicate escaped keys, unknown identity and unsafe nodes before accepting a source", () => {
  const valid = createWritingBackup(backup(["安全"]).draft, now);
  assert.throws(
    () =>
      parseWritingMergeSource(
        valid.replace(
          '"title": "标题"',
          '"title": "隐去的值", "ti\\u0074le": "标题"',
        ),
      ),
    /重复|歧义/,
  );
  assert.throws(
    () =>
      parseWritingMergeSource(
        valid.replace('"draft": {', '"actor": "untrusted", "draft": {'),
      ),
    /未知|结构/,
  );
  assert.throws(
    () => parseWritingMergeSource(valid.replace('"paragraph"', '"html"')),
    /未知|节点/,
  );
  assert.deepEqual(parseWritingMergeSource("\ufeff" + valid), backup(["安全"]));
});

test("disjoint edits, additions and metadata changes compose in base order without altering source objects", async () => {
  const input = sources(
    backup(["一", "二", "三", "四"]),
    backup(["当前一", "二", "三", "四"], { title: "当前标题" }),
    backup(["一", "二", "另一三", "四", "末尾新增"], { summary: "另一摘要" }),
  );
  const untouched = structuredClone(input);
  const analysis = await analyzeWritingMerge(input);
  assert.equal(writingMergeProgress(analysis, []).unresolved, 0);
  const prepared = await prepareWritingMerge(analysis, [], now);
  assert.equal(prepared.backup.draft.title, "当前标题");
  assert.equal(prepared.backup.draft.summary, "另一摘要");
  for (const value of ["当前一", "二", "另一三", "四", "末尾新增"])
    assert.ok(text(prepared.backup).includes(value));
  assert.deepEqual(input, untouched);
  assert.deepEqual(parseWritingBackup(prepared.text), prepared.backup);
});

test("same-block conflict cannot be downloaded until explicitly resolved, while untouched whitespace stays exact", async () => {
  const analysis = await analyzeWritingMerge(
    sources(
      backup(["  基线  ", "共同"]),
      backup(["  当前  ", "共同"]),
      backup(["  另一  ", "共同"]),
    ),
  );
  const conflict = analysis.units.find((unit) => unit.status === "conflict")!;
  assert.ok(conflict);
  assert.equal(writingMergeProgress(analysis, []).unresolved, 1);
  await assert.rejects(prepareWritingMerge(analysis, [], now), /冲突|取舍/);
  const prepared = await prepareWritingMerge(
    analysis,
    [{ unit: conflict.id, choice: "incoming" }],
    now,
  );
  assert.ok(text(prepared.backup).includes("  另一  "));
  assert.ok(!text(prepared.backup).includes("  当前  "));
});

test("equal concurrent changes agree, but title whitespace is not normalized away", async () => {
  const analysis = await analyzeWritingMerge(
    sources(
      backup(["正文"]),
      backup(["一起改"], { title: " 标题" }),
      backup(["一起改"], { title: "标题 " }),
    ),
  );
  assert.equal(
    analysis.units.find((unit) => unit.id === "field:title")?.status,
    "conflict",
  );
  assert.equal(
    analysis.units
      .filter((unit) => unit.kind === "body")
      .some((unit) => unit.status === "agreed"),
    true,
  );
});

test("duplicate paragraphs and reordered anchors produce one conservative whole-body conflict, never guessed pairings", async () => {
  for (const input of [
    sources(
      backup(["重复", "重复", "尾"]),
      backup(["修改重复", "重复", "尾"]),
      backup(["重复", "修改重复", "尾"]),
    ),
    sources(
      backup(["一", "二", "三"]),
      backup(["二", "一", "三"]),
      backup(["一", "二", "另一三"]),
    ),
  ]) {
    const analysis = await analyzeWritingMerge(input);
    const body = analysis.units.filter((unit) => unit.kind === "body");
    assert.equal(body.length, 1);
    assert.equal(body[0]!.status, "conflict");
    assert.equal(body[0]!.reason, "ambiguous-order");
    const result = await prepareWritingMerge(
      analysis,
      [{ unit: body[0]!.id, choice: "base" }],
      now,
    );
    assert.deepEqual(
      result.backup.draft.editorState,
      input.base.draft.editorState,
    );
  }
});

test("unilateral reorder or duplicate edit may be preserved whole when the other body is unchanged", async () => {
  const base = backup(["重复", "重复", "尾"]),
    current = backup(["尾", "重复", "修改"]);
  const analysis = await analyzeWritingMerge(sources(base, current, base));
  const result = await prepareWritingMerge(analysis, [], now);
  assert.deepEqual(result.backup.draft.editorState, current.draft.editorState);
});

test("insertions at the same gap and deletion-versus-edit require a decision; adjacent nonempty edits do not", async () => {
  const base = backup(["一", "二", "三"]);
  const simultaneous = await analyzeWritingMerge(
    sources(
      base,
      backup(["一", "当前新增", "二", "三"]),
      backup(["一", "另一新增", "二", "三"]),
    ),
  );
  assert.equal(writingMergeProgress(simultaneous, []).unresolved, 1);
  const deletion = await analyzeWritingMerge(
    sources(base, backup(["一", "三"]), backup(["一", "另一二", "三"])),
  );
  assert.equal(writingMergeProgress(deletion, []).unresolved, 1);
  const adjacent = await analyzeWritingMerge(
    sources(
      base,
      backup(["当前一", "二", "三"]),
      backup(["一", "另一二", "三"]),
    ),
  );
  assert.equal(writingMergeProgress(adjacent, []).unresolved, 0);
  const prepared = await prepareWritingMerge(adjacent, [], now);
  assert.ok(text(prepared.backup).includes("当前一"));
  assert.ok(text(prepared.backup).includes("另一二"));
});

test("an insertion touching a replaced interval stays a conflict rather than inventing an order", async () => {
  const analysis = await analyzeWritingMerge(
    sources(
      backup(["一", "二"]),
      backup(["当前一", "二"]),
      backup(["一", "新增", "二"]),
    ),
  );
  assert.equal(writingMergeProgress(analysis, []).unresolved, 1);
});

test("format-only, link-target and root-layout changes are compared losslessly", async () => {
  const base = backup(["相同文字"]),
    current = structuredClone(base),
    incoming = structuredClone(base);
  const currentText = current.draft.editorState!.root.children[0]!
    .children as Record<string, unknown>[];
  currentText[0]!.format = 1;
  const incomingBlock = incoming.draft.editorState!.root.children[0]!;
  incomingBlock.children = [
    {
      type: "link",
      version: 1,
      url: "https://example.test/private",
      children: [{ type: "text", version: 1, text: "相同文字" }],
    },
  ];
  current.draft.editorState!.root.direction = "ltr";
  const analysis = await analyzeWritingMerge(sources(base, current, incoming));
  assert.equal(writingMergeProgress(analysis, []).unresolved, 1);
  assert.equal(
    analysis.units.find((unit) => unit.kind === "root")?.status,
    "current",
  );
  const body = analysis.units.find(
    (unit) => unit.kind === "body" && unit.status === "conflict",
  )!;
  const prepared = await prepareWritingMerge(
    analysis,
    [{ unit: body.id, choice: "incoming" }],
    now,
  );
  assert.ok(text(prepared.backup).includes("https://example.test/private"));
  assert.equal(prepared.backup.draft.editorState!.root.direction, "ltr");
});

test("object property order is not a content change, and analysis witnesses include source role and backup timestamp", async () => {
  const base = backup(["正文"]),
    reordered = JSON.parse(
      JSON.stringify(
        base,
        Object.keys({
          draft: 1,
          format: 1,
          version: 1,
          createdAt: 1,
          root: 1,
          children: 1,
          type: 1,
          text: 1,
          title: 1,
          summary: 1,
          locale: 1,
          workType: 1,
          editorState: 1,
        }),
      ),
    ) as WritingBackup;
  const analysis = await analyzeWritingMerge(sources(base, reordered, base));
  assert.ok(analysis.units.every((unit) => unit.status === "same"));
  const changed = structuredClone(base);
  changed.createdAt = "2026-11-12T01:00:00.000Z";
  assert.notEqual(
    (await analyzeWritingMerge(sources(changed, base, base))).key,
    analysis.key,
  );
  assert.notEqual(
    (await analyzeWritingMerge(sources(base, changed, base))).key,
    (await analyzeWritingMerge(sources(changed, base, base))).key,
  );
});

test("unknown, duplicate and prototype-shaped decisions are rejected atomically", async () => {
  const analysis = await analyzeWritingMerge(
    sources(backup(["一"]), backup(["二"]), backup(["三"])),
  );
  assert.throws(
    () =>
      validateWritingMergeDecisions(analysis, [
        { unit: "not-present", choice: "current" },
      ]),
    /取舍|条目/,
  );
  const choice = { unit: analysis.units[0]!.id, choice: "base" };
  assert.throws(
    () => validateWritingMergeDecisions(analysis, [choice, choice]),
    /重复/,
  );
  assert.throws(
    () =>
      validateWritingMergeDecisions(analysis, [{ ...choice, actor: "fake" }]),
    /字段|结构/,
  );
  assert.throws(
    () =>
      validateWritingMergeDecisions(analysis, [
        { unit: "__proto__", choice: "incoming" },
      ]),
    /取舍|条目/,
  );
});

test("combined output is fully revalidated and never truncated to the 200-block budget", async () => {
  const blocks = Array.from({ length: 199 }, (_, index) => `独立块${index}`);
  const analysis = await analyzeWritingMerge(
    sources(
      backup(blocks),
      backup(["开头新增", ...blocks]),
      backup([...blocks, "结尾新增"]),
    ),
  );
  assert.equal(writingMergeProgress(analysis, []).unresolved, 0);
  await assert.rejects(prepareWritingMerge(analysis, [], now), /200|内容块/);
});

test("analysis and preparation cancellation never publish a partial candidate", async () => {
  const abort = new AbortController();
  abort.abort();
  const input = sources(backup(["一"]), backup(["二"]), backup(["三"]));
  await assert.rejects(analyzeWritingMerge(input, abort.signal), {
    name: "AbortError",
  });
  const live = new AbortController();
  await assert.rejects(
    analyzeWritingMerge(input, live.signal, async () => {
      live.abort();
    }),
    { name: "AbortError" },
  );
  const analysis = await analyzeWritingMerge(input);
  const decisions = analysis.units
    .filter((unit) => unit.status === "conflict")
    .map((unit) => ({ unit: unit.id, choice: "base" as const }));
  await assert.rejects(
    prepareWritingMerge(analysis, decisions, now, abort.signal),
    { name: "AbortError" },
  );
});
