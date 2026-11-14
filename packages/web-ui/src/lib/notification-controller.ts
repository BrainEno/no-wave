import { parseNotificationNotice, type NotificationItem } from "./chrome.ts";
import { createNotificationTransport, NotificationRequestError, type NotificationProblem, type NotificationTransport } from "./notification-transport.ts";

export type NotificationEntry = Readonly<{ item: Readonly<NotificationItem>; read: boolean }>;
export type NotificationSnapshot = Readonly<{
  session: "unknown" | "active" | "signed-out";
  status: "idle" | "loading" | "ready" | "error";
  loaded: boolean;
  items: readonly NotificationEntry[];
  unread: number | null;
  nextCursor: string | null;
  pending: "summary" | "refresh" | "more" | "mark" | null;
  error: NotificationProblem | null;
}>;
const EMPTY: NotificationSnapshot = Object.freeze({ session: "unknown", status: "idle", loaded: false,
  items: Object.freeze([]), unread: null, nextCursor: null, pending: null, error: null });
type Mode = NonNullable<NotificationSnapshot["pending"]>;
type Job = { mode: Mode; abort: AbortController; promise: Promise<void> };
const entry = (item: NotificationItem, read = item.readAt !== null): NotificationEntry => Object.freeze({ item: Object.freeze({ ...item }), read });

/** A store belongs to one mounted shell, never to a module-global user cache. */
export function createNotificationController(transport: NotificationTransport = createNotificationTransport()) {
  let state = EMPTY;
  let job: Job | null = null;
  let feedReaders = 0;
  let sessionChanges = 0;
  let consumedCursors = new Set<string>();
  const listeners = new Set<() => void>();
  function publish(change: Partial<NotificationSnapshot>) {
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  }
  function clear(active: boolean) {
    const previous = job;
    job = null;
    previous?.abort.abort();
    consumedCursors = new Set();
    publish({ ...EMPTY, session: active ? "active" : "signed-out" });
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
      next.abort.abort();
      const code = error instanceof NotificationRequestError ? error.code : "unavailable";
      publish({ error: code === "cancelled" ? "unavailable" : code, status: state.loaded ? "ready" : "error" });
    }).finally(() => {
      if (!current()) return;
      job = null;
      publish({ pending: null });
    });
    publish({ pending: mode, error: null, ...(!state.loaded && mode === "refresh" ? { status: "loading" as const } : {}) });
    return next.promise;
  }
  function refreshSummary(): Promise<void> {
    if (job && job.mode !== "summary") return job.promise;
    return run("summary", async (signal, current) => {
      const unread = await transport.count(signal);
      if (current()) publish({ unread, status: state.loaded ? "ready" : "idle" });
    });
  }
  function refresh(): Promise<void> {
    return run("refresh", async (signal, current) => {
      const [page, unread] = await Promise.all([transport.page(null, signal), transport.count(signal)]);
      if (!current()) return;
      consumedCursors = new Set();
      publish({ items: Object.freeze(page.items.map((item) => entry(item))), unread, nextCursor: page.nextCursor, loaded: true, status: "ready" });
    });
  }
  function loadMore(): Promise<void> {
    if (job) return job.promise;
    const cursor = state.nextCursor;
    if (!state.loaded || !cursor) return Promise.resolve();
    return run("more", async (signal, current) => {
      const page = await transport.page(cursor, signal);
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
    if (id !== undefined && state.items.some((row) => row.item.id === id && row.read)) return Promise.resolve();
    return run("mark", async (signal, current) => {
      const acknowledged = await transport.mark(id, signal);
      if (!current()) return;
      // Only an accepted server mutation confirms read state. A mark-all count
      // is NOT an unread total or a timestamp, so never invent readAt or zero.
      publish({ items: Object.freeze(state.items.map((row) => {
        if (id === undefined) return row.read ? row : entry(row.item, true);
        return row.item.id === id && typeof acknowledged !== "number" ? entry(acknowledged, true) : row;
      })) });
      const unread = await transport.count(signal);
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
    /** Hints only: every private request must still authenticate at the API. */
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
