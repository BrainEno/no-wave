import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createReadingShelfStore, SHELF_STORAGE_PREFIX, type ReadingShelfStore } from "@/lib/reading-shelf-store.ts";
import { createShelfActions, type ShelfActions } from "@/lib/reading-shelf-actions.ts";

type ShelfContextValue = { store: ReadingShelfStore; actions: ShelfActions };
const ShelfContext = createContext<ShelfContextValue | null>(null);

export function ReadingShelfProvider({ children }: { children: ReactNode }) {
  const [value] = useState(() => {
    const store = createReadingShelfStore();
    return { store, actions: createShelfActions(store) };
  });
  const { store, actions } = value;
  useEffect(() => {
    const connect = () => {
      try {
        store.connect(window.localStorage);
        const locks = navigator.locks;
        actions.connect(locks ? (work, signal) => locks.request("nw-reading-list-v1", { mode: "exclusive", signal }, work) : null);
      } catch { store.connect(null); actions.connect(null); }
    };
    const external = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(SHELF_STORAGE_PREFIX)) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      store.refresh();
    };
    const visible = () => { if (!document.hidden) store.refresh(); };
    const hide = () => actions.disconnect();
    connect();
    window.addEventListener("storage", external);
    window.addEventListener("focus", visible);
    window.addEventListener("pageshow", connect);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", external);
      window.removeEventListener("focus", visible);
      window.removeEventListener("pageshow", connect);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visible);
      actions.disconnect();
      store.disconnect();
    };
  }, [actions, store]);
  return <ShelfContext.Provider value={value}>{children}</ShelfContext.Provider>;
}

export function useReadingShelf() {
  const context = useContext(ShelfContext);
  if (!context) throw new Error("Reading list requires its shell-scoped provider");
  const { store, actions } = context;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const writes = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getServerSnapshot);
  const retry = () => {
    try {
      store.connect(window.localStorage);
      const locks = navigator.locks;
      actions.connect(locks ? (work, signal) => locks.request("nw-reading-list-v1", { mode: "exclusive", signal }, work) : null);
    } catch { store.connect(null); actions.connect(null); }
  };
  return { store, actions, snapshot, retry, canWrite: snapshot.status === "ready" && writes.writable, busy: writes.pending > 0 };
}
