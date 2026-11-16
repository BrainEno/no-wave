import assert from "node:assert/strict";
import test from "node:test";
import { captureReadingPosition, findReadingPosition, parseReadingPosition, type ReadingBlock } from "./reading-position.ts";

const blocks: ReadingBlock[] = [
  { id: "first", text: "第一段在渡口。", top: -200, height: 200 },
  { id: "second", text: "第二段读到这里。", top: 0, height: 400 },
  { id: "third", text: "最后一段。", top: 400, height: 200 },
];

test("capture is block-relative and ignores content before and after the real article", () => {
  const position = captureReadingPosition(blocks, 100, "edition-1");
  assert.ok(position);
  assert.equal(position.blockId, "second");
  assert.equal(position.offset, 0.25);
  assert.ok(position.percent > 0 && position.percent < 100);
  assert.equal(captureReadingPosition([], 100, "edition-1"), null);
  assert.equal(captureReadingPosition(blocks, -1000, "edition-1"), null);
  assert.equal(captureReadingPosition(blocks, 1000, "edition-1"), null);
});

test("resume verifies words even when a formerly stable block id was reused", () => {
  const position = captureReadingPosition(blocks, 100, "edition-1")!;
  assert.deepEqual(findReadingPosition(position, blocks), { kind: "found", index: 1 });
  const edited = [{ ...blocks[0]!, text: "新增开头" }, { ...blocks[1]!, text: "已经是完全不同的内容" }, { ...blocks[2]!, id: "moved", text: blocks[1]!.text }];
  assert.deepEqual(findReadingPosition(position, edited), { kind: "found", index: 2 });
  assert.deepEqual(findReadingPosition(position, edited.slice(0, 2)), { kind: "missing" });
  const repeated = [{ ...blocks[1]!, id: "x" }, { ...blocks[1]!, id: "y" }];
  assert.deepEqual(findReadingPosition(position, repeated), { kind: "ambiguous" });
});

test("invalid geometry, malformed storage and non-finite offsets never become scroll instructions", () => {
  const position = captureReadingPosition(blocks, 100, "edition-1")!;
  assert.deepEqual(parseReadingPosition(position), position);
  for (const patch of [{ offset: Infinity }, { offset: -1 }, { offset: 2 }, { percent: 101 }, { blockId: "" }, { fingerprint: "bad" }, { quote: "" }, { length: 0 }]) assert.equal(parseReadingPosition({ ...position, ...patch }), null);
  assert.equal(parseReadingPosition({ ...position, href: "https://outside.test" })?.blockId, "second");
  assert.equal(captureReadingPosition([{ ...blocks[0]!, height: NaN }], 1, "v1"), null);
});

test("an oversized block is not silently truncated into a false position witness", () => {
  const huge = { id: "huge", text: "a".repeat(1_000_000) + "different tail", top: 0, height: 400 };
  assert.equal(captureReadingPosition([huge], 100, "edition-1"), null);
  const valid = captureReadingPosition([{ ...huge, text: "a".repeat(1_000_000) }], 100, "edition-1")!;
  assert.deepEqual(findReadingPosition(valid, [huge]), { kind: "missing" });
});
