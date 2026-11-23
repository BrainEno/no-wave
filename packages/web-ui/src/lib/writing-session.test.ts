import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { WritingSession, bindWritingUnload, writingDraftKey, canLeaveWriting, type WritingDraft } from "./writing-session.ts";

const draft = (title = "风"): WritingDraft => ({ title, summary: "", locale: "zh-CN", workType: "other", editorState: articleBlocksToLexicalEditorState([{ type: "paragraph", text: "未完的句子" }]) });

test("selection serialization defaults and adjacent identical text do not dirty a hydrated document", () => {
  const original = draft();
  const hydrated = structuredClone(original);
  const paragraph = hydrated.editorState!.root.children[0]!;
  paragraph.textFormat = 0;
  paragraph.textStyle = "";
  paragraph.direction = "ltr";
  const text = (paragraph.children as Record<string, unknown>[])[0]!;
  paragraph.children = [{ ...text, text: "未完的" }, { ...text, text: "句子" }];
  assert.equal(writingDraftKey(hydrated), writingDraftKey(original));
  assert.equal(new WritingSession(original).update(hydrated).dirty, false);
});

test("saving a captured snapshot never acknowledges edits made while its request was in flight", () => {
  const original = draft();
  const session = new WritingSession(original);
  const submitted = draft("第一版");
  session.update(submitted);
  session.update(draft("后来改的"));
  assert.equal(session.acknowledge(submitted).dirty, true);
  assert.equal(session.update(submitted).dirty, false, "undoing back to the submitted snapshot is clean");
  assert.equal(session.update(original).dirty, true);
});

test("an ambiguous create replay acknowledges the server's actual version, not the old submitted bytes", () => {
  const session = new WritingSession(draft("空白"));
  const submitted = draft("创建时");
  session.update(submitted);
  assert.equal(session.acknowledge(draft("其他窗口更新")).dirty, true);
  assert.equal(session.update(draft("其他窗口更新")).dirty, false);
});

test("each semantic field and formatting change is guarded; reverting to the baseline is clean", () => {
  const original = draft();
  const session = new WritingSession(original);
  for (const changed of [
    { ...original, title: "改名" }, { ...original, summary: "摘要" },
    { ...original, locale: "en" }, { ...original, workType: "poetry" as const },
  ]) {
    assert.equal(session.update(changed).dirty, true);
    assert.equal(session.update(original).dirty, false);
  }
  const formatted = structuredClone(original);
  ((formatted.editorState!.root.children[0]!.children as Record<string, unknown>[])[0]!).format = 1;
  assert.equal(session.update(formatted).dirty, true);
});

test("a leave confirmation belongs to one editor revision, and pending creates always take precedence", () => {
  const session = new WritingSession(draft());
  const before = session.update(draft("想离开"));
  const intent = { editorKey: "new-1", revision: before.revision };
  assert.equal(canLeaveWriting(intent, "new-1", before, false), true);
  assert.equal(canLeaveWriting(intent, "new-2", before, false), false);
  assert.equal(canLeaveWriting(intent, "new-1", before, true), false);
  assert.equal(canLeaveWriting(intent, "new-1", session.update(draft("后来输入")), false), false);
});

test("unload reads the live guard in the same tick and removes its listener on cleanup", () => {
  const target = new EventTarget();
  let dirty = false;
  const release = bindWritingUnload(() => dirty, target);
  const dispatch = () => target.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  assert.equal(dispatch(), true);
  dirty = true;
  assert.equal(dispatch(), false);
  release();
  assert.equal(dispatch(), true);
});

test("hydration merging adjacent equal-destination links does not warn about unsaved content", () => {
  const original = draft();
  original.editorState = articleBlocksToLexicalEditorState([{ type: "paragraph", text: "同一链接", inlines: [
    { text: "同一", href: "https://example.test/read", marks: ["bold"] }, { text: "链接", href: "https://example.test/read", marks: ["italic"] },
  ] }]);
  const hydrated = structuredClone(original);
  assert.ok(hydrated.editorState);
  const paragraph = hydrated.editorState.root.children[0]!;
  const links = paragraph.children as Record<string, unknown>[];
  paragraph.children = [{ ...links[0], children: [...links[0]!.children as unknown[], ...links[1]!.children as unknown[]] }];
  assert.equal(new WritingSession(original).update(hydrated).dirty, false);
});
