import { test as base } from "./csp-fixture.ts";
import { createSqliteClient } from "../../apps/api/src/persistence/sqlite.ts";
import { createSqliteTaxonomyStore } from "../../apps/api/src/persistence/sqlite-taxonomy-store.ts";
import { startFontStack, type FontStack } from "./font-stack.ts";
import type { CreatedTag } from "./tag-author.ts";

type TagStack = FontStack & { seedEnglishTag(name: string): CreatedTag };

// Each journey owns its disposable production Web and real SQLite API, so an
// English tag seeded by one test cannot invalidate another's empty directory.
// No quota increase, catalogue response mocking or production account is needed.
export const test = base.extend<{ tagStack: TagStack }>({
  tagStack: [async ({}, runWithStack) => {
    const stack = await startFontStack();
    try {
      await runWithStack({ ...stack, seedEnglishTag(name) {
        // English tag rows can already exist, but REST tag creation still only
        // accepts zh-CN. Use the real store on the fixture-owned database only;
        // this must not broaden the public write contract to set up a reader.
        const db = createSqliteClient({ filename: stack.databasePath });
        try {
          const tag = createSqliteTaxonomyStore(db).createTag({ actorId: "e2e-existing-tag", name, locale: "en" });
          if (typeof tag.id !== "string" || typeof tag.slug !== "string" || typeof tag.name !== "string") {
            throw new Error("The private English tag fixture was not persisted.");
          }
          return { id: tag.id, slug: tag.slug, name: tag.name };
        } finally { db.close(); }
      } });
    } finally { await stack.close(); }
  }, { timeout: 60_000 }],
});
