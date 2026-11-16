import type { ReadingShelfStore, ShelfWriteResult } from "./reading-shelf-store.ts";

export type ShelfExclusive = (work: () => ShelfWriteResult, signal: AbortSignal) => Promise<ShelfWriteResult>;
export type ShelfActionSnapshot = Readonly<{ writable: boolean; pending: number }>;
const EMPTY: ShelfActionSnapshot = Object.freeze({ writable: false, pending: 0 });

/** Browser writes must coordinate the entire inventory/compare/write, not just setItem. */
export function createShelfActions(store: ReadingShelfStore) {
  let connection: { exclusive: ShelfExclusive; abort: AbortController } | null = null;
  let snapshot = EMPTY;
  const jobs = new Set<object>();
  const listeners = new Set<() => void>();
  function publish() {
    const writable = connection !== null;
    if (snapshot.writable === writable && snapshot.pending === jobs.size) return;
    snapshot = Object.freeze({ writable, pending: jobs.size });
    for (const listener of listeners) listener();
  }
  function disconnect() {
    connection?.abort.abort();
    connection = null;
    jobs.clear();
    publish();
  }
  async function schedule(work: () => ShelfWriteResult): Promise<ShelfWriteResult> {
    const owner = connection;
    if (!owner) return { ok: false, code: "unsupported", applied: 0 };
    const ticket = {};
    jobs.add(ticket);
    publish();
    try {
      return await owner.exclusive(() => {
        if (connection !== owner || owner.abort.signal.aborted) return { ok: false, code: "unavailable", applied: 0 };
        return work();
      }, owner.abort.signal);
    } catch {
      return { ok: false, code: "unavailable", applied: 0 };
    } finally {
      jobs.delete(ticket);
      publish();
    }
  }
  const action = <Args extends unknown[]>(work: (...args: Args) => ShelfWriteResult) =>
    (...args: Args) => schedule(() => work(...args));
  return {
    getSnapshot: (): ShelfActionSnapshot => snapshot,
    getServerSnapshot: (): ShelfActionSnapshot => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect(exclusive: ShelfExclusive | null) {
      disconnect();
      if (exclusive) connection = { exclusive, abort: new AbortController() };
      publish();
    },
    disconnect,
    save: action(store.save), update: action(store.update), checkpoint: action(store.checkpoint),
    remove: action(store.remove), clear: action(store.clear), batch: action(store.batch), importRecords: action(store.importRecords),
  };
}
export type ShelfActions = ReturnType<typeof createShelfActions>;
