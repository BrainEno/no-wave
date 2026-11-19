import { isNotificationActor } from "./notification-transport.ts";
import {
  RECOVERY_LIMITS,
  WritingRecoveryFault,
  parseRecoveryBase,
  parseRecoveryControl,
  parseRecoveryEntry,
  recoveryId,
  recoverySize,
  recoveryTime,
  type RecoveryInput,
  type RecoveryLease,
  type RecoveryEntry,
  type RecoveryView,
  type RecoveryControl,
} from "./writing-recovery-model.ts";

export const WRITING_RECOVERY_DATABASE = "no-wave-writing-recovery-v1";
export type WritingRecoveryStore = {
  inspect(): Promise<string | null>;
  attach(actor: string, control: string | null): Promise<RecoveryView>;
  enable(actor: string, control: string | null): Promise<RecoveryView>;
  read(lease: RecoveryLease): Promise<RecoveryEntry[]>;
  put(
    lease: RecoveryLease,
    input: RecoveryInput,
    now: number,
  ): Promise<RecoveryEntry>;
  settle(
    lease: RecoveryLease,
    id: string,
    writer: string,
    revision: number,
  ): Promise<RecoveryEntry>;
  remove(lease: RecoveryLease, id: string, revision: number): Promise<void>;
  revoke(control: string | null): Promise<void>;
  purge(): Promise<void>;
};
type Dataset = { control: RecoveryControl | null; entries: RecoveryEntry[] };
type TransactionWork<T> = (
  tx: IDBTransaction,
  finish: (value: T) => void,
  guard: (work: () => void) => void,
) => void;
function storageFault(error: unknown): WritingRecoveryFault {
  if (error instanceof WritingRecoveryFault) return error;
  const name = error instanceof Error ? error.name : "";
  return new WritingRecoveryFault(
    name === "QuotaExceededError"
      ? "quota"
      : name === "VersionError" || name === "DataError"
        ? "invalid"
        : "unavailable",
  );
}

/** The metadata fence and all manuscripts share one serializable IDB transaction.
 * Request success is not commit; no promise resolves until transaction complete.
 * This is crash-oriented browser recovery, not a physical-durability guarantee. */
export class IndexedWritingRecoveryStore implements WritingRecoveryStore {
  private factory: () => IDBFactory;
  private name: string;
  private id: () => string;
  private timeoutMs: number;
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private cancelOpening: (() => void) | null = null;
  constructor(
    options: {
      factory?: () => IDBFactory;
      name?: string;
      id?: () => string;
      timeoutMs?: number;
    } = {},
  ) {
    this.factory = options.factory ?? (() => indexedDB);
    this.name = options.name ?? WRITING_RECOVERY_DATABASE;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.timeoutMs = options.timeoutMs ?? 4000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 10_000
    )
      throw new WritingRecoveryFault("invalid");
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return Promise.resolve(this.database);
    if (this.opening) return this.opening;
    const operation = new Promise<IDBDatabase>((resolve, reject) => {
      let done = false;
      const fail = (error: unknown) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(storageFault(error));
        }
      };
      const timer = setTimeout(
        () => fail(new WritingRecoveryFault("timeout")),
        this.timeoutMs,
      );
      this.cancelOpening = () => fail(new WritingRecoveryFault("unavailable"));
      try {
        const request = this.factory().open(this.name, 1);
        request.onblocked = () => fail(new WritingRecoveryFault("blocked"));
        request.onerror = () => fail(request.error);
        request.onupgradeneeded = (event) => {
          try {
            if (done || event.oldVersion !== 0) {
              request.transaction?.abort();
              return;
            }
            request.result.createObjectStore("control");
            request.result.createObjectStore("drafts", { keyPath: "id" });
          } catch (error) {
            request.transaction?.abort();
            fail(error);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (done) {
            db.close();
            return;
          }
          if (
            db.objectStoreNames.length !== 2 ||
            !db.objectStoreNames.contains("control") ||
            !db.objectStoreNames.contains("drafts")
          ) {
            db.close();
            fail(new WritingRecoveryFault("invalid"));
            return;
          }
          done = true;
          clearTimeout(timer);
          db.onversionchange = () => {
            db.close();
            if (this.database === db) this.database = null;
          };
          db.onclose = () => {
            if (this.database === db) this.database = null;
          };
          this.database = db;
          resolve(db);
        };
      } catch (error) {
        fail(error);
      }
    });
    this.opening = operation;
    const release = () => {
      if (this.opening === operation) {
        this.opening = null;
        this.cancelOpening = null;
      }
    };
    void operation.then(release, release);
    return operation;
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    work: TransactionWork<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(["control", "drafts"], mode, {
          durability: "strict",
        });
      } catch (error) {
        reject(storageFault(error));
        return;
      }
      let settled = false,
        ready = false;
      let result: T;
      let problem: unknown;
      const rejectOnce = (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(storageFault(error));
        }
      };
      const fail = (error: unknown) => {
        problem = error;
        try {
          tx.abort();
        } catch {
          rejectOnce(error);
        }
      };
      const timer = setTimeout(() => {
        fail(new WritingRecoveryFault("timeout"));
        rejectOnce(new WritingRecoveryFault("timeout"));
      }, this.timeoutMs);
      tx.onabort = () => rejectOnce(problem ?? tx.error);
      tx.onerror = (event) => {
        problem ??= (event.target as IDBRequest | null)?.error ?? tx.error;
      };
      tx.oncomplete = () => {
        if (settled) return;
        if (!ready) {
          rejectOnce(new WritingRecoveryFault("invalid"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const guard = (callback: () => void) => {
        if (!settled) {
          try {
            callback();
          } catch (error) {
            fail(error);
          }
        }
      };
      guard(() =>
        work(
          tx,
          (value) => {
            result = value;
            ready = true;
          },
          guard,
        ),
      );
    });
  }
  private load(
    tx: IDBTransaction,
    guard: (work: () => void) => void,
    next: (dataset: Dataset) => void,
  ): void {
    const control = tx.objectStore("control").get("active");
    const entries = tx
      .objectStore("drafts")
      .getAll(undefined, RECOVERY_LIMITS.entries + 1);
    let controlsReady = false,
      entriesReady = false;
    const complete = () => {
      if (!controlsReady || !entriesReady) return;
      const metadata =
        control.result === undefined
          ? null
          : parseRecoveryControl(control.result);
      const rows = (entries.result as unknown[]).map(parseRecoveryEntry);
      if (
        rows.length > RECOVERY_LIMITS.entries ||
        rows.reduce((sum, row) => sum + recoverySize(row), 0) >
          RECOVERY_LIMITS.bytes ||
        rows.some(
          (row) =>
            !metadata?.enabled ||
            row.actor !== metadata.actor ||
            row.epoch !== metadata.epoch ||
            row.revision > metadata.serial,
        ) ||
        new Set(rows.map((row) => row.revision)).size !== rows.length
      )
        throw new WritingRecoveryFault("invalid");
      rows.sort((a, b) => b.revision - a.revision);
      next({ control: metadata, entries: rows });
    };
    control.onsuccess = () =>
      guard(() => {
        controlsReady = true;
        complete();
      });
    entries.onsuccess = () =>
      guard(() => {
        entriesReady = true;
        complete();
      });
  }
  private freshControl(
    actor: string | null,
    enabled: boolean,
  ): RecoveryControl {
    const epoch = this.id();
    if (!recoveryId(epoch)) throw new WritingRecoveryFault("unavailable");
    return { version: 1, epoch, actor, enabled, serial: 0 };
  }
  private checkWitness(
    control: RecoveryControl | null,
    witness: string | null,
  ) {
    if ((control?.epoch ?? null) !== witness)
      throw new WritingRecoveryFault("revoked");
  }
  private checkLease(
    control: RecoveryControl | null,
    lease: RecoveryLease,
  ): RecoveryControl {
    if (
      !control?.enabled ||
      control.actor !== lease.actor ||
      control.epoch !== lease.epoch
    )
      throw new WritingRecoveryFault("revoked");
    return control;
  }
  private advance(control: RecoveryControl): RecoveryControl {
    if (control.serial >= Number.MAX_SAFE_INTEGER)
      throw new WritingRecoveryFault("limit");
    return { ...control, serial: control.serial + 1 };
  }
  async inspect(): Promise<string | null> {
    return this.transaction("readonly", (tx, finish, guard) => {
      const request = tx.objectStore("control").get("active");
      request.onsuccess = () =>
        guard(() =>
          finish(
            request.result === undefined
              ? null
              : parseRecoveryControl(request.result).epoch,
          ),
        );
    });
  }
  private enter(
    actor: string,
    witness: string | null,
    enable: boolean,
  ): Promise<RecoveryView> {
    if (
      !isNotificationActor(actor) ||
      (witness !== null && !recoveryId(witness))
    )
      return Promise.reject(new WritingRecoveryFault("invalid"));
    return this.transaction("readwrite", (tx, finish, guard) =>
      this.load(tx, guard, (data) => {
        this.checkWitness(data.control, witness);
        let control = data.control,
          entries = data.entries;
        if (
          control?.actor !== null &&
          control?.actor !== undefined &&
          control.actor !== actor
        ) {
          entries = [];
          tx.objectStore("drafts").clear();
          control = this.freshControl(null, false);
          tx.objectStore("control").put(control, "active");
        }
        if (enable && !control?.enabled) {
          control = this.freshControl(actor, true);
          entries = [];
          tx.objectStore("drafts").clear();
          tx.objectStore("control").put(control, "active");
        }
        finish({
          control: control?.epoch ?? null,
          lease: control?.enabled ? { actor, epoch: control.epoch } : null,
          entries: control?.enabled ? entries : [],
        });
      }),
    );
  }
  attach(actor: string, control: string | null): Promise<RecoveryView> {
    return this.enter(actor, control, false);
  }
  enable(actor: string, control: string | null): Promise<RecoveryView> {
    return this.enter(actor, control, true);
  }
  read(lease: RecoveryLease): Promise<RecoveryEntry[]> {
    return this.transaction("readonly", (tx, finish, guard) =>
      this.load(tx, guard, (data) => {
        this.checkLease(data.control, lease);
        finish(data.entries);
      }),
    );
  }
  put(
    lease: RecoveryLease,
    input: RecoveryInput,
    now: number,
  ): Promise<RecoveryEntry> {
    return this.transaction("readwrite", (tx, finish, guard) =>
      this.load(tx, guard, (data) => {
        const control = this.advance(this.checkLease(data.control, lease));
        const existing = data.entries.find((row) => row.id === input.id);
        if (
          existing
            ? existing.writer !== input.writer ||
              existing.revision !== input.expectedRevision
            : input.expectedRevision !== null
        )
          throw new WritingRecoveryFault("conflict");
        if (
          !recoveryTime(now) ||
          data.entries.some((row) => row.updatedAt > now)
        )
          throw new WritingRecoveryFault("clock");
        const row = parseRecoveryEntry({
          version: 1,
          id: input.id,
          actor: lease.actor,
          epoch: lease.epoch,
          writer: input.writer,
          revision: control.serial,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          base: parseRecoveryBase(input.base),
          backup: input.backup,
          outcomeUnknown:
            existing?.outcomeUnknown === true || input.outcomeUnknown,
        });
        const retained = data.entries.filter((entry) => entry.id !== row.id);
        if (
          retained.length + 1 > RECOVERY_LIMITS.entries ||
          retained.reduce(
            (sum, entry) => sum + recoverySize(entry),
            recoverySize(row),
          ) > RECOVERY_LIMITS.bytes
        )
          throw new WritingRecoveryFault("limit");
        tx.objectStore("control").put(control, "active");
        tx.objectStore("drafts").put(row);
        finish(row);
      }),
    );
  }
  settle(
    lease: RecoveryLease,
    id: string,
    writer: string,
    revision: number,
  ): Promise<RecoveryEntry> {
    return this.transaction("readwrite", (tx, finish, guard) =>
      this.load(tx, guard, (data) => {
        const control = this.advance(this.checkLease(data.control, lease));
        const prior = data.entries.find((row) => row.id === id);
        if (!prior || prior.revision !== revision || prior.writer !== writer)
          throw new WritingRecoveryFault("conflict");
        const row = {
          ...prior,
          revision: control.serial,
          outcomeUnknown: false,
        };
        tx.objectStore("control").put(control, "active");
        tx.objectStore("drafts").put(row);
        finish(row);
      }),
    );
  }
  remove(lease: RecoveryLease, id: string, revision: number): Promise<void> {
    return this.transaction("readwrite", (tx, finish, guard) =>
      this.load(tx, guard, (data) => {
        const control = this.advance(this.checkLease(data.control, lease));
        const row = data.entries.find((entry) => entry.id === id);
        if (!row || row.revision !== revision)
          throw new WritingRecoveryFault("conflict");
        tx.objectStore("control").put(control, "active");
        tx.objectStore("drafts").delete(id);
        finish(undefined);
      }),
    );
  }
  revoke(witness: string | null): Promise<void> {
    return this.transaction("readwrite", (tx, finish, guard) => {
      const request = tx.objectStore("control").get("active");
      request.onsuccess = () =>
        guard(() => {
          this.checkWitness(
            request.result === undefined
              ? null
              : parseRecoveryControl(request.result),
            witness,
          );
          tx.objectStore("drafts").clear();
          tx.objectStore("control").put(
            this.freshControl(null, false),
            "active",
          );
          finish(undefined);
        });
    });
  }
  purge(): Promise<void> {
    return this.transaction("readwrite", (tx, finish) => {
      // Deliberate deletion must work even if an old/tampered row cannot parse.
      tx.objectStore("control").clear();
      tx.objectStore("drafts").clear();
      tx.objectStore("control").put(this.freshControl(null, false), "active");
      finish(undefined);
    });
  }
  close(): void {
    this.cancelOpening?.();
    this.cancelOpening = null;
    this.opening = null;
    this.database?.close();
    this.database = null;
  }
}
