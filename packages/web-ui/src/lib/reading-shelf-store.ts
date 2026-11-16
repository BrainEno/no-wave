import { parseReadingPosition, type ReadingPosition } from "./reading-position.ts";
import { planShelfImport, type ShelfImportMode } from "./reading-shelf-backup.ts";
import { parseShelfMetadata, parseShelfRecord, SHELF_LIMIT, shelfIdentity, shelfTimestamp, shelfToken, type ShelfMetadata, type ShelfRecord, type ShelfState } from "./reading-shelf.ts";

export const SHELF_STORAGE_PREFIX = "nw-reading-list-v1:";
export type ShelfStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type ShelfProblem = "unavailable" | "unsupported" | "quota" | "changed" | "corrupt" | "missing" | "limit" | "entry" | "duplicate";
export type ShelfWriteResult = { ok: true; applied: number } | { ok: false; code: ShelfProblem; applied: number };
export type ShelfSnapshot = Readonly<{ status: "loading" | "ready" | "unavailable"; entries: readonly ShelfRecord[]; invalid: number; stamp: string }>;
export type ShelfUpdate = { state?: ShelfState; tracking?: boolean; metadata?: ShelfMetadata; resetPosition?: boolean };
const EMPTY: ShelfSnapshot = Object.freeze({ status: "loading", entries: Object.freeze([]), invalid: 0, stamp: "" });
const MAX_STORAGE_KEYS = 10_000;
const MAX_RECORD_BYTES = 8192;

/** A per-provider store. It has no browser access until connect; SSR can only see EMPTY. */
export function createReadingShelfStore({ now = Date.now, nonce = () => crypto.randomUUID() }: { now?: () => number; nonce?: () => string } = {}) {
  let storage: ShelfStorage | null = null;
  let snapshot = EMPTY;
  let rawEntries = new Map<string, string>();
  const listeners = new Set<() => void>();
  const publish = (next: ShelfSnapshot) => {
    if (next.status === snapshot.status && next.stamp === snapshot.stamp) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const failure = (code: ShelfProblem, applied = 0): ShelfWriteResult => ({ ok: false, code, applied });
  const success = (applied: number): ShelfWriteResult => ({ ok: true, applied });
  const errorCode = (error: unknown): ShelfProblem => error instanceof Error && error.name === "QuotaExceededError" ? "quota" : "unavailable";

  function refresh(): boolean {
    if (!storage) { publish({ ...snapshot, status: "unavailable" }); return false; }
    try {
      if (storage.length > MAX_STORAGE_KEYS) throw new Error("Reading-list storage inventory exceeds its bound");
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(SHELF_STORAGE_PREFIX)) keys.push(key);
      }
      keys.sort();
      const nextRaw = new Map<string, string>();
      const entries: ShelfRecord[] = [];
      let invalid = 0;
      for (const key of keys) {
        const source = storage.getItem(key);
        if (source === null) continue;
        nextRaw.set(key, source);
        let candidate: unknown;
        try { candidate = source.length <= MAX_RECORD_BYTES ? JSON.parse(source) : null; } catch { candidate = null; }
        const record = parseShelfRecord(candidate);
        if (!record || key !== SHELF_STORAGE_PREFIX + shelfIdentity(record)) { invalid++; continue; }
        entries.push(Object.freeze({ ...record, position: record.position ? Object.freeze(record.position) : null }));
      }
      const stamp = JSON.stringify([...nextRaw]);
      rawEntries = nextRaw;
      publish({ status: "ready", entries: Object.freeze(entries), invalid, stamp });
      return true;
    } catch {
      publish({ ...snapshot, status: "unavailable" });
      return false;
    }
  }

  function freshRecord(identity: string): { record: ShelfRecord | null; raw: string | null } {
    const raw = storage!.getItem(SHELF_STORAGE_PREFIX + identity);
    if (raw === null) return { record: null, raw };
    let value: unknown;
    try { value = raw.length <= MAX_RECORD_BYTES ? JSON.parse(raw) : null; } catch { value = null; }
    const record = parseShelfRecord(value);
    return { record: record && shelfIdentity(record) === identity ? record : null, raw };
  }

  function write(record: ShelfRecord, expected: string | null): ShelfWriteResult {
    const safe = parseShelfRecord(record);
    if (!safe) return failure("entry");
    const key = SHELF_STORAGE_PREFIX + shelfIdentity(safe);
    if (storage!.getItem(key) !== expected) return failure("changed");
    const encoded = JSON.stringify(safe);
    if (encoded.length > MAX_RECORD_BYTES) return failure("entry");
    storage!.setItem(key, encoded);
    return storage!.getItem(key) === encoded ? success(1) : failure("changed");
  }

  function mutate(run: () => ShelfWriteResult): ShelfWriteResult {
    if (!refresh()) return failure("unavailable");
    let result: ShelfWriteResult;
    try { result = run(); } catch (error: unknown) { result = failure(errorCode(error)); }
    refresh();
    return result;
  }

  function nextRevision(): string {
    const token = nonce();
    if (!shelfToken(token)) throw new Error("Invalid local mutation token");
    return token;
  }

  function timeAtLeast(minimum = 0): number {
    const instant = now();
    if (!shelfTimestamp(instant)) throw new Error("Invalid local clock");
    return Math.max(instant, minimum);
  }

  function save(metadata: ShelfMetadata): ShelfWriteResult {
    return mutate(() => {
      const safe = parseShelfMetadata(metadata);
      if (!safe) return failure("entry");
      const old = freshRecord(shelfIdentity(safe));
      if (old.record) return success(0);
      if (old.raw !== null) return failure("corrupt");
      if (rawEntries.size >= SHELF_LIMIT) return failure("limit");
      const instant = timeAtLeast();
      return write({ ...safe, version: 1, state: "later", savedAt: instant, updatedAt: instant, revision: nextRevision(), tracking: null, position: null }, null);
    });
  }

  function update(identity: string, revision: string, change: ShelfUpdate): ShelfWriteResult {
    return mutate(() => {
      const old = freshRecord(identity);
      if (!old.record) return failure(old.raw === null ? "missing" : "corrupt");
      if (old.record.revision !== revision) return failure("changed");
      const next = { ...old.record, revision: nextRevision(), updatedAt: timeAtLeast(old.record.updatedAt) };
      if (change.metadata !== undefined) {
        const metadata = parseShelfMetadata(change.metadata);
        if (!metadata || shelfIdentity(metadata) !== identity) return failure("entry");
        Object.assign(next, metadata);
      }
      if (change.state !== undefined) {
        next.state = change.state;
        if (change.state !== "reading") next.tracking = null;
      }
      if (change.tracking !== undefined) {
        next.tracking = change.tracking ? nextRevision() : null;
        if (change.tracking) next.state = "reading";
      }
      if (change.resetPosition) { next.position = null; next.tracking = null; }
      return write(next, old.raw);
    });
  }

  function checkpoint(identity: string, consent: string, position: ReadingPosition): ShelfWriteResult {
    return mutate(() => {
      const old = freshRecord(identity);
      if (!old.record || old.record.tracking !== consent || !consent || old.record.state !== "reading") return failure("changed");
      const safe = parseReadingPosition(position);
      if (!safe) return failure("entry");
      if (JSON.stringify(old.record.position) === JSON.stringify(safe)) return success(0);
      return write({ ...old.record, position: safe, revision: nextRevision(), updatedAt: timeAtLeast(old.record.updatedAt) }, old.raw);
    });
  }

  function remove(identity: string, revision: string): ShelfWriteResult {
    return mutate(() => {
      const old = freshRecord(identity);
      if (!old.record) return failure(old.raw === null ? "missing" : "corrupt");
      if (old.record.revision !== revision) return failure("changed");
      const key = SHELF_STORAGE_PREFIX + identity;
      if (storage!.getItem(key) !== old.raw) return failure("changed");
      storage!.removeItem(key);
      return storage!.getItem(key) === null ? success(1) : failure("changed");
    });
  }

  function clear(expectedStamp: string): ShelfWriteResult {
    return mutate(() => {
      if (snapshot.stamp !== expectedStamp) return failure("changed");
      let applied = 0;
      try {
        for (const [key, expected] of rawEntries) {
          if (storage!.getItem(key) !== expected) return failure("changed", applied);
          storage!.removeItem(key);
          if (storage!.getItem(key) !== null) return failure("changed", applied);
          applied++;
        }
        return success(applied);
      } catch (error: unknown) { return failure(errorCode(error), applied); }
    });
  }

  /** Multi-key browser storage is not transactional: report partial confirmation explicitly. */
  function importRecords(incoming: readonly ShelfRecord[], mode: ShelfImportMode, expectedStamp: string): ShelfWriteResult {
    return mutate(() => {
      if (snapshot.stamp !== expectedStamp) return failure("changed");
      const plan = planShelfImport(snapshot.entries, incoming, mode, snapshot.invalid);
      if (!plan.ok) return failure(plan.code);
      const expected = new Map<string, string | null>();
      for (const record of plan.writes) {
        const identity = shelfIdentity(record);
        const old = freshRecord(identity);
        if (old.raw !== null && !old.record) return failure("corrupt");
        expected.set(identity, old.raw);
      }
      let applied = 0;
      try {
        for (const candidate of plan.writes) {
          const record = { ...candidate, tracking: null, revision: nextRevision(), updatedAt: timeAtLeast(candidate.updatedAt) };
          const result = write(record, expected.get(shelfIdentity(record)) ?? null);
          if (!result.ok) return failure(result.code, applied);
          applied += result.applied;
        }
        return success(applied);
      } catch (error: unknown) { return failure(errorCode(error), applied); }
    });
  }

  function batch(selection: readonly { identity: string; revision: string }[], operation: ShelfState | "remove"): ShelfWriteResult {
    return mutate(() => {
      if (selection.length === 0) return success(0);
      if (selection.length > SHELF_LIMIT || !["later", "reading", "finished", "remove"].includes(operation)) return failure("entry");
      const seen = new Set<string>();
      const prepared: { record: ShelfRecord; raw: string }[] = [];
      for (const selected of selection) {
        if (seen.has(selected.identity)) return failure("duplicate");
        seen.add(selected.identity);
        const old = freshRecord(selected.identity);
        if (!old.record || old.raw === null || old.record.revision !== selected.revision) return failure("changed");
        prepared.push({ record: old.record, raw: old.raw });
      }
      let applied = 0;
      try {
        for (const { record, raw } of prepared) {
          const key = SHELF_STORAGE_PREFIX + shelfIdentity(record);
          if (storage!.getItem(key) !== raw) return failure("changed", applied);
          if (operation === "remove") {
            storage!.removeItem(key);
            if (storage!.getItem(key) !== null) return failure("changed", applied);
          } else {
            const result = write({ ...record, state: operation, tracking: operation === "reading" ? record.tracking : null,
              revision: nextRevision(), updatedAt: timeAtLeast(record.updatedAt) }, raw);
            if (!result.ok) return failure(result.code, applied);
          }
          applied++;
        }
        return success(applied);
      } catch (error: unknown) { return failure(errorCode(error), applied); }
    });
  }

  return {
    getSnapshot: (): ShelfSnapshot => snapshot,
    getServerSnapshot: (): ShelfSnapshot => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect(next: ShelfStorage | null) { storage = next; refresh(); },
    disconnect() { storage = null; },
    refresh, save, update, checkpoint, remove, clear, importRecords, batch,
  };
}
export type ReadingShelfStore = ReturnType<typeof createReadingShelfStore>;
