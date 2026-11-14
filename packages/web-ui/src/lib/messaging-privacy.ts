import { MESSAGING_EXPECTED_ACTOR_HEADER } from "@bot-thk/web-http";
import { createMessagingTransport, isMessagingActor, MessagingRequestError, type MessagingProblem } from "./messaging-transport.ts";
import type { MessagingController } from "./messaging-intent.ts";

export type MessagingPrivacySnapshot = Readonly<{
  id: string;
  status: "loading" | "ready" | "failed" | "hidden" | "changed" | "signed-out";
  readable: boolean;
  epoch: number;
}>;
export type MessagingReadLease = Readonly<{
  actorId: string;
  epoch: number;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  current(): boolean;
  finish(): void;
  fail(problem: MessagingProblem): void;
}>;
const EMPTY: MessagingPrivacySnapshot = Object.freeze({ id: "", status: "loading", readable: false, epoch: 0 });
type IdentityJob = { abort: AbortController; promise: Promise<void> };

/** One private screen, one pinned identity and one generation of readable data. */
export function createMessagingPrivacy(identify: (signal: AbortSignal) => Promise<string> = createMessagingTransport().actor) {
  let snapshot = EMPTY;
  let epoch = 0;
  let pinned = "";
  let verificationRequired = false;
  let job: IdentityJob | null = null;
  const reads = new Set<AbortController>();
  const listeners = new Set<() => void>();
  function publish(status: MessagingPrivacySnapshot["status"], readable = false) {
    snapshot = Object.freeze({ status, readable, epoch, id: status === "ready" ? pinned : "" });
    for (const listener of listeners) listener();
  }
  function invalidate() {
    epoch++;
    const old = job;
    job = null;
    old?.abort.abort();
    for (const read of reads) read.abort();
    reads.clear();
  }
  function conceal() {
    verificationRequired = true;
    invalidate();
    publish("hidden");
  }
  function check(): Promise<void> {
    if (job) return job.promise;
    invalidate();
    const next: IdentityJob = { abort: new AbortController(), promise: Promise.resolve() };
    job = next;
    const current = () => job === next;
    let onAbort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      next.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    next.promise = Promise.resolve().then(async () => {
      if (!current()) return;
      const id = await Promise.race([identify(next.abort.signal), cancelled]);
      if (!current() || id === null) return;
      if (!isMessagingActor(id)) throw new MessagingRequestError("invalid-response");
      verificationRequired = true;
      if (pinned && pinned !== id) { publish("changed"); return; }
      pinned = id;
      publish("ready", true);
    }).catch((error: unknown) => {
      if (!current()) return;
      if (error instanceof MessagingRequestError && (error.code === "unauthenticated" || error.code === "account-changed")) {
        verificationRequired = true;
        publish(error.code === "unauthenticated" ? "signed-out" : "changed");
      } else {
        // Preserve the original first-load read-only experience, but never
        // fall back after an account was pinned or a privacy boundary crossed.
        publish("failed", !verificationRequired);
      }
    }).finally(() => {
      next.abort.signal.removeEventListener("abort", onAbort);
      if (current()) job = null;
    });
    publish("loading");
    return next.promise;
  }
  function beginRead(): MessagingReadLease | null {
    if (!snapshot.readable) return null;
    const abort = new AbortController();
    const ownEpoch = epoch;
    const actorId = snapshot.id;
    let finished = false;
    reads.add(abort);
    const current = () => !finished && ownEpoch === epoch && snapshot.readable && !abort.signal.aborted;
    const headers: Record<string, string> = { accept: "application/json" };
    if (actorId) headers[MESSAGING_EXPECTED_ACTOR_HEADER] = encodeURIComponent(actorId);
    return Object.freeze({
      actorId, epoch: ownEpoch, headers: Object.freeze(headers), signal: abort.signal, current,
      finish() { finished = true; reads.delete(abort); },
      fail(problem: MessagingProblem) {
        if (!current() || problem !== "unauthenticated" && problem !== "account-changed") return;
        verificationRequired = true;
        invalidate();
        publish(problem === "unauthenticated" ? "signed-out" : "changed");
      },
    });
  }
  return Object.freeze({
    getSnapshot: (): MessagingPrivacySnapshot => snapshot,
    getServerSnapshot: (): MessagingPrivacySnapshot => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    currentId: () => snapshot.status === "ready" ? snapshot.id : "",
    accepts: (candidate: number) => candidate === epoch && snapshot.readable,
    check, conceal, beginRead,
    // Effect cleanup aborts and fences work but is not an account-change hint.
    // A Strict Mode reattachment can still perform its initial read-only check.
    cancel() { invalidate(); publish("hidden"); },
  });
}
export type MessagingPrivacy = ReturnType<typeof createMessagingPrivacy>;

/** Cancellation does not discard an unconfirmed actor/payload/key or replay it. */
export function bindMessagingPrivacyWrite(privacy: MessagingPrivacy, writer: Pick<MessagingController, "cancel">): () => void {
  const changed = () => { if (!privacy.currentId()) writer.cancel(); };
  const detach = privacy.subscribe(changed);
  changed();
  return detach;
}
