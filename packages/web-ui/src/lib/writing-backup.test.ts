import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { createWritingBackup, parseWritingBackup, readWritingBackup, previewWritingRestore, restoreWritingFields, exportWritingText, writingDownloadName, MAX_WRITING_BACKUP_BYTES } from "./writing-backup.ts";
import { writingDraftKey, type WritingDraft } from "./writing-session.ts";

const date = new Date("2026-11-12T12:00:00Z");
const draft = (): WritingDraft => ({ title: "海风", summary: "写作中的摘要", locale: "zh-CN", workType: "other", editorState: articleBlocksToLexicalEditorState([
  { type: "heading", level: 2, text: "第一节" },
  { type: "paragraph", text: "有格式的文字", inlines: [{ text: "有格式", marks: ["bold"] }, { text: "的文字", href: "https://example.test/read" }] },
  { type: "list", ordered: true, items: ["一", "二"] },
  { type: "code", language: "text", code: "<script>\n```\n&" },
  { type: "image", src: "/api/media/11111111-1111-4111-8111-111111111111", alt: "一张照片", caption: "拍摄说明" },
]) });

function editBackup(edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(createWritingBackup(draft(), date)) as Record<string, unknown>;
  edit(value);
  return JSON.stringify(value);
}

function backupDraft(value: Record<string, unknown>): Record<string, unknown> { return value.draft as Record<string, unknown>; }
function children(value: Record<string, unknown>): Record<string, unknown>[] { return ((backupDraft(value).editorState as Record<string, unknown>).root as Record<string, unknown>).children as Record<string, unknown>[]; }

test("versioned local JSON round-trips all editable content without server identities or save preconditions", () => {
  const source = { ...draft(), id: "do-not-export", revision: "private-revision", slug: "private-slug", status: "published", token: "not-a-credential-fixture" };
  const text = createWritingBackup(source, date);
  for (const secret of ["do-not-export", "private-revision", "private-slug", "published", "not-a-credential-fixture"]) assert.ok(!text.includes(secret));
  const backup = parseWritingBackup("\ufeff" + text);
  assert.equal(backup.createdAt, date.toISOString());
  assert.equal(writingDraftKey(backup.draft), writingDraftKey(source));
});

test("backup preview contains no image HTML and selective restore changes only checked fields", () => {
  const backup = parseWritingBackup(createWritingBackup(draft(), date));
  const current = { ...draft(), title: "正在写", summary: "保留摘要", locale: "en" };
  const plan = previewWritingRestore(current, backup);
  assert.deepEqual(plan.changedFields, ["title", "summary", "locale"]);
  const restored = restoreWritingFields(current, plan, ["title"]);
  assert.equal(restored.title, "海风");
  assert.equal(restored.summary, "保留摘要");
  assert.equal(restored.locale, "en");
  assert.deepEqual(restored.editorState, current.editorState);
  assert.throws(() => restoreWritingFields({ ...current, summary: "后来又改了" }, plan, ["title"]), /预览已过期/);
  for (const selection of [[], ["title", "title"], ["revision"]]) {
    assert.throws(() => restoreWritingFields(current, plan, selection as ["title"]), /选择/);
  }
});

test("restoring a legacy locale cannot create an option the desk has retired", () => {
  const legacy = { ...draft(), locale: "zh-TW" };
  const plan = previewWritingRestore(draft(), parseWritingBackup(createWritingBackup(legacy, date)));
  assert.throws(() => restoreWritingFields(draft(), plan, ["locale"]), /历史/);
  assert.equal(restoreWritingFields(draft(), plan, ["title", "editorState"]).locale, "zh-CN");
  assert.equal(restoreWritingFields(legacy, previewWritingRestore(legacy, parseWritingBackup(createWritingBackup(legacy, date))), ["locale"]).locale, "zh-TW");
});

test("a backup written before the three-type fold restores as its group", () => {
  // ADR 0054: a file from before can say "serial" or "essay". It must still
  // open, and what it restores must be a type the desk can save today.
  for (const [written, group] of [["serial", "novel"], ["short_story", "novel"], ["essay", "other"], ["nonfiction", "other"]] as const) {
    const text = createWritingBackup(draft(), date).replace(/"workType": "[a-z_]+"/, `"workType": "${written}"`);
    assert.match(text, new RegExp(`"workType": "${written}"`));
    const { backup, writtenWorkType } = readWritingBackup(text);
    assert.equal(backup.draft.workType, group);
    assert.equal(writtenWorkType, written, "the file's own value stays available for digest checks");
    const plan = previewWritingRestore({ ...draft(), workType: "poetry" }, backup);
    assert.equal(restoreWritingFields({ ...draft(), workType: "poetry" }, plan, ["workType"]).workType, group);
  }
});

test("malformed, oversized, unknown-version and identity-bearing backups are rejected before Lexical import", () => {
  for (const text of ["not json", "[]", "null", "{", " ".repeat(MAX_WRITING_BACKUP_BYTES + 1)]) assert.throws(() => parseWritingBackup(text));
  for (const mutate of [
    (v: Record<string, unknown>) => { v.version = 2; },
    (v: Record<string, unknown>) => { v.createdAt = "not a date"; },
    (v: Record<string, unknown>) => { v.format = "something-else"; },
    (v: Record<string, unknown>) => { v.actor = "forged"; },
    (v: Record<string, unknown>) => { backupDraft(v).revision = "forged"; },
    (v: Record<string, unknown>) => { backupDraft(v).title = "x".repeat(201); },
    (v: Record<string, unknown>) => { backupDraft(v).locale = "xx"; },
    (v: Record<string, unknown>) => { backupDraft(v).workType = "unknown"; },
    (v: Record<string, unknown>) => { backupDraft(v).editorState = null; },
    (v: Record<string, unknown>) => { children(v)[0]!.type = "html"; },
    (v: Record<string, unknown>) => { children(v)[0]!.format = "center"; },
    (v: Record<string, unknown>) => { children(v)[0]!.style = "background:url(https://example.test)"; },
  ]) assert.throws(() => parseWritingBackup(editBackup(mutate)));
});

test("unsafe URLs, nested links, unknown fields, excessive nesting and prototype keys fail closed", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.test/x", "https://name:pass@example.test", " /bad ", "https://example.test/\\x"]) {
    assert.throws(() => parseWritingBackup(editBackup(v => { const runs = children(v)[1]!.children as Record<string, unknown>[]; runs[1]!.url = href; })));
  }
  assert.throws(() => parseWritingBackup(editBackup(v => { children(v)[4]!.src = "/api/auth/logout"; })));
  assert.throws(() => parseWritingBackup(editBackup(v => { children(v)[4]!.src = "javascript:alert(1)"; })));
  assert.throws(() => parseWritingBackup(editBackup(v => { const runs = children(v)[1]!.children as Record<string, unknown>[]; runs[1]!.children = [structuredClone(runs[1]!)]; })));
  assert.throws(() => parseWritingBackup(editBackup(v => { children(v)[0]!.children = Array.from({ length: 12001 }, () => ({ type: "text", text: "a", version: 1 })); })));
  assert.throws(() => parseWritingBackup(createWritingBackup(draft(), date).replace('"version": 1', '"__proto__": {}, "version": 1')));
});

test("empty and partially written local drafts can be backed up without claiming they are publishable", () => {
  const source: WritingDraft = { title: "", summary: "", locale: "zh-CN", workType: "other", editorState: articleBlocksToLexicalEditorState(null) };
  assert.equal(parseWritingBackup(createWritingBackup(source, date)).draft.title, "");
  assert.throws(() => createWritingBackup({ ...source, editorState: null }, date), /初始化/);
});

test("plain text and Markdown exports use explicit safe syntax, preserving code fences and links", () => {
  const plain = exportWritingText(draft(), "text");
  assert.ok(plain.includes("海风\n"));
  assert.ok(plain.includes("1. 一\n2. 二"));
  assert.ok(plain.includes("一张照片"));
  const markdown = exportWritingText(draft(), "markdown");
  assert.ok(markdown.includes("## 第一节"));
  assert.ok(markdown.includes("**有格式**"));
  assert.ok(markdown.includes("](https://example.test/read)"));
  assert.ok(markdown.includes("````text\n<script>\n```\n&\n````"));
  const html = { ...draft(), title: "<script> & [海]", editorState: articleBlocksToLexicalEditorState([{ type: "paragraph", text: "<img src=x onerror=bad>" }]) };
  assert.ok(!exportWritingText(html, "markdown").includes("<img"));
  const file = writingDownloadName("../a\\b\u0000: 🌊", "json", date);
  assert.ok(file.endsWith(".json"));
  assert.ok(!/[\\/\u0000:]/.test(file));
});

test("backup import rejects autolink nodes that the live editor does not register", () => {
  assert.throws(() => parseWritingBackup(editBackup(value => {
    const runs = children(value)[1]!.children as Record<string, unknown>[];
    runs[1]!.type = "autolink";
  })), /未注册/);
});

test("Markdown export handles a maximum-length code block with many backtick runs without an argument-spread overflow", () => {
  const code = "a`".repeat(250_000);
  const source = { ...draft(), editorState: articleBlocksToLexicalEditorState([{ type: "code", language: "text", code }]) };
  const markdown = exportWritingText(source, "markdown");
  assert.ok(markdown.includes("```text\n" + code + "\n```"));
});
