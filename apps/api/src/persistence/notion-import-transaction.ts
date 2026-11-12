import { MAX_AUTO_SLUG_ATTEMPTS } from "../application/article-create.ts";
import type { CommitNotionImportWorkInput, NotionImportEditionWrite } from "../application/notion-import-plan.ts";
import type { CreateArticleInput } from "../application/persistence-ports.ts";
import { slugifyArticleTitle, uniquifyArticleSlug } from "../domain/article-slug.ts";
import type { SqliteRunner } from "./sqlite.ts";
import type { PgDatabase, PgTransaction } from "./postgres-driver.ts";

export { MAX_AUTO_SLUG_ATTEMPTS };

/** Used only during a synchronous outer import transaction, never across an await. */
export function sqliteImportSavepoints(db: SqliteRunner): SqliteRunner {
  let sequence = 0;
  const stack: string[] = [];
  return {
    get isTransaction() { return db.isTransaction; },
    close() { throw new Error("An import transaction cannot close its connection."); },
    prepare: (query) => db.prepare(query),
    exec(query) {
      if (query === "BEGIN IMMEDIATE") {
        const name = `notion_import_${++sequence}`;
        db.exec(`SAVEPOINT ${name}`);
        stack.push(name);
      } else if (query === "COMMIT" || query === "ROLLBACK") {
        const name = stack.pop();
        if (!name) throw new Error("No import savepoint is active.");
        if (query === "ROLLBACK") db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        db.exec(`RELEASE SAVEPOINT ${name}`);
      } else db.exec(query);
    },
  };
}

/** Child writers keep their rollback semantics (notably slug retries) inside one work transaction. */
export function postgresImportSavepoints(tx: PgTransaction): PgDatabase {
  let sequence = 0;
  return {
    unsafe: (query, parameters) => tx.unsafe(query, parameters),
    async end() { throw new Error("An import transaction cannot close its connection."); },
    async begin(work) {
      const name = `notion_import_${++sequence}`;
      await tx.unsafe(`SAVEPOINT ${name}`);
      try {
        const result = await work(tx);
        await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
}

export function importEditionFields(edition: NotionImportEditionWrite, tagIds: string[]) {
  return {
    title: edition.title, summary: edition.summary, locale: edition.locale,
    contentBlocks: edition.contentBlocks, contentBlocksVersion: edition.contentBlocksVersion,
    publish: edition.publish, workType: edition.workType,
    ...(tagIds.length ? { tagIds } : {}),
  };
}

export function importCreateCandidate(input: CommitNotionImportWorkInput, edition: NotionImportEditionWrite, tagIds: string[], attempt: number): CreateArticleInput {
  const base = edition.requestedSlug ?? slugifyArticleTitle(edition.title);
  return { ...importEditionFields(edition, tagIds), authorId: input.actorId,
    slug: attempt === 1 ? base : uniquifyArticleSlug(base, attempt), requestedSlug: edition.requestedSlug,
    idempotencyKey: input.expected.createKey, requireNew: true };
}

/** A separate advisory namespace from the featured shelf and migration runner. */
const NOTION_PAGE_LOCK = 0x4e57494d;
export async function lockNotionImportPages(tx: PgTransaction, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.unsafe("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [NOTION_PAGE_LOCK, id]);
  }
}
