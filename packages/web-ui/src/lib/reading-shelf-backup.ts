import { parseShelfRecord, SHELF_LIMIT, shelfIdentity, shelfTimestamp, type ShelfRecord } from "./reading-shelf.ts";

export const SHELF_BACKUP_BYTES = 1_048_576;
export type ShelfImportMode = "keep" | "replace";
export type ShelfBackupProblem = "size" | "syntax" | "version" | "entry" | "duplicate" | "limit";
export type ShelfBackupResult = { ok: true; entries: ShelfRecord[] } | { ok: false; code: ShelfBackupProblem };
export type ShelfImportPlan = { ok: true; writes: ShelfRecord[]; added: number; replaced: number; kept: number } | { ok: false; code: "limit" | "entry" | "duplicate" };

/** Consent tokens and local mutation revisions are deliberately not portable. */
export function serializeShelfBackup(entries: readonly ShelfRecord[], exportedAt: number): string {
  if (entries.length > SHELF_LIMIT || !shelfTimestamp(exportedAt)) throw new Error("Invalid reading-list export");
  const safe = entries.map(entry => {
    const record = parseShelfRecord(entry);
    if (!record) throw new Error("Invalid reading-list entry");
    return { ...record, tracking: null, revision: "imported" };
  });
  return JSON.stringify({ format: "no-wave-reading-list", version: 1, exportedAt, entries: safe }, null, 2);
}

/** One damaged entry rejects the preview; no implicit partial recovery or data erasure. */
export function parseShelfBackup(source: string): ShelfBackupResult {
  if (source.length > SHELF_BACKUP_BYTES || new TextEncoder().encode(source).byteLength > SHELF_BACKUP_BYTES) return { ok: false, code: "size" };
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { ok: false, code: "syntax" }; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "syntax" };
  const data = value as Record<string, unknown>;
  if (data.format !== "no-wave-reading-list" || data.version !== 1) return { ok: false, code: "version" };
  if (!shelfTimestamp(data.exportedAt) || !Array.isArray(data.entries)) return { ok: false, code: "entry" };
  if (data.entries.length > SHELF_LIMIT) return { ok: false, code: "limit" };
  const identities = new Set<string>();
  const entries: ShelfRecord[] = [];
  for (const candidate of data.entries) {
    const record = parseShelfRecord(candidate);
    if (!record) return { ok: false, code: "entry" };
    const identity = shelfIdentity(record);
    if (identities.has(identity)) return { ok: false, code: "duplicate" };
    identities.add(identity);
    entries.push({ ...record, tracking: null, revision: "imported" });
  }
  return { ok: true, entries };
}

export function planShelfImport(existing: readonly ShelfRecord[], incoming: readonly ShelfRecord[], mode: ShelfImportMode, reserved: number): ShelfImportPlan {
  if (!Number.isSafeInteger(reserved) || reserved < 0 || (mode !== "keep" && mode !== "replace")) return { ok: false, code: "entry" };
  if (incoming.length > SHELF_LIMIT) return { ok: false, code: "limit" };
  const old = new Map(existing.map(record => [shelfIdentity(record), record]));
  const seen = new Set<string>();
  const writes: ShelfRecord[] = [];
  let added = 0, replaced = 0, kept = 0;
  for (const candidate of incoming) {
    const record = parseShelfRecord(candidate);
    if (!record) return { ok: false, code: "entry" };
    const identity = shelfIdentity(record);
    if (seen.has(identity)) return { ok: false, code: "duplicate" };
    seen.add(identity);
    const previous = old.get(identity);
    if (previous && mode === "keep") { kept++; continue; }
    if (previous) replaced++;
    else added++;
    writes.push({ ...record, tracking: null, savedAt: previous?.savedAt ?? record.savedAt });
    const last = writes.at(-1)!;
    last.updatedAt = Math.max(last.savedAt, record.updatedAt);
  }
  if (existing.length + reserved + added > SHELF_LIMIT) return { ok: false, code: "limit" };
  return { ok: true, writes, added, replaced, kept };
}
