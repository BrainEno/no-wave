import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { serializeRestArticle, serializeRestArticles } from "./serializers.ts";

/**
 * The list serializer's two obligations after #162.
 *
 * It used to ask three questions per article, so a page of N cost `1 + 3N`
 * statements — 301 for a page of 100, every one of them blocking the event loop
 * on the synchronous SQLite driver. It now prefetches the page's distinct authors
 * and its taxonomy links, which makes the statement count independent of page
 * size.
 *
 * Two things therefore have to stay true, and neither is obvious from reading
 * the code:
 *
 * 1. **The output is unchanged.** A performance change that quietly alters the
 *    JSON is a behavior change wearing a refactor's clothes.
 * 2. **The count does not grow with the page.** This is asserted by counting
 *    prepared statements, not by timing: a timing assertion would be flaky on a
 *    shared machine, while a count is exact and fails loudly.
 */

/**
 * Wrap a database so every `prepare` is counted.
 *
 * `prepare` is the right seam: `node:sqlite` compiles a statement per call, so
 * the count is the number of round trips the serializer causes. It is also the
 * cost that dominated the old path — three prepares per article.
 */
function countingDatabase(filename = ":memory:") {
  const db = createSqliteClient({ filename, enableWal: false });
  const rawPrepare = db.prepare.bind(db);
  const counter = {
    prepared: 0,
    reset() { counter.prepared = 0; },
    on(): void { counting = true; },
    off(): void { counting = false; },
  };
  let counting = false;
  db.prepare = (sql: string) => {
    if (counting) counter.prepared += 1;
    return rawPrepare(sql);
  };
  return { db, counter };
}

async function seededStore() {
  const { db, counter } = countingDatabase();
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const suffix = randomUUID();
  const authorIds = [`ser-author-a-${suffix}`, `ser-author-b-${suffix}`, `ser-author-c-${suffix}`];
  for (const [index, userId] of authorIds.entries()) {
    await store.upsertAuthorProfile({ userId, displayName: `序列化作者${index}`, bio: "简介", locale: "zh-CN" });
  }
  const category = await store.createTaxonomy({
    actorId: authorIds[0], actorIsEditor: true, kind: "category",
    slug: `ser-cat-${suffix}`, name: "序列化分类", description: "", locale: "zh-CN",
  });
  const tag = await store.createTag({ actorId: authorIds[0], name: `#序列化标签${suffix.slice(0, 6)}`, locale: "zh-CN" });
  const articles = [];
  for (let index = 0; index < 12; index += 1) {
    articles.push(await store.createArticle({
      authorId: authorIds[index % authorIds.length],
      slug: `ser-${index}-${suffix}`,
      title: `序列化作品 ${index}`,
      summary: `摘要 ${index}`,
      locale: "zh-CN",
      // Every third article carries both a category and a tag, so the page mixes
      // populated and empty lists — the case a naive batch would get wrong.
      categoryIds: index % 3 === 0 ? [category.id] : [],
      tagIds: index % 3 === 0 ? [tag.id] : [],
      publish: true,
      contentBlocks: [{ id: `p-${index}`, type: "paragraph", text: "正文" }],
    }));
  }
  return { db, store, counter, authorIds, articles, suffix };
}

test("a page's statement count does not grow with the page (#162)", async () => {
  const { db, store, counter, articles } = await seededStore();
  try {
    const counts: number[] = [];
    for (const size of [1, 4, 12]) {
      const page = articles.slice(0, size);
      counter.reset();
      counter.on();
      await serializeRestArticles(store, page, null);
      counter.off();
      counts.push(counter.prepared);
    }
    // The prefetch is three statements whatever the size: distinct authors,
    // category links, tag links. The old path was 1 + 3N per article here
    // (36 prepares for the twelve-article page).
    assert.deepEqual(counts, [3, 3, 3], `expected a constant 3 prepares, got ${counts.join(", ")}`);
  } finally { db.close(); }
});

test("the batched output equals the per-article output, field for field", async () => {
  const { db, store, articles } = await seededStore();
  try {
    const batched = await serializeRestArticles(store, articles, null);
    const oneByOne = [];
    for (const article of articles) oneByOne.push(await serializeRestArticle(store, article, null));
    assert.deepEqual(batched, oneByOne, "the batch must not change a single field, including ordering");

    // Spot-check the projections the batch had to reconstruct rather than read:
    // an author repeated across the page, and an article whose lists are empty.
    const populated = batched.find((item: any) => item.categories.length > 0) as any;
    assert.ok(populated, "the fixture must contain an article with taxonomies");
    assert.equal(populated.categories[0].name, "序列化分类");
    assert.equal(populated.tags.length, 1);
    assert.equal(populated.author.displayName, "序列化作者0");
    const empty = batched.find((item: any) => item.categories.length === 0) as any;
    assert.deepEqual(empty.categories, []);
    assert.deepEqual(empty.tags, []);
    assert.ok(empty.author !== null, "an article without taxonomies still has an author");
  } finally { db.close(); }
});

test("a repeated author is read once, not once per appearance", async () => {
  const { db, store, counter, articles } = await seededStore();
  try {
    // Every article by the same author: the page names them twelve times, and
    // the old path recomputed their follower counts twelve times.
    const sameAuthor = articles.map((article) => ({ ...article, authorId: articles[0].authorId }));
    counter.reset();
    counter.on();
    const serialized = await serializeRestArticles(store, sameAuthor, null);
    counter.off();
    // One author + two taxonomy kinds = three statements; the number of
    // appearances is irrelevant once the id set is deduplicated.
    assert.equal(counter.prepared, 3);
    assert.equal(new Set(serialized.map((item: any) => item.author.userId)).size, 1);
  } finally { db.close(); }
});

test("the viewer's follow state arrives through the batch, per author", async () => {
  const { db, store, articles, authorIds, suffix } = await seededStore();
  const viewerId = `ser-viewer-${suffix}`;
  try {
    await store.followUser({ actorId: viewerId, targetUserId: authorIds[0] });
    const serialized = await serializeRestArticles(store, articles, viewerId);
    const byAuthor = new Map(serialized.map((item: any) => [item.author.userId, item.author]));
    assert.equal((byAuthor.get(authorIds[0]) as any).isFollowing, true, "the followed author reads as followed");
    assert.equal((byAuthor.get(authorIds[1]) as any).isFollowing, false, "the others do not");
  } finally { db.close(); }
});

test("non-object entries and an authorless article pass through unchanged", async () => {
  const { db, store, articles } = await seededStore();
  try {
    // A page can contain an article whose author profile was never written (the
    // legacy per-article path returned `author: null`), and the serializer is
    // also called with values it must not touch.
    const orphan = { ...articles[1], id: articles[1].id, authorId: "ser-absent-author" };
    const result = await serializeRestArticles(store, [articles[0], orphan, null, "not-an-article"], null);
    assert.equal(result.length, 4, "every input is returned, in order");
    assert.equal(result[2], null, "a null entry is passed through");
    assert.equal(result[3], "not-an-article", "a non-object entry is passed through");
    const orphaned = result[1] as any;
    assert.equal(orphaned.author, null, "a missing profile is null, not undefined");
    assert.deepEqual(orphaned.categories, []);
    assert.deepEqual(await serializeRestArticles(store, [], null), []);
    assert.deepEqual(await serializeRestArticles(store, null, null), []);
  } finally { db.close(); }
});
