import { MigrationJournalError, type MigrationProvider } from "./provider-migration-journal.ts";

type EntitySpec = { table: string; primaryKey: readonly string[]; columns: readonly string[]; jsonColumns?: readonly string[] };

// Strict allowlist: journal data never supplies SQL identifiers. Keep this in sync
// with the shared persistence schema contract for the SQLite and PostgreSQL providers.
const entities: Record<string, EntitySpec> = {
  articles: { table: "articles", primaryKey: ["id"], columns: ["id", "author_id", "slug", "status", "work_type", "created_at", "updated_at", "published_at", "deleted_at"] },
  article_translations: { table: "article_translations", primaryKey: ["article_id", "locale"], columns: ["article_id", "locale", "title", "summary", "content_blocks", "content_blocks_version", "created_at", "updated_at"], jsonColumns: ["content_blocks"] },
  article_likes: { table: "article_likes", primaryKey: ["article_id", "user_id"], columns: ["article_id", "user_id", "created_at"] },
  article_comments: { table: "article_comments", primaryKey: ["id"], columns: ["id", "article_id", "author_id", "parent_comment_id", "content", "content_blocks", "content_blocks_version", "idempotency_key_hash", "request_hash", "created_at", "updated_at"], jsonColumns: ["content_blocks"] },
  taxonomies: { table: "taxonomies", primaryKey: ["id"], columns: ["id", "kind", "slug", "created_by", "created_at"] },
  taxonomy_translations: { table: "taxonomy_translations", primaryKey: ["taxonomy_id", "locale"], columns: ["taxonomy_id", "locale", "name", "description", "created_at", "updated_at"] },
  article_taxonomies: { table: "article_taxonomies", primaryKey: ["article_id", "taxonomy_id"], columns: ["article_id", "taxonomy_id", "created_at"] },
  user_profiles: { table: "user_profiles", primaryKey: ["user_id"], columns: ["user_id", "avatar_url", "website_url", "created_at", "updated_at"] },
  user_profile_translations: { table: "user_profile_translations", primaryKey: ["user_id", "locale"], columns: ["user_id", "locale", "display_name", "bio", "created_at", "updated_at"] },
  user_follows: { table: "user_follows", primaryKey: ["follower_id", "followed_id"], columns: ["follower_id", "followed_id", "created_at"] },
  conversations: { table: "conversations", primaryKey: ["id"], columns: ["id", "created_by", "created_at"] },
  conversation_participants: { table: "conversation_participants", primaryKey: ["conversation_id", "user_id"], columns: ["conversation_id", "user_id", "joined_at", "left_at", "last_read_at"] },
  messages: { table: "messages", primaryKey: ["id"], columns: ["id", "conversation_id", "sender_id", "body", "idempotency_key", "request_hash", "created_at"] },
  notifications: { table: "notifications", primaryKey: ["id"], columns: ["id", "user_id", "event_key", "payload", "payload_hash", "created_at", "read_at"], jsonColumns: ["payload"] },
  outbox_events: { table: "outbox_events", primaryKey: ["id"], columns: ["id", "event_key", "event_type", "aggregate_id", "payload", "attempts", "available_at", "created_at", "delivered_at", "lease_token"], jsonColumns: ["payload"] },
  revoked_sessions: { table: "revoked_sessions", primaryKey: ["session_id"], columns: ["session_id", "revoked_at", "expires_at"] },
  auth_accounts: { table: "auth_accounts", primaryKey: ["user_id"], columns: ["user_id", "email", "password_hash", "created_at"] },
  auth_sessions: { table: "auth_sessions", primaryKey: ["id"], columns: ["id", "user_id", "expires_at", "revoked_at", "created_at"] },
  auth_access_tokens: { table: "auth_access_tokens", primaryKey: ["token_id"], columns: ["token_id", "session_id", "expires_at"] },
  auth_refresh_tokens: { table: "auth_refresh_tokens", primaryKey: ["token_hash"], columns: ["token_hash", "session_id", "used_at", "created_at"] },
  auth_rate_limits: { table: "auth_rate_limits", primaryKey: ["key"], columns: ["key", "attempts", "reset_at"] },
  media_assets: { table: "media_assets", primaryKey: ["id"], columns: ["id", "owner_id", "storage_key", "content_type", "byte_size", "width", "height", "sha256", "created_at"] },
};

export type MigrationEntitySpec = EntitySpec;

export function getMigrationEntitySpec(entityType: string): MigrationEntitySpec {
  const spec = entities[entityType];
  if (!spec) throw new MigrationJournalError("UNSUPPORTED_ENTITY", "Migration entity type is not supported by the target applier: " + entityType + ".");
  return spec;
}

export function migrationEntityKeyValues(entityId: string, primaryKey: readonly string[]): string[] {
  if (primaryKey.length === 1) return [entityId];
  let parsed: unknown;
  try { parsed = JSON.parse(entityId); }
  catch { throw new MigrationJournalError("INVALID_ENTITY_KEY", "Composite migration entity IDs must be JSON arrays."); }
  if (!Array.isArray(parsed) || parsed.length !== primaryKey.length || parsed.some(value => typeof value !== "string" || value.length === 0)) {
    throw new MigrationJournalError("INVALID_ENTITY_KEY", "Composite migration entity ID does not match the primary key contract.");
  }
  return parsed as string[];
}

function normalizeJson(value: unknown, targetProvider: "sqlite" | "postgres", entityType: string, column: string): unknown {
  if (value === null || value === undefined) return value;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new MigrationJournalError("INVALID_JSON_COLUMN", entityType + "." + column + " does not contain valid JSON."); }
  }
  if (column === "content_blocks" && !Array.isArray(parsed)) {
    throw new MigrationJournalError("INVALID_JSON_COLUMN", entityType + "." + column + " must be a JSON array.");
  }
  if (column === "payload" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new MigrationJournalError("INVALID_JSON_COLUMN", entityType + "." + column + " must be a JSON object.");
  }
  return targetProvider === "sqlite" ? JSON.stringify(parsed) : parsed;
}

export function prepareMigrationRowPayload(
  targetProvider: "sqlite" | "postgres",
  entityType: string,
  entityId: string,
  input: Record<string, unknown>,
): { spec: EntitySpec; primaryKeyValues: string[]; payload: Record<string, unknown>; columns: string[]; values: unknown[] } {
  const spec = getMigrationEntitySpec(entityType);
  const unknownColumns = Object.keys(input).filter(column => !spec.columns.includes(column));
  if (unknownColumns.length) throw new MigrationJournalError("UNSUPPORTED_COLUMN", "Migration payload contains unsupported columns for " + entityType + ": " + unknownColumns.join(", ") + ".");
  const missingKeys = spec.primaryKey.filter(column => typeof input[column] !== "string" || !(input[column] as string).length);
  if (missingKeys.length) throw new MigrationJournalError("INVALID_ENTITY_KEY", "Upsert payload is missing primary-key field(s): " + missingKeys.join(", ") + ".");
  const primaryKeyValues = migrationEntityKeyValues(entityId, spec.primaryKey);
  for (let index = 0; index < spec.primaryKey.length; index += 1) {
    if ((input[spec.primaryKey[index]] as string) !== primaryKeyValues[index]) {
      throw new MigrationJournalError("ENTITY_KEY_MISMATCH", "Migration entity ID does not match the row's primary-key value.");
    }
  }
  const columns = Object.keys(input).sort();
  const jsonColumns = new Set(spec.jsonColumns ?? []);
  const payload: Record<string, unknown> = {};
  for (const column of columns) {
    const value = input[column];
    payload[column] = jsonColumns.has(column) ? normalizeJson(value, targetProvider, entityType, column) : value;
  }
  return { spec, primaryKeyValues, payload, columns, values: columns.map(column => payload[column]) };
}

export function getSupportedMigrationEntityTypes(): string[] {
  return Object.keys(entities).sort();
}

export function assertMigrationTargetProvider(value: MigrationProvider): asserts value is "sqlite" | "postgres" {
  if (value !== "sqlite" && value !== "postgres") {
    throw new MigrationJournalError("UNSUPPORTED_TARGET_PROVIDER", "MongoDB replay is not implemented yet.");
  }
}
