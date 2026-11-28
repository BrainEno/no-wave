import assert from "node:assert/strict";
import test from "node:test";
import {
  blockInlineRuns,
  blockItemInlines,
  inlineHref,
  inlineMarks,
  inlineSegments,
  isInlineMark,
  isInlineRun,
  type InlineRun,
} from "./content-inline.ts";

/**
 * The read side of the inline formatting contract.
 *
 * The defect these tests exist for: the article body used to render the
 * plain-text fallback and dropped every mark and every link, so a published
 * work silently lost its emphasis and its hyperlinks. The API had stored the
 * document correctly all along, which is why no API test could see it.
 *
 * The rules are checked here rather than in a browser because they are pure
 * decisions: which marks exist, and what makes a link safe. The browser test
 * proves that the renderer draws what this module decides.
 */

test("the contract's marks are the only marks that are drawn", () => {
  assert.equal(isInlineMark("bold"), true);
  assert.equal(isInlineMark("italic"), true);
  assert.equal(isInlineMark("underline"), true);
  assert.equal(isInlineMark("strikethrough"), true);
  assert.equal(isInlineMark("code"), true);
  assert.equal(isInlineMark("blink"), false);
  assert.equal(isInlineMark(""), false);
  assert.equal(isInlineMark(undefined), false);
});

test("a run's marks are reduced to the ones the contract defines", () => {
  const run: InlineRun = { text: "字", marks: ["italic", "blink", "bold"] };
  assert.deepEqual(inlineMarks(run), ["bold", "italic"]);
  assert.deepEqual(inlineMarks({ text: "字" }), []);
  assert.deepEqual(inlineMarks({ text: "字", marks: [] }), []);
});

test("a usable link keeps its target and an unusable one loses it", () => {
  assert.equal(
    inlineHref({ text: "链接", href: "https://example.test/a" }),
    "https://example.test/a",
  );
  assert.equal(inlineHref({ text: "链接", href: "/articles" }), "/articles");
  assert.equal(inlineHref({ text: "链接" }), null);
});

test("a hostile scheme is never a link", () => {
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//example.test/protocol-relative",
    "https://user:secret@example.test/",
    "/path\\with\\backslash",
  ]) {
    assert.equal(
      inlineHref({ text: "链接", href }),
      null,
      `${href} must not become a link`,
    );
  }
});

test("a run that is not a run is not a run", () => {
  assert.equal(isInlineRun({ text: "字" }), true);
  assert.equal(isInlineRun({ text: "字", marks: ["bold"] }), true);
  assert.equal(isInlineRun({ text: "字", href: "/a" }), true);
  assert.equal(isInlineRun({ text: "" }), false);
  assert.equal(isInlineRun({ text: 12 }), false);
  assert.equal(isInlineRun({ marks: ["bold"] }), false);
  assert.equal(isInlineRun({ text: "字", marks: "bold" }), false);
  assert.equal(isInlineRun({ text: "字", href: 12 }), false);
  assert.equal(isInlineRun(null), false);
  assert.equal(isInlineRun("字"), false);
});

test("a hostile link keeps its words and loses only the link", () => {
  const segments = inlineSegments([
    { text: "普通" },
    { text: "粗体", marks: ["bold"] },
    { text: "危险", href: "javascript:alert(1)" },
    { text: "安全", href: "https://example.test/" },
  ]);
  assert.equal(segments.length, 4);
  assert.equal(segments[0]!.kind, "text");
  assert.equal(segments[1]!.kind, "text");
  assert.deepEqual(segments[1]!.marks, ["bold"]);
  assert.equal(segments[2]!.kind, "text");
  assert.equal(segments[3]!.kind, "link");
  assert.equal(
    segments.some((segment) => "href" in segment),
    true,
    "the one safe link is still a link",
  );
  for (const segment of segments) {
    if (segment.kind !== "link") {
      assert.equal("href" in segment, false);
    }
  }
});

test("an empty run is dropped rather than drawn", () => {
  const segments = inlineSegments([
    { text: "" },
    { text: "有字" },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.text, "有字");
});

test("a block's runs are read defensively", () => {
  assert.deepEqual(blockInlineRuns(undefined), []);
  assert.deepEqual(blockInlineRuns("nope"), []);
  assert.deepEqual(blockInlineRuns([{ text: "字" }]), [{ text: "字" }]);
  assert.deepEqual(blockInlineRuns([{ text: "字" }, { text: 5 }]), [
    { text: "字" },
  ]);
});

test("a list's item runs line up with its items", () => {
  assert.deepEqual(blockItemInlines(undefined), []);
  assert.deepEqual(
    blockItemInlines([
      [{ text: "一" }],
      [{ text: "二" }],
    ]),
    [[{ text: "一" }], [{ text: "二" }]],
  );
  assert.deepEqual(blockItemInlines(["nope"]), []);
});
