import { writingSnapshotKey, type WritingDraft } from "./writing-session.ts";
import { createWritingBackup, type WritingField } from "./writing-backup.ts";
import {
  isNotificationActor,
  NotificationRequestError,
} from "./notification-transport.ts";
import {
  applyRecoveryPreview,
  parseRecoveryBase,
  recoveryId,
  recoveryPreview,
  recoveryProblem,
  WritingRecoveryFault,
  type RecoveryBase,
  type RecoveryEntry,
  type RecoveryLease,
  type RecoveryPreview,
} from "./writing-recovery-model.ts";
import { CatalogueReadError } from "./authoring-catalogue-open.ts";
import {
  WritingRecoverySourceReader,
  type RecoverySourceReview,
} from "./writing-recovery-source.ts";
import type { WritingRecoveryStore } from "./writing-recovery-store.ts";

export type RecoverySnapshot = {
  draft: WritingDraft;
  base: RecoveryBase;
  dirty: boolean;
};
export type WritingRecoveryState = {
  status: "idle" | "checking" | "off" | "ready" | "error" | "revoked";
  actor: string | null;
  entries: readonly RecoveryEntry[];
  preview: RecoveryPreview | null;
  saving: boolean;
  savedAt: number | null;
  requiresReview: boolean;
  error: string;
  sourceReview: RecoverySourceReview | null;
  sourceBusy: boolean;
  sourceError: string;
};
export type RecoveryControllerOptions = {
  store: WritingRecoveryStore;
  sourceReader?: Pick<WritingRecoverySourceReader, "read" | "cancel">;
  actor(signal: AbortSignal): Promise<string>;
  snapshot(): RecoverySnapshot;
  apply?(draft: WritingDraft): void;
  now?: () => number;
  id?: () => string;
  delayMs?: number;
  identityLost?: () => void;
  revoked?: () => void;
};
const EMPTY: WritingRecoveryState = Object.freeze({
  status: "idle",
  actor: null,
  entries: [],
  preview: null,
  saving: false,
  savedAt: null,
  requiresReview: false,
  error: "",
  sourceReview: null,
  sourceBusy: false,
  sourceError: "",
});

/** Owns one mounted editor's branch, never a singleton account or a network retry queue.
 * Every disk action re-verifies the pinned actor; a persisted epoch is only a
 * concurrency fence. It cannot establish identity, revive consent or publish. */
export class WritingRecoveryController {
  private options: RecoveryControllerOptions;
  private state = EMPTY;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private expectedActor: string | null = null;
  private lease: RecoveryLease | null = null;
  private lastEpoch: string | null = null;
  private consented = false;
  private destroyed = false;
  private invalidated = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<boolean> | null = null;
  private entering: Promise<void> | null = null;
  private noteVersion = 0;
  private candidateId: string | null = null;
  private writerId: string | null = null;
  private own: RecoveryEntry | null = null;
  private lastKey = "";
  private uncertain = false;
  private problem: unknown = null;
  private delayMs: number;
  private sourceReader: Pick<WritingRecoverySourceReader, "read" | "cancel">;
  private sourceVersion = 0;
  private offControl: string | null | undefined;
  constructor(options: RecoveryControllerOptions) {
    this.options = options;
    this.sourceReader =
      options.sourceReader ?? new WritingRecoverySourceReader();
    this.delayMs = options.delayMs ?? 600;
    if (
      !Number.isSafeInteger(this.delayMs) ||
      this.delayMs < 100 ||
      this.delayMs > 10_000
    )
      throw new WritingRecoveryFault("invalid");
  }
  getSnapshot = (): WritingRecoveryState => this.state;
  getServerSnapshot = (): WritingRecoveryState => EMPTY;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<WritingRecoveryState>) {
    if (this.destroyed) return;
    if (
      patch.entries &&
      this.state.sourceReview &&
      !patch.entries.some(
        (row) => JSON.stringify(row) === this.state.sourceReview!.witness,
      )
    ) {
      patch = {
        ...patch,
        sourceReview: null,
        sourceError:
          "来源缓存已变化，旧的服务器核对结果已隐藏；请手动重新核对。",
      };
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private current(version: number): boolean {
    return (
      !this.destroyed &&
      this.generation === version &&
      !this.abort.signal.aborted
    );
  }
  private nextGeneration(): number {
    this.clearTimer();
    this.sourceVersion++;
    this.sourceReader.cancel();
    this.abort.abort();
    this.abort = new AbortController();
    return ++this.generation;
  }
  private fail(error: unknown, version: number) {
    if (!this.current(version)) return;
    this.problem = error;
    const revoked =
      error instanceof WritingRecoveryFault && error.code === "revoked";
    if (revoked) {
      this.lease = null;
      this.invalidated = true;
    }
    this.publish({
      status: revoked ? "revoked" : "error",
      entries: [],
      preview: null,
      saving: false,
      error: recoveryProblem(error),
      sourceReview: null,
      sourceBusy: false,
      sourceError: "",
    });
  }
  private async verify(
    version: number,
    witness?: string | null,
  ): Promise<void> {
    let actor: string;
    try {
      actor = await this.options.actor(this.abort.signal);
    } catch (error) {
      if (
        this.current(version) &&
        error instanceof NotificationRequestError &&
        error.code === "unauthenticated"
      ) {
        if (witness !== undefined)
          await this.options.store.revoke(witness).catch(() => {});
        if (this.current(version)) {
          this.invalidate();
          this.options.identityLost?.();
        }
      }
      throw new WritingRecoveryFault("identity");
    }
    if (!this.current(version)) throw new WritingRecoveryFault("stale");
    if (!isNotificationActor(actor) || actor !== this.expectedActor) {
      // A late A response must not clear a newly enabled B namespace. attach
      // compares the witness taken BEFORE the authoritative account request.
      if (isNotificationActor(actor) && witness !== undefined)
        await this.options.store.attach(actor, witness).catch(() => {});
      if (this.current(version)) {
        this.invalidate();
        this.options.identityLost?.();
      }
      throw new WritingRecoveryFault("identity");
    }
  }
  private async enter(enable: boolean, passive = false): Promise<void> {
    if (this.destroyed || this.invalidated || !this.expectedActor) return;
    const version = this.nextGeneration(),
      actor = this.expectedActor;
    this.publish({
      status: "checking",
      sourceReview: null,
      sourceBusy: false,
      sourceError: "",
      actor: null,
      entries: [],
      preview: null,
      saving: false,
      error: "",
    });
    try {
      const witness = await this.options.store.inspect();
      if (!this.current(version)) return;
      // A page lifecycle wake-up with unchanged OFF metadata grants no lease,
      // identity or manuscript access. Avoid competing with other session owners
      // for a network read when nothing private can be displayed. Explicit list
      // refresh/enable and any changed control still require a fresh actor proof.
      if (
        passive &&
        !enable &&
        !this.consented &&
        this.offControl !== undefined &&
        this.offControl === witness
      ) {
        this.publish({ status: "off", actor: null });
        return;
      }
      await this.verify(version, witness);
      if (!this.current(version)) return;
      const view = await this.options.store[enable ? "enable" : "attach"](
        actor,
        witness,
      );
      if (!this.current(version)) return;
      if (
        !enable &&
        this.lastEpoch !== null &&
        view.lease?.epoch !== this.lastEpoch
      )
        throw new WritingRecoveryFault("revoked");
      if (enable && view.lease?.epoch !== this.lastEpoch) {
        this.candidateId = null;
        this.writerId = null;
        this.own = null;
        this.lastKey = "";
      }
      this.lease = view.lease;
      this.offControl = view.lease ? undefined : view.control;
      if (view.lease) {
        this.lastEpoch = view.lease.epoch;
        this.consented = true;
      }
      this.own =
        view.entries.find(
          (row) => row.id === this.candidateId && row.writer === this.writerId,
        ) ?? null;
      this.problem = null;
      this.publish({
        actor,
        status: view.lease ? "ready" : "off",
        entries: view.entries,
        savedAt: this.own?.updatedAt ?? null,
      });
      this.lastKey = "";
      if (view.lease) this.noteChange();
    } catch (error) {
      this.fail(error, version);
    }
  }
  async connect(
    expectedActor: string,
    mode: "explicit" | "lifecycle" = "explicit",
  ): Promise<void> {
    if (!isNotificationActor(expectedActor)) {
      this.suspend();
      return;
    }
    if (this.expectedActor !== null && this.expectedActor !== expectedActor) {
      this.invalidate();
      this.options.identityLost?.();
      return;
    }
    this.expectedActor = expectedActor;
    await this.trackEntry(false, mode === "lifecycle");
  }
  private async trackEntry(enable: boolean, passive = false): Promise<void> {
    const operation = this.enter(enable, passive);
    this.entering = operation;
    try {
      await operation;
    } finally {
      if (this.entering === operation) this.entering = null;
    }
  }
  enable(): Promise<void> {
    return this.trackEntry(true);
  }
  noteChange(): void {
    this.noteVersion++;
    this.clearTimer();
    if (!this.lease || this.destroyed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }
  private identifiers() {
    this.candidateId ??= (this.options.id ?? (() => crypto.randomUUID()))();
    this.writerId ??= (this.options.id ?? (() => crypto.randomUUID()))();
    if (!recoveryId(this.candidateId) || !recoveryId(this.writerId))
      throw new WritingRecoveryFault("unavailable");
    return { id: this.candidateId, writer: this.writerId };
  }
  private async writeOne(version: number, lease: RecoveryLease): Promise<void> {
    // Freeze the exact editor intent before any async boundary. No function
    // below may read later React state and claim it was part of this commit.
    const snapshot = structuredClone(this.options.snapshot());
    const base = parseRecoveryBase(snapshot.base);
    const unknown =
      this.uncertain ||
      this.state.requiresReview ||
      this.own?.outcomeUnknown === true;
    const key = JSON.stringify([
      writingSnapshotKey(snapshot.draft),
      base,
      unknown,
    ]);
    if (snapshot.dirty && key === this.lastKey && this.own) return;
    if (!snapshot.dirty && !unknown && !this.own) return;
    const witness = await this.options.store.inspect();
    if (!this.current(version)) return;
    await this.verify(version, witness);
    if (!this.current(version) || this.lease !== lease) return;
    if (!snapshot.dirty && !unknown) {
      if (this.own) {
        const removed = this.own;
        await this.options.store.remove(lease, removed.id, removed.revision);
        if (!this.current(version)) return;
        this.own = null;
        this.lastKey = "";
        this.publish({
          entries: this.state.entries.filter((row) => row.id !== removed.id),
          savedAt: null,
          error: "",
        });
      }
      return;
    }
    const at = (this.options.now ?? Date.now)();
    let backup: string;
    try {
      backup = createWritingBackup(snapshot.draft, new Date(at));
    } catch {
      throw new WritingRecoveryFault("invalid");
    }
    const row = await this.options.store.put(
      lease,
      {
        ...this.identifiers(),
        expectedRevision: this.own?.revision ?? null,
        base,
        backup,
        outcomeUnknown: unknown,
      },
      at,
    );
    if (!this.current(version)) return;
    this.own = row;
    this.lastKey = key;
    const entries = await this.options.store.read(lease);
    if (!this.current(version)) return;
    if (
      !entries.some(
        (entry) => entry.id === row.id && entry.revision === row.revision,
      )
    )
      throw new WritingRecoveryFault("conflict");
    this.problem = null;
    this.publish({
      status: "ready",
      entries,
      savedAt: row.updatedAt,
      error: "",
    });
  }
  flush(): Promise<boolean> {
    this.clearTimer();
    if (this.writing) return this.writing;
    const lease = this.lease,
      version = this.generation;
    if (!lease || !this.current(version)) return Promise.resolve(false);
    this.publish({ saving: true });
    const operation = (async () => {
      try {
        // Bound a single drain even if an IME/update producer never settles.
        // A later edit schedules another finite drain, not a busy retry loop.
        for (let pass = 0; pass < 8; pass++) {
          const observed = this.noteVersion;
          await this.writeOne(version, lease);
          if (!this.current(version) || this.lease !== lease) return false;
          if (observed === this.noteVersion) return true;
        }
        this.problem = new WritingRecoveryFault("stale");
        return false;
      } catch (error) {
        this.fail(error, version);
        return false;
      } finally {
        if (this.current(version)) this.publish({ saving: false });
      }
    })();
    this.writing = operation;
    const release = () => {
      if (this.writing === operation) this.writing = null;
    };
    void operation.then(release, release);
    return operation;
  }
  async beforeServerWrite(): Promise<void> {
    await this.entering;
    if (!this.expectedActor) throw new WritingRecoveryFault("identity");
    if (this.state.requiresReview)
      throw new WritingRecoveryFault("review_required");
    if (this.invalidated) throw new WritingRecoveryFault("revoked");
    if (!this.consented) return;
    if (!this.lease) throw new WritingRecoveryFault("revoked");
    this.uncertain = true;
    this.noteVersion++;
    if (!(await this.flush()))
      throw this.problem instanceof WritingRecoveryFault
        ? this.problem
        : new WritingRecoveryFault("unavailable");
    if (!this.own?.outcomeUnknown) throw new WritingRecoveryFault("stale");
  }
  private async settleOwn(): Promise<void> {
    const version = this.generation;
    await this.writing;
    const lease = this.lease,
      prior = this.own;
    if (!lease || !prior || !this.current(version)) return;
    const witness = await this.options.store.inspect();
    await this.verify(version, witness);
    if (!this.current(version) || this.own !== prior)
      throw new WritingRecoveryFault("stale");
    const row = await this.options.store.settle(
      lease,
      prior.id,
      prior.writer,
      prior.revision,
    );
    if (!this.current(version)) return;
    this.own = row;
    this.lastKey = "";
    this.publish({
      entries: [
        row,
        ...this.state.entries.filter((entry) => entry.id !== row.id),
      ].sort((a, b) => b.revision - a.revision),
    });
  }
  async confirmServerWrite(): Promise<void> {
    const version = this.generation;
    try {
      await this.settleOwn();
      if (!this.current(version)) return;
      this.uncertain = false;
      this.noteVersion++;
      await this.flush();
    } catch (error) {
      this.fail(error, version);
    }
  }
  private snapshotKey(): string {
    const snapshot = this.options.snapshot();
    return JSON.stringify([
      writingSnapshotKey(snapshot.draft),
      parseRecoveryBase(snapshot.base),
    ]);
  }
  async preview(id: string): Promise<void> {
    const lease = this.lease,
      version = this.generation;
    if (!lease || !this.current(version)) return;
    const source = this.snapshotKey();
    try {
      const witness = await this.options.store.inspect();
      await this.verify(version, witness);
      if (!this.current(version)) return;
      const rows = await this.options.store.read(lease);
      if (!this.current(version)) return;
      if (source !== this.snapshotKey())
        throw new WritingRecoveryFault("stale");
      const row = rows.find((entry) => entry.id === id);
      if (!row) throw new WritingRecoveryFault("conflict");
      const snapshot = this.options.snapshot();
      this.publish({
        entries: rows,
        preview: recoveryPreview(row, snapshot.draft, snapshot.base),
        error: "",
      });
    } catch (error) {
      this.fail(error, version);
    }
  }
  async restore(
    fields: readonly WritingField[],
    consent: { differentBase: boolean; remoteImages: boolean },
  ): Promise<WritingDraft | null> {
    const plan = this.state.preview,
      lease = this.lease,
      version = this.generation;
    if (!plan || !lease || !this.current(version)) return null;
    try {
      const witness = await this.options.store.inspect();
      await this.verify(version, witness);
      if (!this.current(version) || this.state.preview !== plan) return null;
      const rows = await this.options.store.read(lease);
      if (!this.current(version) || this.state.preview !== plan) return null;
      const row = rows.find((entry) => entry.id === plan.id);
      if (!row || JSON.stringify(row) !== plan.witness)
        throw new WritingRecoveryFault("conflict");
      const snapshot = this.options.snapshot();
      const next = applyRecoveryPreview(
        plan,
        snapshot.draft,
        snapshot.base,
        fields,
        consent,
      );
      // Apply inside the final checked synchronous section, not in a caller
      // continuation that might race another edit or privacy invalidation.
      this.options.apply?.(next);
      this.uncertain ||= plan.outcomeUnknown;
      this.publish({
        preview: null,
        requiresReview: this.state.requiresReview || plan.outcomeUnknown,
        error: "",
      });
      return next;
    } catch (error) {
      this.fail(error, version);
      return null;
    }
  }
  async acknowledgeReview(): Promise<void> {
    if (!this.state.requiresReview) return;
    const version = this.generation;
    try {
      await this.settleOwn();
      if (!this.current(version)) return;
      this.uncertain = false;
      this.noteVersion++;
      this.publish({ requiresReview: false, error: "" });
      await this.flush();
    } catch (error) {
      this.fail(error, version);
    }
  }
  async reviewSource(id: string): Promise<void> {
    const lease = this.lease,
      generation = this.generation,
      request = ++this.sourceVersion;
    if (!lease || !this.current(generation)) return;
    this.sourceReader.cancel();
    const current = () =>
      this.current(generation) &&
      request === this.sourceVersion &&
      this.lease === lease;
    this.publish({ sourceBusy: true, sourceReview: null, sourceError: "" });
    let witness: string | null | undefined;
    try {
      witness = await this.options.store.inspect();
      await this.verify(generation, witness);
      if (!current()) return;
      const entries = await this.options.store.read(lease);
      if (!current()) return;
      const row = entries.find((entry) => entry.id === id);
      if (!row) throw new WritingRecoveryFault("conflict");
      const result = await this.sourceReader.read(row, lease.actor, current);
      if (!result || !current()) return;
      await this.verify(generation, witness);
      if (!current()) return;
      // The HTTP read may have taken seconds. A deleted or edited source must
      // not inherit an earlier comparison, even when it reused the same ID.
      const confirmed = await this.options.store.read(lease);
      if (!current()) return;
      if (
        !confirmed.some(
          (entry) =>
            entry.id === id && JSON.stringify(entry) === result.witness,
        )
      )
        throw new WritingRecoveryFault("stale");
      this.publish({
        entries: confirmed,
        sourceReview: result,
        sourceError: "",
      });
    } catch (error) {
      if (!current()) return;
      if (
        error instanceof CatalogueReadError &&
        ["account-changed", "unauthenticated"].includes(error.kind)
      ) {
        if (witness !== undefined)
          await this.options.store.revoke(witness).catch(() => {});
        if (!current()) return;
        this.invalidate();
        this.options.identityLost?.();
      } else if (
        error instanceof WritingRecoveryFault &&
        error.code === "revoked"
      ) {
        this.fail(error, generation);
      } else {
        this.publish({
          sourceReview: null,
          sourceError:
            error instanceof CatalogueReadError
              ? error.message
              : recoveryProblem(error),
        });
      }
    } finally {
      if (current()) this.publish({ sourceBusy: false });
    }
  }
  async download(
    id: string,
    revision: number,
    deliver: (entry: RecoveryEntry, permitted: () => boolean) => void,
  ): Promise<void> {
    const lease = this.lease,
      version = this.generation;
    if (!lease || !this.current(version)) return;
    try {
      const witness = await this.options.store.inspect();
      await this.verify(version, witness);
      if (!this.current(version)) return;
      const rows = await this.options.store.read(lease);
      if (!this.current(version)) return;
      const row = rows.find(
        (entry) => entry.id === id && entry.revision === revision,
      );
      if (!row) throw new WritingRecoveryFault("conflict");
      deliver(row, () => this.current(version) && this.lease === lease);
    } catch (error) {
      this.fail(error, version);
    }
  }
  async discard(id: string, revision: number): Promise<void> {
    const lease = this.lease,
      version = this.generation;
    if (!lease || !this.current(version)) return;
    try {
      await this.writing;
      const witness = await this.options.store.inspect();
      await this.verify(version, witness);
      if (!this.current(version)) return;
      await this.options.store.remove(lease, id, revision);
      if (!this.current(version)) return;
      if (this.own?.id === id) {
        this.own = null;
        this.lastKey = "";
      }
      this.publish({
        entries: this.state.entries.filter((row) => row.id !== id),
        preview: null,
        savedAt: this.own?.updatedAt ?? null,
        error: "",
      });
    } catch (error) {
      this.fail(error, version);
    }
  }
  async disable(): Promise<void> {
    // Device-wide, deliberate erasure conveys no read/account authority and
    // must remain available offline or when a corrupt row cannot be parsed.
    this.suspend();
    const version = this.generation;
    this.options.revoked?.();
    try {
      await this.options.store.purge();
      if (!this.current(version)) return;
      this.consented = false;
      this.lastEpoch = null;
      this.own = null;
      this.lastKey = "";
      this.publish({ status: "off", actor: this.expectedActor, error: "" });
    } catch (error) {
      this.fail(error, version);
    }
  }
  suspend(): void {
    this.nextGeneration();
    this.lease = null;
    this.publish({
      ...EMPTY,
      requiresReview: this.state.requiresReview,
      status: this.consented ? "revoked" : "idle",
    });
  }
  invalidate(): void {
    this.invalidated = true;
    this.suspend();
    this.publish({
      status: "revoked",
      error: recoveryProblem(new WritingRecoveryFault("revoked")),
    });
  }
  dispose(): void {
    this.nextGeneration();
    this.lease = null;
    this.destroyed = true;
    this.state = EMPTY;
    this.listeners.clear();
  }
}
