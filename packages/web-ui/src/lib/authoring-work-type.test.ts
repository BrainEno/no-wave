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
  assert.match(
    domain,
    /RETIRED_ARTICLE_WORK_TYPES = new Set\(\["serial"\]\)/,
    "and must also know that serial is the retired type, not an ordinary one",
  );
});

/**
 * The other half of #196: the desk stopped *offering* 连载, but the write contract
 * still accepted it, so `POST /api/v1/articles` with `workType: "serial"` created
 * work the product says it does not publish. A guard on the desk alone is a guard
 * on the easiest client, not on the contract.
 *
 * Asserted statically here because this test already reads across packages and the
 * behaviour itself is covered where it belongs: `domain/article.test.ts` for the
 * rule, `persistence-adapter-contract.test.ts` for both providers and both
 * directions (create refuses it, a stored row still saves and can be retyped).
 */
test("the write contract refuses a retired type but keeps a stored one editable", async () => {
  const domain = await readFile(
    new URL("../../../../apps/api/src/domain/article.ts", import.meta.url),
    "utf8",
  );
  assert.match(domain, /export function assertCreatableArticleWorkType/, "create must gate retired types");
  assert.match(
    domain,
    /export function assertArticleWorkTypeChange/,
    "an update must distinguish \"unchanged\" from \"retyped to a retired type\"",
  );

  for (const store of ["postgres-article-store.ts", "sqlite-article-store.ts"]) {
    const source = await readFile(
      new URL(`../../../../apps/api/src/persistence/${store}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /assertCreatableArticleWorkType\(/, `${store} must gate creation`);
    assert.match(source, /assertArticleWorkTypeChange\(/, `${store} must gate retyping`);
    // The gate has to sit *after* the replay lookup, or a key minted before the
    // retirement answers 400 for a write that already happened.
    assert.ok(
      source.indexOf("assertCreatableArticleWorkType(") > source.indexOf("idempotency_key_hash = $2")
        || source.indexOf("assertCreatableArticleWorkType(") > source.indexOf("idempotency_key_hash = ?"),
      `${store} must check the replay before the retirement`,
    );
  }
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
