/**
 * Keeping `article_media_refs` true (issue #163).
 *
 * The table is an answer, not a source of truth: the bodies and the avatars are
 * what is real, and this module is the only thing that writes the answer. It is
 * one module for both providers on purpose — the SQLite and PostgreSQL stores
 * differ in how they *execute* a statement, not in which rows the table must hold,
 * and a rule written twice is a rule that eventually differs.
 *
 * It therefore returns **statements rather than running them**. That is not
 * incidental: SQLite's transaction is synchronous (`BEGIN IMMEDIATE`, a function
 * that returns before `COMMIT`), so an `async` helper awaited inside it would
 * resume after the commit and write its rows outside the transaction. Producing a
 * plan lets each provider apply it in its own idiom — SQLite synchronously inside
 * the transaction, PostgreSQL with `await tx.unsafe(...)` — while the rule about
 * *which* rows the table must hold stays in this one file.
 *
 * Two rules, both consequences of what the table is for:
 *
 * 1. A reference is written from the *content that was just saved*, not from the
 *    content that was there before. So a save that removes an image deletes its
 *    row, and deleting that row is what allows the image to be reclaimed.
 * 2. A reference that matches no asset is not written. `media_assets` is the list
 *    of things that exist; a hand-written URL in a body must not become a
 *    reference to an image nobody uploaded, and must not fail the save either.
 *
 * `locale` travels with the reference because a work has one body per language,
 * and the reference belongs to the translation that contains it.
 */
import { collectMediaAssetIds } from "../domain/media-references.ts";

/**
 * How a provider spells a bound parameter.
 *
 * PostgreSQL numbers them (`$1`, `$2`); SQLite does not (`?`, in order). The two
 * are not interchangeable for a statement with a repeated placeholder — `$1`
 * twice is one value, `?` twice is two — so the statements here are written once
 * with `$n` and translated by {@link bindPlaceholders} at execution.
 */
export type MediaReferenceDialect = "postgres" | "sqlite";

/** One statement and its `$n`-numbered parameters. */
export type MediaReferenceStatement = { readonly statement: string; readonly params: readonly unknown[] };

/** `$1 … $2` → `? … ?` for SQLite; unchanged for PostgreSQL. */
export function bindPlaceholders(
  { statement, params }: MediaReferenceStatement,
  dialect: MediaReferenceDialect,
): { statement: string; params: unknown[] } {
  if (dialect === "postgres") return { statement, params: [...params] };
  const ordered: unknown[] = [];
  // Each occurrence appends its value, so a repeated `$1` becomes two `?`s that
  // SQLite binds to the same value twice.
  const translated = statement.replace(/\$(\d+)/g, (_match, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return "?";
  });
  return { statement: translated, params: ordered };
}

/**
 * The statements that make one translation's references match a body.
 *
 * Delete-then-insert rather than a diff: the set is small (a body holds a handful
 * of images), the statement count is the same either way, and a computed diff is
 * one more place for "the body changed but the table did not" to hide.
 */
export function articleMediaRefStatements(
  { articleId, locale, content }: { articleId: string; locale: string; content: unknown },
): MediaReferenceStatement[] {
  const statements: MediaReferenceStatement[] = [
    { statement: "DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", params: [articleId, locale] },
  ];
  for (const assetId of collectMediaAssetIds(content)) {
    // `SELECT … WHERE EXISTS` keeps the existence check and the insert in one
    // statement, without a second round trip per id.
    statements.push({
      statement:
        "INSERT INTO article_media_refs (asset_id, article_id, locale) " +
        "SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM media_assets WHERE id = $1) " +
        "ON CONFLICT DO NOTHING",
      params: [assetId, articleId, locale],
    });
  }
  return statements;
}

/** Every reference one work holds, in every locale — a purge, not an edit. */
export function deleteArticleMediaRefStatements(articleId: string): MediaReferenceStatement[] {
  return [{ statement: "DELETE FROM article_media_refs WHERE article_id = $1", params: [articleId] }];
}

/**
 * The statements that point a profile's avatar at the image it now names.
 *
 * `null` is a real value: removing the photo has to clear the reference, or the
 * image stays undeletable forever. An avatar url naming no asset becomes `null`
 * too — the column answers "which uploaded image is this", and a URL that points
 * at nothing is not one.
 */
export function avatarMediaRefStatements(
  { userId, avatarUrl }: { userId: string; avatarUrl: string | null | undefined },
): MediaReferenceStatement[] {
  const candidate = (avatarUrl ? collectMediaAssetIds(avatarUrl)[0] : undefined) ?? null;
  if (candidate === null) {
    return [{ statement: "UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = $1", params: [userId] }];
  }
  return [{
    statement: "UPDATE user_profiles SET avatar_media_id = (SELECT id FROM media_assets WHERE id = $2) WHERE user_id = $1",
    params: [userId, candidate],
  }];
}

/** Run a plan synchronously, for the provider whose transactions are synchronous. */
export function applyMediaRefStatements(
  run: (statement: string, params: readonly unknown[]) => void,
  statements: readonly MediaReferenceStatement[],
): void {
  for (const entry of statements) {
    const bound = bindPlaceholders(entry, "sqlite");
    run(bound.statement, bound.params);
  }
}
