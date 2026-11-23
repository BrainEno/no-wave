import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * ADR 0054: a work is 小说, 诗歌 or 其他文体 — nothing finer, and nothing
 * "retired but still there". #196 once kept 连载 (`serial`) alive as a type that
 * could exist but not be chosen; the fold migrated every such work to `novel`,
 * so the desk, the reader tabs and the contract now name the same three types,
 * and the database refuses the rest (see `domain/article.test.ts` and
 * `persistence-adapter-contract.test.ts` for the behaviour on both providers).
 */

const editorPath = new URL("../components/authoring/article-editor.tsx", import.meta.url);
const THREE = /"novel"[\s\S]*"poetry"[\s\S]*"other"/;
const FOLDED = /"(?:short_story|serial|essay|criticism|literary_criticism|nonfiction)"/;

test("the desk, the reader tabs and the type union all name exactly 小说 / 诗歌 / 其他文体", async () => {
  const editor = await readFile(editorPath, "utf8");
  const creatable = editor.match(/const workTypes: [^=]*= \[([\s\S]*?)\];/);
  assert.ok(creatable, "the creatable-type list should be findable");
  assert.match(creatable[1], THREE);
  assert.doesNotMatch(creatable[1], FOLDED);
  assert.doesNotMatch(editor, /retiredWorkTypes/, "no type is retired-but-kept any more");

  const content = await readFile(new URL("../lib/content.ts", import.meta.url), "utf8");
  const union = content.match(/export type WorkType =([^;]*);/);
  assert.ok(union);
  assert.match(union[1], THREE);
  assert.doesNotMatch(union[1], FOLDED);

  const types = await readFile(new URL("../lib/work-types.ts", import.meta.url), "utf8");
  const list = types.match(/export const workTypes[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(list);
  assert.match(list[1], THREE);
  assert.doesNotMatch(list[1], FOLDED);
});

test("the write contract names the same three types", async () => {
  const domain = await readFile(new URL("../../../../apps/api/src/domain/article.ts", import.meta.url), "utf8");
  assert.match(domain, /const ARTICLE_WORK_TYPES = new Set\(\["novel", "poetry", "other"\]\)/);
  assert.doesNotMatch(domain, /RETIRED_ARTICLE_WORK_TYPES|assertCreatableArticleWorkType/);
});

test("a new work is not silently created as zh-CN", async () => {
  const source = await readFile(editorPath, "utf8");
  // The save body used to hardcode `locale: "zh-CN"`, so an English work could
  // not be created and an existing `en` work was rewritten on edit.
  const saveBody = source.match(/function saveBody\([\s\S]*?return JSON\.stringify\(\{([\s\S]*?)\n  \}\);/);
  assert.ok(saveBody, "the save body should be findable");
  assert.match(saveBody[1], /locale:\s*draft\.locale/, "the save body must send the selected locale");
  assert.doesNotMatch(saveBody[1], /locale:\s*"zh-CN"/, "and must not hardcode it");
  assert.match(source, /const body = saveBody\(draft, target, currentArticle\)/, "the request must use that body");

  // Both authorable languages have to be offered, and the stored one preserved.
  assert.match(source, /authoringLocales[^=]*=\s*\[[\s\S]*"zh-CN"[\s\S]*"en"/, "zh-CN and en must be offered");
  assert.match(source, /article\?\.locale \?\?/, "an existing work keeps its own locale");
  assert.match(source, /retiredLocales\[article\.locale\]/, "an existing zh-TW work keeps its locale even while another option is selected");
});
