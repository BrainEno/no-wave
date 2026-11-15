import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { PostgresRefreshStore } from "../../refresh/postgres-store.ts";
import { RefreshResultCodec } from "../../refresh/result-codec.ts";
import { resolveRefreshSettings } from "../../refresh/settings.ts";

export async function createSharedRefreshFixture(overrides: Record<string, string> = {}) {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) throw new Error("TEST_DATABASE_URL is required for shared refresh integration.");
  const admin = postgres(source, { max: 1, onnotice: () => {} });
  const schema = "nw_web_refresh_" + randomUUID().replaceAll("-", "");
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const url = new URL(source); url.searchParams.set("search_path", `${schema},public`);
  const env = { WEB_REFRESH_COORDINATOR: "postgres", WEB_INSTANCE_COUNT: "2", WEB_REFRESH_DATABASE_URL: url.toString(),
    WEB_REFRESH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), ...overrides };
  const settings = resolveRefreshSettings(env);
  const codec = new RefreshResultCodec(settings.encryptionKey);
  const store = new PostgresRefreshStore(settings, codec.fingerprint);
  const inspect = postgres(url.toString(), { max: 2, onnotice: () => {} });
  try { await store.migrate(); }
  catch (error) { await store.close(); await inspect.end(); await admin`DROP SCHEMA ${admin(schema)} CASCADE`; await admin.end(); throw error; }
  return { env, settings, codec, store, inspect, async cleanup() {
    await store.close(); codec.dispose(); await inspect.end({ timeout: 1 });
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.end({ timeout: 1 }); }
  } };
}
