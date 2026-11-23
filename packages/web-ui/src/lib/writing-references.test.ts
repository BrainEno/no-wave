import assert from "node:assert/strict";
import test from "node:test";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { auditWritingReferences } from "./writing-references.ts";
import type { WritingDraft } from "./writing-session.ts";

const draft = (): WritingDraft => ({ title: "核对链接", summary: "", locale: "zh-CN", workType: "other", editorState: articleBlocksToLexicalEditorState([
  { type: "paragraph", text: "同名 同名 另一称呼", inlines: [
    { text: "同名", href: "https://EXAMPLE.test/a" }, { text: " " }, { text: "同名", href: "/articles/b" }, { text: " " }, { text: "另一称呼", href: "https://example.test/a" },
  ] },
  { type: "image", src: "http://images.example.test/cover", alt: "封面", caption: "照片说明" },
]) });

test("offline reference inventory groups equivalent URLs and retains every navigable occurrence", () => {
  const result = auditWritingReferences(draft());
  assert.equal(result.groups.length, 3);
  const shared = result.groups.find(group => group.url === "https://example.test/a")!;
  assert.deepEqual(shared.occurrences.map(item => item.path), [[0, 0], [0, 4]]);
  assert.deepEqual(shared.labels, ["同名", "另一称呼"]);
  assert.equal(shared.external, true);
  assert.ok(shared.issues.includes("ambiguous-label"));
  assert.equal(result.groups.find(group => group.kind === "image")!.issues.includes("insecure-http"), true);
  assert.equal(result.total, 4);
  assert.equal(result.limited, false);
});

test("unsafe reference addresses are hidden and never mistaken for verified media ownership", () => {
  const source = draft();
  const runs = source.editorState!.root.children[0]!.children as Record<string, unknown>[];
  runs[0]!.url = "https://private-user:do-not-show@example.test/a";
  const audit = auditWritingReferences(source);
  const invalid = audit.groups.find(group => group.issues.includes("unsafe-url"))!;
  assert.equal(invalid.url, null);
  assert.ok(!JSON.stringify(audit).includes("do-not-show"));
  assert.ok(!JSON.stringify(audit).includes("private-user"));
  source.editorState!.root.children.push({ type: "image", version: 1, src: "/api/media/11111111-1111-4111-8111-111111111111", alt: "" });
  const image = auditWritingReferences(source).groups.find(group => group.url?.startsWith("/api/media/"))!;
  assert.equal(image.external, false);
  assert.ok(image.issues.includes("empty-label"));
});

test("inventory counts are explicitly partial when node or reference limits are reached", () => {
  const source = draft();
  const link = { type: "link", version: 1, url: "https://example.test/", children: [{ type: "text", version: 1, text: "来源" }] };
  source.editorState!.root.children[0]!.children = Array.from({ length: 1002 }, () => structuredClone(link));
  const result = auditWritingReferences(source);
  assert.equal(result.limited, true);
  assert.equal(result.total, 1000);
  assert.equal(result.groups[0]!.occurrences.length, 1000);
});

test("reference limits stop child access rather than only suppressing returned results", () => {
  const source = draft();
  const children = Array.from({ length: 1002 }, () => ({ type: "link", version: 1, url: "/read", children: [{ type: "text", version: 1, text: "来源" }] }));
  Object.defineProperty(children, 1001, { get() { throw new Error("inventory read beyond its reference budget"); } });
  source.editorState!.root.children[0]!.children = children;
  const result = auditWritingReferences(source);
  assert.equal(result.total, 1000);
  assert.equal(result.limited, true);
});
