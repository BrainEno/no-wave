import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.mjs";
import { ArticleAuthorizationError, ArticleInputError } from "../domain/errors.mjs";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteTaxonomyStore(db) };
}

test("SQLite taxonomy store creates localized categories and tags", async () => {
  const { db, store } = await fixture();
  try {
    const category = store.createTaxonomy({
      actorId: "author-1", kind: "category", slug: "essays",
      name: "Essays", description: "Literary essays", locale: "en",
    });
    assert.equal(category.kind, "category");
    assert.equal(category.name, "Essays");
    assert.equal(category.description, "Literary essays");
    assert.equal(store.getTaxonomyBySlug({ kind: "category", slug: "essays", locale: "en" }).id, category.id);
    assert.equal(store.listTaxonomies({ kind: "category", locale: "en", query: "essay" }).length, 1);

    const tag = store.createTag({ actorId: "author-1", name: "#NoWave", locale: "en" });
    assert.equal(tag.kind, "tag");
    assert.equal(tag.name, "NoWave");
    assert.equal(store.createTag({ actorId: "author-2", name: "nowave", locale: "en" }).id, tag.id);
  } finally { db.close(); }
});

test("SQLite taxonomy store protects ownership and validates list inputs", async () => {
  const { db, store } = await fixture();
  try {
    const taxonomy = store.createTaxonomy({
      actorId: "author-1", kind: "category", slug: "notes", name: "Notes", locale: "en",
    });
    assert.throws(() => store.createTaxonomy({
      actorId: "intruder", kind: "category", slug: "notes", name: "Notes translated", locale: "zh-CN",
    }), ArticleAuthorizationError);
    assert.throws(() => store.listTaxonomies({ kind: "invalid" }), ArticleInputError);
    assert.throws(() => store.listTaxonomies({ kind: "tag", limit: 101 }), ArticleInputError);
    assert.throws(() => store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "intruder" }), ArticleAuthorizationError);
    assert.equal(store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "author-1" }), true);
    assert.equal(store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "author-1" }), false);
  } finally { db.close(); }
});
