import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorIn,
  characterCount,
  findPassage,
  NOTE_LIMIT,
  parsePassages,
  passageExcerpt,
  passageStorageKey,
  PASSAGES_PER_WORK,
  PASSAGE_LIMIT,
  relocate,
  removePassage,
  upsertPassage,
  type Passage,
} from "./passages.ts";

const SOURCE = "那年冬天，渡口的船停了。河面很静，静得能听见冰。第二年的春天，船又开了。";

/** One saved passage, with a fixed clock so the ids and times are predictable. */
function save(note = "", at = 1_700_000_000_000): { passages: Passage[]; passage: Passage } {
  const anchor = anchorIn(SOURCE, 13, 24);
  const { passages, passage } = upsertPassage([], anchor, note, at);
  assert.ok(passage, "a fresh anchor is always saved");
  return { passages, passage };
}

test("字符数按读者看到的计算", () => {
  assert.equal(characterCount("河面很静"), 4);
  assert.equal(characterCount("👨‍👩‍👧"), Array.from("👨‍👩‍👧").length);
});

test("锚点记下两侧的原文，以便作品改动后还能找到", () => {
  const anchor = anchorIn(SOURCE, 13, 24);
  assert.equal(anchor.text, SOURCE.slice(13, 24));
  assert.equal(anchor.prefix, SOURCE.slice(0, 13));
  assert.equal(anchor.suffix, SOURCE.slice(24, 24 + 48));
  assert.equal(anchorIn(SOURCE, 0, 5).prefix, "");
});

test("存储键按作品分开", () => {
  assert.equal(passageStorageKey("a-work"), "nw-passages-v1:a-work");
  assert.notEqual(passageStorageKey("a"), passageStorageKey("b"));
});

test("坏数据读成空架子，而不是猜一个出来", () => {
  assert.deepEqual(parsePassages(null), []);
  assert.deepEqual(parsePassages(""), []);
  assert.deepEqual(parsePassages("not json {"), []);
  assert.deepEqual(parsePassages('{"not":"an array"}'), []);
  assert.deepEqual(parsePassages("[1, null, {}, \"x\"]"), []);
  assert.deepEqual(parsePassages(JSON.stringify([{ id: "a", start: 0, end: -1, text: "x", note: "" }])), []);
  // A note that is not a string is a mark without words beside it, not a broken entry.
  const normalized = parsePassages(JSON.stringify([{ id: "a", start: 0, end: 4, text: "x", note: 42 }]));
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.note, "");
});

test("超出长度与被截断的笔记不会被读进来", () => {
  const tooLong = JSON.stringify([{ id: "a", start: 0, end: 2, text: "x".repeat(PASSAGE_LIMIT + 1), note: "" }]);
  assert.deepEqual(parsePassages(tooLong), []);
  const longNote = JSON.stringify([{ id: "a", start: 0, end: 2, text: "xy", note: "n".repeat(NOTE_LIMIT + 1) }]);
  assert.deepEqual(parsePassages(longNote), []);
});

test("读入的条目补齐缺失的上下文与时间，并限制条数", () => {
  const many = Array.from({ length: PASSAGES_PER_WORK + 5 }, (_unused, index) => ({ id: `p${index}`, start: 0, end: 2, text: "xy", note: "" }));
  assert.equal(parsePassages(JSON.stringify(many)).length, PASSAGES_PER_WORK);
  const [first] = parsePassages(JSON.stringify([{ id: "a", start: 0, end: 2, text: "xy" }]));
  assert.equal(first?.prefix, "");
  assert.equal(first?.suffix, "");
  assert.equal(first?.note, "");
  assert.equal(first?.createdAt, 0);
});

test("同一段只记一次：改的是笔记，不是再划一条", () => {
  const { passages, passage } = save("第一句批注");
  const again = upsertPassage(passages, anchorIn(SOURCE, 13, 24), "改过的批注", 1_700_000_001_000);
  assert.equal(again.passages.length, 1);
  assert.equal(again.passage?.id, passage.id);
  assert.equal(again.passage?.note, "改过的批注");
  assert.equal(again.passage?.updatedAt, 1_700_000_001_000);
  assert.equal(again.passage?.createdAt, 1_700_000_000_000);
});

test("作品改动后，同样的文字靠上下文重新定位", () => {
  const { passage } = save();
  // The same sentence, moved: the offsets are stale, the words are not.
  const edited = `开头加了一句。${SOURCE}`;
  const moved = relocate(passage, edited);
  assert.deepEqual(moved, { start: edited.indexOf(passage.text), end: edited.indexOf(passage.text) + passage.text.length });
  assert.equal(edited.slice(moved.start, moved.end), passage.text);
});

test("文字重复出现时选上下文吻合的那一处", () => {
  const repeated = `${SOURCE}${SOURCE}`;
  const anchor = anchorIn(repeated, 13, 24);
  // The first occurrence is the one with the remembered prefix; the second has
  // the sentence before it instead.
  assert.deepEqual(relocate(anchor, repeated), { start: 13, end: 24 });
  const second = anchorIn(repeated, 13 + SOURCE.length, 24 + SOURCE.length);
  assert.deepEqual(relocate(second, repeated), { start: 13 + SOURCE.length, end: 24 + SOURCE.length });
});

test("文字被删掉后，这段无法再定位，而不是指向别处", () => {
  const { passage } = save();
  assert.equal(relocate(passage, "完全不同的正文，一句也不剩。"), null);
});

test("架子满了就不再添加，已有的标注也不动", () => {
  let passages: Passage[] = [];
  for (let index = 0; index < PASSAGES_PER_WORK; index += 1) {
    passages = upsertPassage(passages, { start: index * 4, end: index * 4 + 2, text: `p${index}`, prefix: `a${index}`, suffix: `b${index}` }, "", 1_000 + index).passages;
  }
  assert.equal(passages.length, PASSAGES_PER_WORK);
  const full = upsertPassage(passages, { start: 900, end: 902, text: "z", prefix: "y", suffix: "x" }, "", 2_000);
  assert.equal(full.passages.length, PASSAGES_PER_WORK);
  assert.equal(full.passage, undefined);
  assert.deepEqual(full.passages, passages, "nothing already on the shelf is dropped to make room");
});

test("删除只删指定的那一条", () => {
  const { passages, passage } = save();
  const second = upsertPassage(passages, anchorIn(SOURCE, 0, 5), "", 1_700_000_002_000);
  assert.equal(second.passages.length, 2);
  const left = removePassage(second.passages, passage.id);
  assert.equal(left.length, 1);
  assert.notEqual(left[0]?.id, passage.id);
});

test("摘录在限长后加省略号，短的不动", () => {
  assert.equal(passageExcerpt("很短", 80), "很短");
  assert.equal(passageExcerpt("字".repeat(81), 80), `${"字".repeat(80)}…`);
});

test("笔记长度被截在限长内", () => {
  const { passage } = save("批".repeat(NOTE_LIMIT + 50));
  assert.equal(characterCount(passage.note), NOTE_LIMIT);
});

test("同一段按文字与上下文认定，即使偏移变了", () => {
  const { passages } = save();
  const moved: Parameters<typeof findPassage>[1] = { ...anchorIn(SOURCE, 13, 24), start: 99, end: 110 };
  assert.ok(findPassage(passages, moved), "a passage is recognised by its words, not only its offsets");
});
