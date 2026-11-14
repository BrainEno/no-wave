import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import { createPostgresStore } from "../postgres.ts";
import { createSqliteClient, runSqliteMigrations } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { createIsolatedPostgresTestSchema } from "./isolated-postgres-schema.ts";

export const integrityProviders = ["sqlite", "postgres"] as const;
export type IntegrityProvider = typeof integrityProviders[number];
export function integrityOptions(provider: IntegrityProvider) {
  return { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for the identical PostgreSQL notification integrity contract." };
}

/** Each contract owns all its rows; no claim can accidentally drain another test. */
export async function notificationIntegrityFixture(t: TestContext, provider: IntegrityProvider, options: { sqliteFile?: string; migrationDirectory?: string } = {}) {
  const pg = provider === "postgres" ? await createIsolatedPostgresTestSchema(process.env.TEST_DATABASE_URL!, { migrationDirectory: options.migrationDirectory }) : null;
  const db = provider === "sqlite" ? createSqliteClient({ filename: options.sqliteFile ?? ":memory:", enableWal: Boolean(options.sqliteFile) }) : null;
  t.after(async () => { db?.close(); await pg?.cleanup(); });
  if (db) await runSqliteMigrations(db, { directory: options.migrationDirectory });
  const store = db ? createSqliteStore(db) : createPostgresStore(pg!.sql);
  const endpoint = db ? { provider: "sqlite" as const, db } : { provider: "postgres" as const, sql: pg!.sql };
  async function query(source: string, parameters: SQLInputValue[] = []): Promise<Record<string, unknown>[]> {
    if (db) return db.prepare(source).all(...parameters).map(row => ({ ...row }));
    let index = 0;
    const rows = await pg!.sql.unsafe(source.replaceAll("?", () => `$${++index}`), parameters);
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])));
  }
  let conversationId: string | undefined;
  async function enqueue(label: string) {
    if (!conversationId) {
      const created = await store.createConversation({ actorId: "integrity-sender", participantIds: ["integrity-recipient"] });
      if (!created) throw new Error("The fixture conversation was not created.");
      conversationId = created.id;
    }
    const message = await store.persistMessage({ conversationId, senderId: "integrity-sender", body: label, idempotencyKey: label });
    const [event] = await query("SELECT * FROM outbox_events WHERE event_key = ?", [`message:${message.id}`]);
    return { message, eventId: String(event.id) };
  }
  async function expire(eventId: string) {
    await query("UPDATE outbox_events SET available_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", eventId]);
  }
  async function work(authorId = "integrity-author") {
    return store.createArticle({
      authorId, slug: `integrity-${randomUUID()}`, title: "Notification integrity", locale: "en", publish: true,
      contentBlocks: [{ id: "body", type: "paragraph", text: "An original work." }],
    });
  }
  async function profile(userId: string) {
    await store.upsertAuthorProfile({ userId, displayName: userId, locale: "en" });
  }
  return { store, endpoint, db, sql: pg?.sql, query, enqueue, expire, work, profile };
}
