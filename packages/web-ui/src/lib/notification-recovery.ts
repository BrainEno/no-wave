import type { NotificationController } from "./notification-controller.ts";

export type NotificationRecoveryEnvironment = {
  window: EventTarget;
  document: EventTarget;
  visible(): boolean;
  hasSessionHint(): boolean;
  /** Event handlers must remove private DOM before a browser snapshot; never flush in effects. */
  flush?(work: () => void): void;
};

/** Event-driven reconciliation only: no polling, persisted inbox or cross-tab payloads. */
export function bindNotificationRecovery(controller: Pick<NotificationController, "connect">, environment: NotificationRecoveryEnvironment): () => void {
  let stopped = false;
  let scheduled = false;
  let pageHidden = false;
  const visible = () => { try { return environment.visible(); } catch { return false; } };
  const clear = (synchronous = true) => {
    const work = () => { void controller.connect(false); };
    if (synchronous && environment.flush) environment.flush(work);
    else work();
  };
  const recover = (synchronous = true) => {
    // An expiry marker cannot identify an account. Drop old private data before
    // re-reading even if a replacement account has exactly the same marker.
    clear(synchronous);
    if (scheduled || pageHidden || !visible()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped || pageHidden || !visible()) return;
      let active = false;
      try { active = environment.hasSessionHint(); } catch { /* Blocked cookies are not a session. */ }
      void controller.connect(active);
    });
  };
  const resume = () => { pageHidden = false; recover(); };
  const show = (event: Event) => {
    // Initial pageshow follows mount, not a privacy-restoration boundary. It
    // must not silently retry a failed initial identity check.
    if (pageHidden || "persisted" in event && event.persisted === true) resume();
  };
  const visibility = () => { pageHidden = !visible(); recover(); };
  const online = () => recover();
  const hide = () => { pageHidden = true; clear(); };
  environment.window.addEventListener("focus", resume);
  environment.window.addEventListener("pageshow", show);
  environment.window.addEventListener("online", online);
  environment.window.addEventListener("pagehide", hide);
  environment.document.addEventListener("visibilitychange", visibility);
  recover(false);
  return () => {
    stopped = true;
    environment.window.removeEventListener("focus", resume);
    environment.window.removeEventListener("pageshow", show);
    environment.window.removeEventListener("online", online);
    environment.window.removeEventListener("pagehide", hide);
    environment.document.removeEventListener("visibilitychange", visibility);
    clear(false);
  };
}
