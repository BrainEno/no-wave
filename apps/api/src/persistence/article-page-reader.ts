import { setImmediate as yieldToRequests } from "node:timers/promises";
import { projectStoredArticleCard } from "../application/article-reading.ts";
import type { ArticleReadProjection, StoredArticle } from "../application/persistence-ports.ts";
import type { PgExecutor, PgRow } from "./postgres-driver.ts";
import { privateSqliteStatement, type SqliteRow, type SqliteRunner } from "./sqlite.ts";

type PageRead = ArticleReadProjection & { limit: number };
type SqliteStatement = ReturnType<SqliteRunner["prepare"]>;
function cardRead(options: PageRead): boolean {
  if (options.projection !== undefined && options.projection !== "full" && options.projection !== "card") throw new TypeError("Invalid article page projection.");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new RangeError("Invalid article page row bound.");
  options.signal?.throwIfAborted();
  return options.projection === "card";
}
function appendCard(output: StoredArticle[], article: StoredArticle, options: PageRead): void {
  options.signal?.throwIfAborted();
  if (output.length >= options.limit) throw new Error("An article query exceeded its requested page size.");
  output.push(projectStoredArticleCard(article));
}

/**
 * Iterate SQLite before retaining results: all() would materialize up to 100
 * full bodies even though the caller explicitly asked only for cards. Default
 * full reads remain synchronous and byte/field compatible with existing stores.
 */
export function readSqliteArticlePage(statement: SqliteStatement, values: unknown[], map: (row: SqliteRow) => StoredArticle, options: PageRead): StoredArticle[] | Promise<StoredArticle[]> {
  if (!cardRead(options)) return statement.all(...values).map(map);
  if (!statement.iterate) throw new Error("The SQLite adapter cannot iterate article cards safely.");
  // The loop below yields between rows, so it must not share the connection's
  // cached statement: a concurrent read of the same SQL would reset it mid-page.
  const own = privateSqliteStatement(statement) as SqliteStatement;
  const iterator = own.iterate!(...values);
  return (async () => {
    const output: StoredArticle[] = [];
    for (const row of iterator) {
      appendCard(output, map(row), options);
      // Let an HTTP close/shutdown signal run even when every SQLite step and
      // projection is synchronous; never start the next row after cancellation.
      await yieldToRequests();
      options.signal?.throwIfAborted();
    }
    return output;
  })();
}

/**
 * postgres.js cursors fetch one row per portal step. Callback mode retains the
 * driver's normal resolve/reject lifecycle: its async-iterator overload replaces
 * those methods and fails to detach signal listeners after a successful EOF.
 * Awaiting the callback cursor also waits for portal cleanup before returning
 * success or a mapping/cancellation failure. Never fall back to a large all().
 */
export async function readPostgresArticlePage(executor: PgExecutor, text: string, values: unknown[], map: (row: PgRow) => StoredArticle, options: PageRead): Promise<StoredArticle[]> {
  const cards = cardRead(options);
  const query = executor.unsafe(text, values);
  if (!cards) return (await query).map(map);
  if (!query.cursor) throw new Error("The PostgreSQL adapter cannot cursor article cards safely.");
  if (options.signal) {
    if (!query.signal) throw new Error("The PostgreSQL adapter cannot cancel article card cursors safely.");
    // Returns the same pending query for chaining; the cursor below settles it.
    void query.signal(options.signal);
  }
  const output: StoredArticle[] = [];
  await query.cursor(1, rows => {
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("The PostgreSQL cursor exceeded its one-row batch.");
    for (const row of rows) appendCard(output, map(row), options);
    options.signal?.throwIfAborted();
  });
  options.signal?.throwIfAborted();
  return output;
}
