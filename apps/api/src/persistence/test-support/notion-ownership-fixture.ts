import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationServices } from "../../application/services.ts";
import { importNotionBundle } from "../../application/notion-import.ts";
import type { NotionBundle, NotionBundlePage } from "../../application/notion-bundle.ts";
import { createPostgresStore } from "../postgres.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { createSqliteClient, runSqliteMigrations, type SqliteRunner } from "../sqlite.ts";
import { runMigrations } from "../migrate.ts";
import { createSqliteProviderMigrationJournal } from "../sqlite-provider-migration-journal.ts";
import { createPostgresProviderMigrationJournal } from "../postgres-provider-migration-journal.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "../provider-migration-journal.ts";
import { createIsolatedPostgresTestSchema } from "./isolated-postgres-schema.ts";

export const ownershipEnv = {
  AUTH_JWT_SECRET: "ownership-test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://ownership.example.test",
  AUTH_JWT_AUDIENCE: "ownership-tests",
  MEDIA_DELETE_ENABLED: "true",
};
export const ownerMigration = { sqlite: "0023_external_content_owner", postgres: "0036_external_content_owner" };
export type Provider = "sqlite" | "postgres";
const text = (content: string) => ({ type: "text", plain_text: content, text: { content } });
export function sourcePage(id: string = randomUUID(), title = "Ownership test", tags: string[] = []): NotionBundlePage {
  return { id, properties: {
    Page: { type: "title", title: [text(title)] },
    Published: { type: "checkbox", checkbox: false },
    Tags: { type: "multi_select", multi_select: tags.map((name) => ({ name })) },
  }, blocks: [{ object: "block", id: "p", type: "paragraph", has_children: false,
    paragraph: { rich_text: [text(`${title} body`)] } }] };
}
export const sourceBundle = (...pages: NotionBundlePage[]): NotionBundle => ({ version: 1, database: { id: "ownership-tests", title: null }, pages });
export function bilingualBundle(sharedId: string, tags: string[] = []): NotionBundle {
  const primary = sourcePage(randomUUID(), "Primary edition", tags);
  primary.properties.Date = { type: "date", date: { start: "2026-11-01" } };
  primary.properties.English = { type: "relation", relation: [{ id: sharedId }] };
  return sourceBundle(primary, sourcePage(sharedId, "English edition", tags));
}

/** Real stores and schemas only. SQLite always uses a WAL-backed file. */
export async function ownershipFixture(provider: Provider, { legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "no-wave-page-owner-"));
  const filename = join(directory, "ownership.sqlite");
  let migrationDirectory: string | undefined;
  if (legacy) {
    migrationDirectory = join(directory, "legacy-migrations");
    await mkdir(migrationDirectory);
    const source = new URL(provider === "sqlite" ? "../migrations/sqlite/" : "../migrations/", import.meta.url);
    for (const name of await readdir(source)) {
      if (/^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name < ownerMigration[provider]) {
        await copyFile(new URL(name, source), join(migrationDirectory, name));
      }
    }
  }
  const db = provider === "sqlite" ? createSqliteClient({ filename }) : null;
  const pg = provider === "postgres" ? await createIsolatedPostgresTestSchema(process.env.TEST_DATABASE_URL!, { migrationDirectory }) : null;
  const sql = pg?.sql ?? null;
  if (db) await runSqliteMigrations(db, { directory: migrationDirectory });
  const runner: SqliteRunner | null = db;
  const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
  const services = createApplicationServices({ persistence: store, env: ownershipEnv });
  const actors = [randomUUID(), randomUUID()] as const;
  const pgQuery = (query: string) => { let index = 0; return query.replace(/\?/g, () => `$${++index}`); };
  async function rows(query: string, values: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
    const result = runner ? runner.prepare(query).all(...values) : await sql!.unsafe(pgQuery(query), values);
    return result.map((row) => ({ ...row }));
  }
  async function exec(query: string, values: readonly unknown[] = []): Promise<void> {
    if (runner) { if (values.length) runner.prepare(query).run(...values); else runner.exec(query); }
    else await sql!.unsafe(pgQuery(query), values);
  }
  for (const actor of actors) await exec("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)", [actor, `${actor}@example.test`, "unused-test-credential"]);
  const preview = (source: NotionBundle, actorId: string = actors[0]) => importNotionBundle({ actorId, bundle: source, apply: false, deps: services });
  const apply = (source: NotionBundle, planToken: string, actorId: string = actors[0]) => importNotionBundle({ actorId, bundle: source, apply: true, planToken, deps: services });
  return { provider, directory, filename, db, sql, store, services, actors, rows, exec, preview, apply,
    async importFresh(source: NotionBundle, actorId: string = actors[0]) { return apply(source, (await preview(source, actorId)).planToken!, actorId); },
    async migrate() { return db ? runSqliteMigrations(db) : (await runMigrations(sql!)).applied; },
    async article(actorId: string = actors[0]) { return store.createArticle({ authorId: actorId, slug: `work-${randomUUID()}`, title: "Existing work", contentBlocks: [{ id: "p", type: "paragraph", text: "Existing body" }] }); },
    async insertLink(externalId: string, locale: string, articleId: string, ownerId: string) {
      await exec("INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest) VALUES ('notion', ?, ?, ?, ?, 'fixture')", [externalId, locale, articleId, ownerId]);
    },
    async snapshot() {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of ["articles", "article_translations", "taxonomies", "taxonomy_translations", "article_taxonomies", "article_media_refs", "external_content_links", "provider_migration_changes"]) {
        result[table] = await rows(`SELECT * FROM ${table} ORDER BY 1, 2`);
      }
      return result;
    },
    async record() {
      const journal = db ? createSqliteProviderMigrationJournal(db) : createPostgresProviderMigrationJournal(sql!);
      const sessionId = randomUUID();
      await journal.createSession({ sessionId, sourceProvider: provider, targetProvider: provider === "sqlite" ? "postgres" : "sqlite", schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
      await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
      return { journal, sessionId };
    },
    async close() {
      try { if (db) db.close(); if (pg) await pg.cleanup(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
export type OwnershipFixture = Awaited<ReturnType<typeof ownershipFixture>>;
