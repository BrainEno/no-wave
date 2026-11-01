import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.ts";
import { ArticleAuthorizationError, ArticleInputError } from "../domain/errors.ts";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteTaxonomyStore(db) };
}

test("SQLite taxonomy store creates localized categories and tags", async () => {
  const { db, store } = await fixture();
  try {
    const category = store.createTaxonomy({
      actorId: "author-1", actorIsEditor: true, kind: "category", slug: "essays",
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
      actorId: "author-1", actorIsEditor: true, kind: "category", slug: "notes", name: "Notes", locale: "en",
    });
    // A category is editorial: without the editor role there is no category at all.
    assert.throws(() => store.createTaxonomy({
      actorId: "intruder", kind: "category", slug: "intruded", name: "Intruded", locale: "en",
    }), ArticleAuthorizationError);
    // …and with it, a second editor may add a translation to a category they did
    // not create, because the public taxonomy is maintained as a group.
    assert.equal(store.createTaxonomy({
      actorId: "intruder", actorIsEditor: true, kind: "category", slug: "notes", name: "Notes translated", locale: "zh-CN",
    }).id, taxonomy.id);
    // A tag is the author's own words: a stranger may not rewrite it, editor or not.
    const tag = store.createTag({ actorId: "author-1", name: "#Notes", locale: "en" });
    assert.throws(() => store.createTaxonomy({
      actorId: "intruder", actorIsEditor: true, kind: "tag", slug: tag.slug, name: "Hijacked tag", locale: "zh-CN",
    }), ArticleAuthorizationError);
    assert.throws(() => store.listTaxonomies({ kind: "invalid" }), ArticleInputError);
    assert.throws(() => store.listTaxonomies({ kind: "tag", limit: 101 }), ArticleInputError);
    assert.throws(() => store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "intruder" }), ArticleAuthorizationError);
    assert.equal(store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "author-1", actorIsEditor: true }), true);
    assert.equal(store.deleteTaxonomy({ taxonomyId: taxonomy.id, actorId: "author-1", actorIsEditor: true }), false);
  } finally { db.close(); }
});
