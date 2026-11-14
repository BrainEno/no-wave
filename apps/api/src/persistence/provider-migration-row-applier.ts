import { ARTICLE_MEDIA_REFS_SNAPSHOT, MigrationJournalError, type MigrationProvider } from "./provider-migration-journal.ts";
import { MAX_FEATURED_ARTICLES } from "../domain/article.ts";

type EntitySpec = {
  table: string;
  primaryKey: readonly string[];
  columns: readonly string[];
  jsonColumns?: readonly string[];
  requiredColumns?: readonly string[];
  requiredKeys?: readonly string[];
  /**
   * Columns a provider computes for itself rather than carrying in a row payload
   * (ADR 0030). They are not part of the portable entity: capture does not read
   * them, replay does not write them, and a target provider may have none of
   * them. They exist so the schema-parity test can still say "both providers
   * have exactly the columns they are supposed to have" without pretending a
   * derived index column belongs to the data model.
   */
  derivedColumns?: readonly string[];
};

// Strict allowlist: journal data never supplies SQL identifiers. Keep this in sync
// with the shared persistence schema contract for the SQLite and PostgreSQL providers.
const entities: Record<string, EntitySpec> = {
  // Revisions are local to a database, not a portable identity. SELECT * journal
  // snapshots may carry one, but replay must let the target's triggers manage it.
  articles: { table: "articles", primaryKey: ["id"], columns: ["id", "author_id", "slug", "status", "work_type", "created_at", "updated_at", "published_at", "deleted_at", "idempotency_key_hash", "request_hash", "view_count"], derivedColumns: ["import_revision"] },
  article_translations: { table: "article_translations", primaryKey: ["article_id", "locale"], columns: ["article_id", "locale", "title", "summary", "content_blocks", "content_blocks_version", "created_at", "updated_at"], jsonColumns: ["content_blocks"], requiredColumns: ["content_blocks"], derivedColumns: ["content_search_text"] },
  article_likes: { table: "article_likes", primaryKey: ["article_id", "user_id"], columns: ["article_id", "user_id", "created_at"] },
  article_comments: { table: "article_comments", primaryKey: ["id"], columns: ["id", "article_id", "author_id", "parent_comment_id", "content", "content_blocks", "content_blocks_version", "idempotency_key_hash", "request_hash", "edited_at", "created_at", "updated_at"], jsonColumns: ["content_blocks"] },
  taxonomies: { table: "taxonomies", primaryKey: ["id"], columns: ["id", "kind", "slug", "created_by", "created_at"] },
  taxonomy_translations: { table: "taxonomy_translations", primaryKey: ["taxonomy_id", "locale"], columns: ["taxonomy_id", "locale", "name", "description", "created_at", "updated_at"] },
  article_taxonomies: { table: "article_taxonomies", primaryKey: ["article_id", "taxonomy_id"], columns: ["article_id", "taxonomy_id", "created_at"] },
  user_profiles: { table: "user_profiles", primaryKey: ["user_id"], columns: ["user_id", "avatar_url", "avatar_media_id", "role", "website_url", "created_at", "updated_at"], requiredColumns: ["role"], requiredKeys: ["avatar_url", "avatar_media_id"] },
  user_profile_translations: { table: "user_profile_translations", primaryKey: ["user_id", "locale"], columns: ["user_id", "locale", "display_name", "bio", "created_at", "updated_at"] },
  user_follows: { table: "user_follows", primaryKey: ["follower_id", "followed_id"], columns: ["follower_id", "followed_id", "created_at"] },
  conversations: { table: "conversations", primaryKey: ["id"], columns: ["id", "created_by", "created_at", "idempotency_key_hash", "request_hash", "last_message_sequence"], requiredColumns: ["last_message_sequence"] },
  conversation_participants: { table: "conversation_participants", primaryKey: ["conversation_id", "user_id"], columns: ["conversation_id", "user_id", "joined_at", "left_at", "last_read_at", "last_read_sequence"], requiredColumns: ["last_read_sequence"] },
  messages: { table: "messages", primaryKey: ["id"], columns: ["id", "conversation_id", "sender_id", "body", "idempotency_key", "request_hash", "created_at", "conversation_sequence"], requiredColumns: ["conversation_sequence"] },
  notifications: { table: "notifications", primaryKey: ["id"], columns: ["id", "user_id", "event_key", "payload", "payload_hash", "created_at", "read_at"], jsonColumns: ["payload"] },
  outbox_events: { table: "outbox_events", primaryKey: ["id"], columns: ["id", "event_key", "event_type", "aggregate_id", "payload", "attempts", "available_at", "created_at", "delivered_at", "lease_token", "dead_lettered_at"], jsonColumns: ["payload"], requiredKeys: ["dead_lettered_at"] },
  revoked_sessions: { table: "revoked_sessions", primaryKey: ["session_id"], columns: ["session_id", "revoked_at", "expires_at"], requiredColumns: ["revoked_at", "expires_at"] },
  auth_accounts: { table: "auth_accounts", primaryKey: ["user_id"], columns: ["user_id", "email", "password_hash", "created_at", "email_verified_at"], requiredColumns: ["email", "password_hash", "created_at"], requiredKeys: ["email_verified_at"] },
  auth_sessions: { table: "auth_sessions", primaryKey: ["id"], columns: ["id", "user_id", "expires_at", "revoked_at", "created_at"], requiredColumns: ["user_id", "expires_at", "created_at"], requiredKeys: ["revoked_at"] },
  auth_access_tokens: { table: "auth_access_tokens", primaryKey: ["token_id"], columns: ["token_id", "session_id", "expires_at"], requiredColumns: ["session_id", "expires_at"] },
  auth_refresh_tokens: { table: "auth_refresh_tokens", primaryKey: ["token_hash"], columns: ["token_hash", "session_id", "used_at", "created_at"], requiredColumns: ["session_id", "created_at"], requiredKeys: ["used_at"] },
  auth_identity_tokens: { table: "auth_identity_tokens", primaryKey: ["token_hash"], columns: ["token_hash", "user_id", "purpose", "email", "created_at", "expires_at", "consumed_at"], requiredColumns: ["user_id", "purpose", "email", "created_at", "expires_at"], requiredKeys: ["consumed_at"] },
  auth_rate_limits: { table: "auth_rate_limits", primaryKey: ["key"], columns: ["key", "attempts", "reset_at"], requiredColumns: ["attempts", "reset_at"] },
  featured_articles: { table: "featured_articles", primaryKey: ["article_id"], columns: ["article_id", "position", "created_by", "created_at"], requiredColumns: ["position", "created_by", "created_at"] },
  media_assets: { table: "media_assets", primaryKey: ["id"], columns: ["id", "owner_id", "storage_key", "content_type", "byte_size", "width", "height", "sha256", "created_at"] },
  // Provenance travels with the data (ADR 0037). If a cutover dropped these rows
  // the next import would treat every page as new and create a second copy of a
  // work it had already imported — the exact failure the table prevents.
  external_content_links: { table: "external_content_links", primaryKey: ["provider", "external_id", "locale"], columns: ["provider", "external_id", "locale", "article_id", "owner_id", "digest", "synced_at"], requiredColumns: ["article_id", "owner_id", "digest", "synced_at"] },
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

const sensitiveTimestamps: Record<string, readonly string[]> = {
  auth_accounts: ["created_at", "email_verified_at"],
  auth_sessions: ["expires_at", "revoked_at", "created_at"],
  auth_access_tokens: ["expires_at"],
  auth_refresh_tokens: ["used_at", "created_at"],
  auth_identity_tokens: ["created_at", "expires_at", "consumed_at"],
  auth_rate_limits: ["reset_at"],
  revoked_sessions: ["revoked_at", "expires_at"],
  featured_articles: ["created_at"],
  outbox_events: ["dead_lettered_at"],
};
const sensitiveText: Record<string, readonly string[]> = {
  auth_accounts: ["email", "password_hash"],
  auth_sessions: ["user_id"],
  auth_access_tokens: ["session_id"],
  auth_refresh_tokens: ["session_id"],
  auth_identity_tokens: ["user_id", "email"],
  featured_articles: ["created_by"],
};

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
}

function validateSensitiveFields(entityType: string, input: Record<string, unknown>): void {
  for (const column of sensitiveTimestamps[entityType] ?? []) {
    const value = input[column];
    if (value === null) continue; // Nullable timestamps were required by key above.
    if (!isValidTimestamp(value)) {
      throw new MigrationJournalError("INVALID_PAYLOAD", entityType + "." + column + " must be a valid timezone-qualified timestamp.");
    }
  }
  for (const column of sensitiveText[entityType] ?? []) {
    const value = input[column];
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
      throw new MigrationJournalError("INVALID_PAYLOAD", entityType + "." + column + " must be a non-empty trimmed string.");
    }
  }
  const digestColumn = entityType === "auth_rate_limits" ? "key" :
    entityType === "auth_identity_tokens" || entityType === "auth_refresh_tokens" ? "token_hash" : null;
  if (digestColumn && (typeof input[digestColumn] !== "string" || !/^[a-f0-9]{64}$/.test(input[digestColumn] as string))) {
    throw new MigrationJournalError("INVALID_PAYLOAD", entityType + "." + digestColumn + " must be a SHA-256 hex digest.");
  }
  if (entityType === "auth_identity_tokens" && input.purpose !== "password_reset" && input.purpose !== "email_verification") {
    throw new MigrationJournalError("INVALID_PAYLOAD", "Identity token purpose is unsupported.");
  }
  if (entityType === "auth_rate_limits" && (!Number.isSafeInteger(input.attempts) || (input.attempts as number) < 1 || (input.attempts as number) > 2_147_483_647)) {
    throw new MigrationJournalError("INVALID_PAYLOAD", "Rate-limit attempts must be a positive 32-bit integer.");
  }
  if (entityType === "featured_articles" && (!Number.isSafeInteger(input.position) || (input.position as number) < 0 || (input.position as number) >= MAX_FEATURED_ARTICLES)) {
    throw new MigrationJournalError("INVALID_PAYLOAD", "Featured position must be a valid shelf index.");
  }
}

export function prepareMigrationRowPayload(
  targetProvider: "sqlite" | "postgres",
  entityType: string,
  entityId: string,
  input: Record<string, unknown>,
): { spec: EntitySpec; primaryKeyValues: string[]; payload: Record<string, unknown>; columns: string[]; values: unknown[]; articleMediaRefs: string[] | null } {
  const spec = getMigrationEntitySpec(entityType);
  // A derived column belongs to the provider that computes it (ADR 0030). If a
  // payload carries one — a capture that selected the whole row, an older
  // journal — it is dropped here instead of being replayed into a provider that
  // may have no such column, and instead of failing the whole batch over a value
  // nobody needs to copy.
  const derived = spec.derivedColumns ?? [];
  if (derived.length > 0) {
    const carried: Record<string, unknown> = { ...input };
    for (const column of derived) delete carried[column];
    input = carried;
  }
  const isTranslation = entityType === "article_translations";
  const unknownColumns = Object.keys(input).filter(column => !spec.columns.includes(column) && !(isTranslation && column === ARTICLE_MEDIA_REFS_SNAPSHOT));
  if (unknownColumns.length) throw new MigrationJournalError("UNSUPPORTED_COLUMN", "Migration payload contains unsupported columns for " + entityType + ": " + unknownColumns.join(", ") + ".");
  // Old snapshots cannot safely reconstruct unread state or avatar references.
  // Nullable required keys are checked for presence rather than non-nullness.
  const missingRequired = [
    ...(spec.requiredColumns ?? []).filter(column => input[column] == null),
    ...(spec.requiredKeys ?? []).filter(column => !Object.hasOwn(input, column) || input[column] === undefined),
  ];
  if (missingRequired.length) throw new MigrationJournalError("INCOMPATIBLE_SCHEMA", "Migration snapshot has an incompatible schema for " + entityType + "; missing required fields: " + missingRequired.join(", ") + ".");
  validateSensitiveFields(entityType, input);
  let articleMediaRefs: string[] | null = null;
  if (isTranslation) {
    const value = input[ARTICLE_MEDIA_REFS_SNAPSHOT];
    if (!Array.isArray(value)) throw new MigrationJournalError("INCOMPATIBLE_SCHEMA", "Article translation lacks its complete media reference snapshot.");
    if (value.some(id => typeof id !== "string" || !id.length || id.length > 512) || new Set(value).size !== value.length) {
      throw new MigrationJournalError("INVALID_PAYLOAD", "Article media reference snapshot must contain distinct non-empty asset IDs.");
    }
    articleMediaRefs = value as string[];
  }
  if (entityType === "user_profiles" && input.avatar_media_id !== null && (typeof input.avatar_media_id !== "string" || !input.avatar_media_id.length)) {
    throw new MigrationJournalError("INVALID_PAYLOAD", "Profile avatar media reference must be a non-empty asset ID or null.");
  }
  const missingKeys = spec.primaryKey.filter(column => typeof input[column] !== "string" || !(input[column] as string).length);
  if (missingKeys.length) throw new MigrationJournalError("INVALID_ENTITY_KEY", "Upsert payload is missing primary-key field(s): " + missingKeys.join(", ") + ".");
  const primaryKeyValues = migrationEntityKeyValues(entityId, spec.primaryKey);
  for (let index = 0; index < spec.primaryKey.length; index += 1) {
    if ((input[spec.primaryKey[index]] as string) !== primaryKeyValues[index]) {
      throw new MigrationJournalError("ENTITY_KEY_MISMATCH", "Migration entity ID does not match the row's primary-key value.");
    }
  }
  const columns = Object.keys(input).filter(column => !(isTranslation && column === ARTICLE_MEDIA_REFS_SNAPSHOT)).sort();
  const jsonColumns = new Set(spec.jsonColumns ?? []);
  const payload: Record<string, unknown> = {};
  for (const column of columns) {
    const value = input[column];
    payload[column] = jsonColumns.has(column) ? normalizeJson(value, targetProvider, entityType, column) : value;
  }
  return { spec, primaryKeyValues, payload, columns, values: columns.map(column => payload[column]), articleMediaRefs };
}

export function getSupportedMigrationEntityTypes(): string[] {
  return Object.keys(entities).sort();
}

export function assertMigrationTargetProvider(value: MigrationProvider): asserts value is "sqlite" | "postgres" {
  if (value !== "sqlite" && value !== "postgres") {
    throw new MigrationJournalError("UNSUPPORTED_TARGET_PROVIDER", "MongoDB replay is not implemented yet.");
  }
}
