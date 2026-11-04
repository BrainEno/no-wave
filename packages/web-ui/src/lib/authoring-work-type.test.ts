import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Regression for #196: the desk still offered 连载 (`serial`) for a *new* work,
 * after ADR 0016 and `38d087b` settled that the platform is for short and
 * medium-form work. A new work could be created in a shape the product does not
 * support.
 *
 * The distinction this guards is "can be chosen" versus "can exist". `serial`
 * must stay in the `WorkType` union, in the reader's filter tabs and in the
 * store, because works created before that decision still have to be listed and
 * read — deleting it from those would break real content. It must not be in the
 * list a new work is created from.
 */

const editorPath = new URL("../components/authoring/article-editor.tsx", import.meta.url);

test("a new work cannot be created as the retired serial type", async () => {
  const source = await readFile(editorPath, "utf8");

  const creatableBlock = source.match(/const workTypes: [^=]*= \[([\s\S]*?)\];/);
  assert.ok(creatableBlock, "the creatable-type list should be findable");
  assert.doesNotMatch(
    creatableBlock[1],
    /"serial"/,
    "serial must not be offered when creating a work (#196, ADR 0016 / 38d087b)",
  );

  // The compatibility half: an existing serial work must keep its type when it
  // is opened, or the next save would silently retype real content.
  assert.match(
    source,
    /retiredWorkTypes[^=]*=\s*\{\s*serial:/,
    "an existing serial work must still be nameable, so editing it cannot retype it",
  );
  assert.match(
    source,
    /retiredWorkTypes\[workType\]/,
    "and that name has to reach the select for the stored value",
  );
});

test("`serial` still exists for content that already has it", async () => {
  // Stated as its own test because a future cleanup is likely to try removing
  // the type everywhere, which would be a regression rather than a fix.
  const content = await readFile(new URL("../lib/content.ts", import.meta.url), "utf8");
  assert.match(content, /export type WorkType =[^;]*"serial"/, "the type union must keep serial");

  const parts = await readFile(new URL("../components/ui/parts.tsx", import.meta.url), "utf8");
  const tabs = parts.match(/tabTypes[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(tabs, "the reader filter tabs should be findable");
  assert.match(tabs[1], /"serial"/, "readers must still be able to filter to legacy serial works");

  const domain = await readFile(
    new URL("../../../../apps/api/src/domain/article.ts", import.meta.url),
    "utf8",
  );
  assert.match(domain, /"serial"/, "the API must still accept a stored serial work");
});

test("a new work is not silently created as zh-CN", async () => {
  const source = await readFile(editorPath, "utf8");
  // The save body used to hardcode `locale: "zh-CN"`, so an English work could
  // not be created and an existing `en` work was rewritten on edit.
  const saveBody = source.match(/body: JSON\.stringify\(\{([\s\S]*?)\n        \}\),/);
  assert.ok(saveBody, "the save body should be findable");
  assert.match(saveBody[1], /\n\s*locale,/, "the save body must send the selected locale");
  assert.doesNotMatch(saveBody[1], /locale:\s*"zh-CN"/, "and must not hardcode it");

  // Both authorable languages have to be offered, and the stored one preserved.
  assert.match(source, /authoringLocales[^=]*=\s*\[[\s\S]*"zh-CN"[\s\S]*"en"/, "zh-CN and en must be offered");
  assert.match(source, /article\?\.locale \?\?/, "an existing work keeps its own locale");
  assert.match(source, /retiredLocales\[locale\]/, "an existing zh-TW work keeps its locale too");
});
