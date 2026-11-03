import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMediaRefStatements,
  articleMediaRefStatements,
  avatarMediaRefStatements,
  bindPlaceholders,
  deleteArticleMediaRefStatements,
} from "./media-reference-sync.ts";

const KEEP = "11111111-1111-4111-8111-111111111111";
const DROP = "22222222-2222-4222-8222-222222222222";
const ARTICLE = "33333333-3333-4333-8333-333333333333";

const body = (...sources: string[]) => [
  ...sources.map((src, index) => ({ id: `i${index}`, type: "image", src, alt: "" })),
  { id: "p", type: "paragraph", text: "正文。" },
];

/**
 * The statements that keep `article_media_refs` true (issue #163).
 *
 * They are asserted here, without a database, because both providers run these
 * exact strings: the SQLite store synchronously inside `BEGIN IMMEDIATE`, the
 * PostgreSQL store inside `sql.begin`. A mistake in the plan is therefore a
 * mistake in *both* adapters, which is worth catching where it is cheap.
 */
test("a save replaces its own locale's references and leaves other locales alone", () => {
  const statements = articleMediaRefStatements({ articleId: ARTICLE, locale: "zh-CN", content: body(`/api/v1/media/${KEEP}`) });
  assert.equal(statements.length, 2, "one delete, one insert");
  assert.deepEqual(statements[0], {
    statement: "DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2",
    params: [ARTICLE, "zh-CN"],
  });
  assert.match(statements[1]!.statement, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(statements[1]!.params, [KEEP, ARTICLE, "zh-CN"]);
});

test("every image a body names becomes an insert, and nothing twice", () => {
  const statements = articleMediaRefStatements({
    articleId: ARTICLE,
    locale: "en",
    content: body(`/media/${KEEP}`, `https://api.example.test/api/media/${DROP}`, `/api/v1/media/${KEEP}`),
  });
  assert.deepEqual(statements.slice(1).map((entry) => entry.params[0]), [KEEP, DROP], "deduplicated, in the order found");
});

test("a body with no images clears its references and inserts nothing", () => {
  const statements = articleMediaRefStatements({ articleId: ARTICLE, locale: "zh-CN", content: body() });
  assert.equal(statements.length, 1, "the delete is what releases an image that was removed by this save");
  assert.match(statements[0]!.statement, /^DELETE FROM article_media_refs/);
});

test("a purge drops every locale of one work at once", () => {
  assert.deepEqual(deleteArticleMediaRefStatements(ARTICLE), [{
    statement: "DELETE FROM article_media_refs WHERE article_id = $1",
    params: [ARTICLE],
  }]);
});

test("an avatar names the uploaded image, or nothing at all", () => {
  assert.deepEqual(avatarMediaRefStatements({ userId: "u1", avatarUrl: `/api/v1/media/${KEEP}` }), [{
    statement: "UPDATE user_profiles SET avatar_media_id = (SELECT id FROM media_assets WHERE id = $2) WHERE user_id = $1",
    params: ["u1", KEEP],
  }]);
  // Removing the photo, and an external url, both mean "no uploaded image": the
  // column is not a second copy of avatar_url, and clearing it is what lets the
  // bytes be reclaimed.
  for (const avatarUrl of [null, "", "https://cdn.example.test/me.png"]) {
    assert.deepEqual(avatarMediaRefStatements({ userId: "u1", avatarUrl }), [{
      statement: "UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = $1",
      params: ["u1"],
    }]);
  }
});

test("$n placeholders translate to ? for SQLite, repeating a shared value", () => {
  // `$1` appears twice in the insert: SQLite needs two `?` and two copies of the
  // value, PostgreSQL needs one. Getting this wrong binds the asset id to the
  // locale.
  const insert = articleMediaRefStatements({ articleId: ARTICLE, locale: "zh-CN", content: body(`/media/${KEEP}`) })[1]!;
  const sqlite = bindPlaceholders(insert, "sqlite");
  assert.equal((sqlite.statement.match(/\?/g) ?? []).length, 4);
  assert.doesNotMatch(sqlite.statement, /\$\d/);
  assert.deepEqual(sqlite.params, [KEEP, ARTICLE, "zh-CN", KEEP]);
  // PostgreSQL keeps the statement and the three parameters, which is the whole
  // point of numbering them.
  assert.deepEqual(bindPlaceholders(insert, "postgres"), { statement: insert.statement, params: [KEEP, ARTICLE, "zh-CN"] });
});

test("the synchronous applier runs each statement in order with its own binding", () => {
  const seen: Array<[string, readonly unknown[]]> = [];
  applyMediaRefStatements(
    (statement, params) => seen.push([statement, params]),
    articleMediaRefStatements({ articleId: ARTICLE, locale: "zh-CN", content: body(`/media/${KEEP}`) }),
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]![1], [KEEP, ARTICLE, "zh-CN", KEEP]);
});
