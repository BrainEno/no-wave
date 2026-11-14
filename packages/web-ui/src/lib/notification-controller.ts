import { parseNotificationNotice, type NotificationItem } from "./chrome.ts";
import { createNotificationTransport, isNotificationActor, NotificationRequestError, type NotificationProblem, type NotificationTransport } from "./notification-transport.ts";

export type NotificationEntry = Readonly<{ item: Readonly<NotificationItem>; read: boolean }>;
export type NotificationSnapshot = Readonly<{
  session: "unknown" | "active" | "signed-out";
  actorId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loaded: boolean;
  items: readonly NotificationEntry[];
  unread: number | null;
  nextCursor: string | null;
  pending: "verify" | "summary" | "refresh" | "more" | "mark" | null;
  error: NotificationProblem | null;
}>;
const EMPTY: NotificationSnapshot = Object.freeze({ session: "unknown", actorId: null, status: "idle", loaded: false,
  items: Object.freeze([]), unread: null, nextCursor: null, pending: null, error: null });
type Mode = NonNullable<NotificationSnapshot["pending"]>;
type Job = { mode: Mode; abort: AbortController; promise: Promise<void> };
const entry = (item: NotificationItem, read = item.readAt !== null): NotificationEntry => Object.freeze({ item: Object.freeze({ ...item }), read });

/** A store belongs to one mounted shell, never to a module-global user cache. */
export function createNotificationController(transport: NotificationTransport = createNotificationTransport()) {
  let state = EMPTY;
  let job: Job | null = null;
  let generation = 0;
  let feedReaders = 0;
  let sessionChanges = 0;
  let consumedCursors = new Set<string>();
  const listeners = new Set<() => void>();
  function publish(change: Partial<NotificationSnapshot>) {
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  }
  function clear(active: boolean, error: NotificationProblem | null = null) {
    generation++;
    const previous = job;
    job = null;
    previous?.abort.abort();
    consumedCursors = new Set();
    publish({ ...EMPTY, session: active ? "active" : "signed-out", error, status: error ? "error" : "idle" });
  }
  function run(mode: Mode, work: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
    if (state.session !== "active") return Promise.resolve();
    if (job?.mode === mode || job?.mode === "mark") return job.promise;
    job?.abort.abort();
    const next: Job = { mode, abort: new AbortController(), promise: Promise.resolve() };
    job = next;
    const current = () => job === next && state.session === "active";
    next.promise = Promise.resolve().then(async () => {
      if (current()) await work(next.abort.signal, current);
    }).catch((error: unknown) => {
      if (!current()) return;
      if (error instanceof NotificationRequestError && error.code === "unauthenticated") { clear(false); return; }
      if (error instanceof NotificationRequestError && error.code === "account-changed") { clear(true, "account-changed"); return; }
      next.abort.abort();
      const code = error instanceof NotificationRequestError ? error.code : "unavailable";
      publish({ error: code === "cancelled" ? "unavailable" : code, status: state.loaded ? "ready" : "error" });
    }).finally(() => {
      if (!current()) return;
      job = null;
      publish({ pending: null });
    });
    publish({ pending: mode, error: null, ...(!state.loaded && (mode === "refresh" || mode === "verify") ? { status: "loading" as const } : {}) });
    return next.promise;
  }
  function verifiedRead(read: () => Promise<void>): Promise<void> {
    if (state.session !== "active") return Promise.resolve();
    const started = generation;
    return run("verify", async (signal, current) => {
      const actorId = await transport.actor(signal);
      if (!current()) return;
      if (!isNotificationActor(actorId)) throw new NotificationRequestError("invalid-response");
      publish({ actorId });
    }).then(() => {
      // A subscriber can begin logout while observing the verified actor.
      // Never let its queued continuation issue a private request afterwards.
      if (generation === started && state.actorId !== null) return read();
    });
  }
  function refreshSummary(): Promise<void> {
    const actorId = state.actorId;
    if (actorId === null) return verifiedRead(refreshSummary);
    if (job && job.mode !== "summary") return job.promise;
    return run("summary", async (signal, current) => {
      const unread = await transport.count(signal, actorId);
      if (current()) publish({ unread, status: state.loaded ? "ready" : "idle" });
    });
  }
  function refresh(): Promise<void> {
    const actorId = state.actorId;
    if (actorId === null) return verifiedRead(refresh);
    return run("refresh", async (signal, current) => {
      const [page, unread] = await Promise.all([transport.page(null, signal, actorId), transport.count(signal, actorId)]);
      if (!current()) return;
      consumedCursors = new Set();
      publish({ items: Object.freeze(page.items.map((item) => entry(item))), unread, nextCursor: page.nextCursor, loaded: true, status: "ready" });
    });
  }
  function loadMore(): Promise<void> {
    if (job) return job.promise;
    const cursor = state.nextCursor, actorId = state.actorId;
    if (!state.loaded || !cursor || actorId === null) return Promise.resolve();
    return run("more", async (signal, current) => {
      const page = await transport.page(cursor, signal, actorId);
      if (!current()) return;
      const seen = new Set(state.items.map(({ item }) => item.id));
      const added = page.items.filter((item) => !seen.has(item.id));
      if (page.nextCursor === cursor || page.nextCursor !== null && consumedCursors.has(page.nextCursor) || page.items.length > 0 && added.length === 0) {
        throw new NotificationRequestError("stalled-page");
      }
      consumedCursors.add(cursor);
      publish({ items: Object.freeze([...state.items, ...added.map((item) => entry(item))]), nextCursor: page.nextCursor });
    });
  }
  function markRead(id?: string): Promise<void> {
    const actorId = state.actorId;
    // An explicit write cannot acquire/confirm a replacement identity. Only a
    // deliberate read or a fresh lifecycle connection may verify an account.
    if (actorId === null || id !== undefined && state.items.some((row) => row.item.id === id && row.read)) return Promise.resolve();
    return run("mark", async (signal, current) => {
      const acknowledged = await transport.mark(id, signal, actorId);
      if (!current()) return;
      // Only an accepted server mutation confirms read state. A mark-all count
      // is NOT an unread total or a timestamp, so never invent readAt or zero.
      publish({ items: Object.freeze(state.items.map((row) => {
        if (id === undefined) return row.read ? row : entry(row.item, true);
        return row.item.id === id && typeof acknowledged !== "number" ? entry(acknowledged, true) : row;
      })) });
      if (!current()) return;
      const unread = await transport.count(signal, actorId);
      if (current()) publish({ unread });
    });
  }
  return {
    getSnapshot: (): NotificationSnapshot => state,
    getServerSnapshot: (): NotificationSnapshot => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Auth requests must not re-read old cookies through a focus/online event. */
    beginSessionChange(): () => void {
      sessionChanges++;
      clear(false);
      let finished = false;
      return () => { if (!finished) { sessionChanges--; finished = true; } };
    },
    /** A new connection can accept a replacement account only after API verification. */
    connect(active: boolean): Promise<void> {
      const usable = active && sessionChanges === 0;
      clear(usable);
      return usable ? feedReaders > 0 ? refresh() : refreshSummary() : Promise.resolve();
    },
    watchFeed() {
      feedReaders++;
      if (state.session === "active" && (feedReaders === 1 || !state.loaded)) void refresh();
      let released = false;
      return () => { if (!released) { feedReaders--; released = true; } };
    },
    refreshSummary, refresh, loadMore, markRead,
  };
}
export type NotificationController = ReturnType<typeof createNotificationController>;

export function notificationEntries(snapshot: NotificationSnapshot) {
  return snapshot.items.map(({ item, read }) => ({ item, read, notice: parseNotificationNotice(item.payload) }));
}
