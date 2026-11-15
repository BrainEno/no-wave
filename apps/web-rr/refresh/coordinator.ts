import { RefreshWaiters } from "./request-waiters.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { RefreshCoordinator, RefreshCoordinatorContext, RefreshOutcome } from "@bot-thk/web-http";
import { coordinationFailure, observeRefresh, RefreshCoordinationError, type RefreshObserver } from "./errors.ts";
import { isTransientRefreshOutcome, isUncertainRefreshOutcome, normalizeRefreshOutcome, RefreshResultCodec } from "./result-codec.ts";
import { REFRESH_REUSE_MS, REFRESH_TRANSIENT_MS, type RefreshSettings } from "./settings.ts";
import type { RefreshClaim, RefreshStore, SharedRefreshRow } from "./postgres-store.ts";

export class PostgresRefreshCoordinator implements RefreshCoordinator {
  private readonly store: RefreshStore;
  private readonly codec: RefreshResultCodec;
  private readonly settings: RefreshSettings;
  private readonly observer: RefreshObserver | undefined;
  private readonly waiters: RefreshWaiters;
  private readonly pending = new Map<string, Promise<RefreshOutcome>>();
  private readonly callbacks = new Set<Promise<unknown>>();
  private readonly stopped = new AbortController();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private closing: Promise<boolean> | undefined;

  constructor(options: { store: RefreshStore; codec: RefreshResultCodec; settings: RefreshSettings; observer?: RefreshObserver }) {
    this.store = options.store;
    this.codec = options.codec;
    this.settings = options.settings;
    this.observer = options.observer;
    this.waiters = new RefreshWaiters(options.settings.maxWaiters, options.settings.maxWaitersPerKey);
  }

  async start(): Promise<void> {
    if (this.stopped.signal.aborted) throw new RefreshCoordinationError("closed");
    await this.store.verify();
    if (this.stopped.signal.aborted) throw new RefreshCoordinationError("closed");
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, this.settings.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private async sweep(): Promise<void> {
    if (this.stopped.signal.aborted || this.sweeping) return;
    this.sweeping = true;
    try { await this.store.sweep(); }
    catch { observeRefresh(this.observer, { event: "sweep-failed", reason: "database" }); }
    finally { this.sweeping = false; }
  }

  snapshot(): { pending: number; callbacks: number; waiters: number; waitingKeys: number; closed: boolean } {
    const waiting = this.waiters.snapshot();
    return { pending: this.pending.size, callbacks: this.callbacks.size, waiters: waiting.active, waitingKeys: waiting.keys, closed: this.stopped.signal.aborted };
  }

  async resolve(key: string, rotate: () => Promise<RefreshOutcome>, context: RefreshCoordinatorContext = {}): Promise<RefreshOutcome> {
    observeRefresh(this.observer, { event: "requested" });
    try {
      if (typeof context.endpoint !== "string") throw new RefreshCoordinationError("policy");
      const endpoint = context.endpoint;
      return await this.waiters.join(key, () => this.resolveGeneration(key, rotate, endpoint), { signal: context.signal,
        timeoutMs: Math.min(context.timeoutMs ?? this.settings.waitTimeoutMs, this.settings.waitTimeoutMs) });
    } catch (error) {
      const reason = error instanceof RefreshCoordinationError ? error.code : "database";
      observeRefresh(this.observer, { event: "rejected", reason });
      return coordinationFailure(reason);
    }
  }

  private async resolveGeneration(key: string, rotate: () => Promise<RefreshOutcome>, endpoint: string): Promise<RefreshOutcome> {
    if (this.stopped.signal.aborted) return coordinationFailure("closed");
    if (!/^[a-f0-9]{64}$/.test(key)) return coordinationFailure("invalid-result");
    const inFlight = this.pending.get(key);
    if (inFlight) { observeRefresh(this.observer, { event: "shared" }); return inFlight; }
    if (this.pending.size >= this.settings.maxPending || this.callbacks.size >= this.settings.maxPending) {
      observeRefresh(this.observer, { event: "rejected", reason: "capacity" });
      return coordinationFailure("capacity");
    }
    const work = this.perform(key, rotate, endpoint).catch(error => {
      const reason = error instanceof RefreshCoordinationError ? error.code : "database";
      observeRefresh(this.observer, { event: "rejected", reason });
      return coordinationFailure(reason);
    });
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private assertRunning(): void {
    if (this.stopped.signal.aborted) throw new RefreshCoordinationError("closed");
  }

  private async perform(key: string, rotate: () => Promise<RefreshOutcome>, endpoint: string): Promise<RefreshOutcome> {
    const began = performance.now();
    const watch = this.store.watch?.(key);
    let revision = watch?.revision() ?? 0;
    try {
    const claim = await this.store.claim(key, randomUUID(), endpoint);
    this.assertRunning();
    if (claim.owner) {
      observeRefresh(this.observer, { event: "claimed" });
      return this.rotateOwned(claim, rotate);
    }
    observeRefresh(this.observer, { event: "shared" });
    let row: SharedRefreshRow | null = claim.row;
    let now = claim.now;
    while (row) {
      this.assertRunning();
      if (row.expiresAt <= now) break;
      if (row.sealed !== null && row.resultUntil !== null && row.resultUntil > now) {
        const result = this.codec.open(row.sealed, { namespace: this.settings.namespace, key: row.key, owner: row.owner, expiresAt: new Date(row.resultUntil).toISOString() });
        if (result && !("kind" in result) && Date.parse(result.accessExpiresAt) <= now) break;
        return result;
      }
      if (row.state === "uncertain") break;
      if (row.state === "resolved") break;
      if (row.workDeadline <= now) {
        await this.store.markUncertain(key, row.owner);
        observeRefresh(this.observer, { event: "uncertain", reason: "uncertain" });
        break;
      }
      const remaining = this.settings.waitTimeoutMs - (performance.now() - began);
      if (remaining <= 0) throw new RefreshCoordinationError("deadline");
      try {
        if (watch) await watch.wait(revision, Math.min(250, remaining), this.stopped.signal);
        else await pause(Math.min(25, remaining), undefined, { signal: this.stopped.signal });
      } catch { throw new RefreshCoordinationError("closed"); }
      revision = watch?.revision() ?? 0;
      this.assertRunning();
      const next = await this.store.read(key); row = next.row; now = next.now;
    }
    return coordinationFailure("uncertain");
    } finally { watch?.close(); }
  }

  private async boundedRotation(rotate: () => Promise<RefreshOutcome>, remainingMs: number): Promise<RefreshOutcome> {
    this.assertRunning();
    if (remainingMs <= 0) throw new RefreshCoordinationError("deadline");
    const callback = Promise.resolve().then(() => { this.assertRunning(); return rotate(); });
    this.callbacks.add(callback);
    callback.then(() => this.callbacks.delete(callback), () => this.callbacks.delete(callback));
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new RefreshCoordinationError("closed")); };
      const timer = setTimeout(() => { cleanup(); reject(new RefreshCoordinationError("deadline")); }, Math.min(this.settings.rotationTimeoutMs, remainingMs));
      const cleanup = () => { clearTimeout(timer); this.stopped.signal.removeEventListener("abort", abort); };
      this.stopped.signal.addEventListener("abort", abort, { once: true });
      callback.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  private async rotateOwned(claim: RefreshClaim, rotate: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
    const { key, owner } = claim.row;
    try {
      const before = await this.store.read(key);
      this.assertRunning();
      if (!before.row || before.row.owner !== owner || before.row.state !== "pending" || before.row.workDeadline <= before.now) {
        throw new RefreshCoordinationError("uncertain");
      }
      const outcome = normalizeRefreshOutcome(await this.boundedRotation(rotate, before.row.workDeadline - before.now));
      this.assertRunning();
      const observed = await this.store.read(key);
      this.assertRunning();
      if (!observed.row || observed.row.owner !== owner || observed.row.state !== "pending" || observed.row.workDeadline <= observed.now) {
        throw new RefreshCoordinationError("uncertain");
      }
      const uncertain = isUncertainRefreshOutcome(outcome);
      let ttl = isTransientRefreshOutcome(outcome) || outcome === undefined ? REFRESH_TRANSIENT_MS : REFRESH_REUSE_MS;
      if (outcome && !("kind" in outcome)) {
        ttl = Math.min(ttl, Date.parse(outcome.accessExpiresAt) - observed.now);
        if (ttl <= 0) throw new RefreshCoordinationError("invalid-result");
      }
      const resultUntil = observed.now + ttl;
      const sealed = this.codec.seal(outcome, { namespace: this.settings.namespace, key, owner, expiresAt: new Date(resultUntil).toISOString() });
      if (!await this.store.complete({ key, owner, sealed, resultUntil, uncertain })) throw new RefreshCoordinationError("uncertain");
      this.assertRunning();
      observeRefresh(this.observer, { event: uncertain ? "uncertain" : "completed" });
      return outcome;
    } catch (error) {
      // The claim was committed BEFORE HTTP. Failure never deletes that fence:
      // after a lost response/owner, nobody may guess that the token is unspent.
      if (!this.stopped.signal.aborted) {
        try { await this.store.markUncertain(key, owner); } catch { /* The original committed marker remains authoritative. */ }
      }
      throw error instanceof RefreshCoordinationError ? error : new RefreshCoordinationError("uncertain");
    }
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.stopped.abort();
    this.waiters.close();
    clearInterval(this.sweepTimer);
    const drained = (async () => {
      const databaseDrained = await this.store.close();
      await Promise.allSettled([...this.pending.values()]);
      return databaseDrained && this.callbacks.size === 0;
    })();
    this.closing = new Promise<boolean>(resolve => {
      const deadline = setTimeout(() => { this.codec.dispose(); resolve(false); }, this.settings.driverTimeoutMs + 1000);
      drained.then(clean => { clearTimeout(deadline); this.codec.dispose(); resolve(clean); }, () => {
        clearTimeout(deadline); this.codec.dispose(); resolve(false);
      });
    });
    return this.closing;
  }
}
