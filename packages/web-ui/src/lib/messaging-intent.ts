import { CONVERSATION_ID_PATTERN, MESSAGE_BODY_MAX_CHARS, isUsableIdempotencyKey } from "@bot-thk/web-http";
import { mintKey } from "./idempotency-key.ts";
import { createMessagingTransport, isMessagingActor, MessagingRequestError, type MessagingIntent, type MessagingProblem, type MessagingReceipt, type MessagingTarget, type MessagingTransport } from "./messaging-transport.ts";

export type MessagingWriteSnapshot = Readonly<{ busy: boolean; intent: MessagingIntent | null; problem: MessagingProblem | null }>;
const EMPTY: MessagingWriteSnapshot = Object.freeze({ busy: false, intent: null, problem: null });
type Job = { abort: AbortController; promise: Promise<MessagingReceipt | null> };

/** One mounted composer owns one destination and one in-memory, actor-bound intent. */
export function createMessagingController(target: MessagingTarget, { transport = createMessagingTransport(), mint = mintKey }: { transport?: MessagingTransport; mint?: () => string } = {}) {
  const destination = Object.freeze({ ...target });
  let snapshot = EMPTY;
  let job: Job | null = null;
  const listeners = new Set<() => void>();
  function publish(change: Partial<MessagingWriteSnapshot>) {
    snapshot = Object.freeze({ ...snapshot, ...change });
    for (const listener of listeners) listener();
  }
  function attempt(input: string, actorId: string): Promise<MessagingReceipt | null> {
    if (job) return job.promise;
    const fail = (problem: MessagingProblem) => { publish({ problem }); return Promise.resolve(null); };
    if (!isMessagingActor(actorId)) return fail("unverified");
    if (snapshot.intent && snapshot.intent.actorId !== actorId) return fail("account-changed");
    const value = input.trim();
    if (destination.kind !== "start" && !CONVERSATION_ID_PATTERN.test(destination.conversationId)) return fail("invalid");
    if (destination.kind === "reply" && value.length > MESSAGE_BODY_MAX_CHARS) return fail("too-long");
    if ((destination.kind === "reply" && !value) || (destination.kind === "read" && value !== "") ||
        (destination.kind === "start" && (!isMessagingActor(value) || value === actorId))) return fail("invalid");
    if (snapshot.intent && snapshot.intent.value !== value) return fail("changed");
    let intent = snapshot.intent;
    if (!intent) {
      let key: string | null = null;
      if (destination.kind !== "read") {
        try { key = mint(); } catch { return fail("unavailable"); }
        if (!isUsableIdempotencyKey(key) || /[\u0000-\u001f\u007f]/u.test(key)) return fail("unavailable");
      }
      intent = Object.freeze({ target: destination, actorId, value, key,
        payload: destination.kind === "read" ? undefined : JSON.stringify(destination.kind === "start" ? { participantIds: [value] } : { body: value }) });
    }
    const pending = intent;
    const next: Job = { abort: new AbortController(), promise: Promise.resolve(null) };
    job = next;
    const current = () => job === next;
    let onAbort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      next.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    next.promise = Promise.resolve().then(async () => {
      if (!current()) return null;
      const receipt = await Promise.race([transport.submit(pending, next.abort.signal), cancelled]);
      if (!current() || receipt === null) return null;
      // Only a validated acknowledgment retires the key. Cancellation, 4xx and
      // even a damaged 2xx cannot prove that the original write did not commit.
      publish({ intent: null, problem: null });
      return receipt;
    }).catch((error: unknown) => {
      if (current()) publish({ problem: error instanceof MessagingRequestError ? error.code : "unavailable" });
      return null;
    }).finally(() => {
      next.abort.signal.removeEventListener("abort", onAbort);
      if (current()) { job = null; publish({ busy: false }); }
    });
    // Synchronous publication makes same-tick navigation/unload see the intent.
    publish({ busy: true, intent: pending, problem: null });
    return next.promise;
  }
  return {
    getSnapshot: (): MessagingWriteSnapshot => snapshot,
    getServerSnapshot: (): MessagingWriteSnapshot => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attempt,
    dismissProblem() { if (!job) publish({ problem: null }); },
    discard(): boolean {
      if (job) return false;
      publish(EMPTY);
      return true;
    },
    cancel() {
      const old = job;
      if (!old) return;
      job = null;
      old.abort.abort();
      publish({ busy: false, problem: "cancelled" });
    },
  };
}
export type MessagingController = ReturnType<typeof createMessagingController>;
