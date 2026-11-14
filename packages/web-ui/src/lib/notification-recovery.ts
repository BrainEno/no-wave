import type { NotificationController } from "./notification-controller.ts";

export type NotificationRecoveryEnvironment = {
  window: EventTarget;
  document: EventTarget;
  visible(): boolean;
  hasSessionHint(): boolean;
};

/** Event-driven reconciliation only: no polling, persisted inbox or cross-tab payloads. */
export function bindNotificationRecovery(controller: Pick<NotificationController, "connect">, environment: NotificationRecoveryEnvironment): () => void {
  let stopped = false;
  let scheduled = false;
  let pageHidden = false;
  const clear = () => { void controller.connect(false); };
  const recover = () => {
    // An expiry marker cannot identify an account. Drop old private data before
    // re-reading even if a replacement account has exactly the same marker.
    clear();
    if (scheduled || pageHidden || !environment.visible()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped || pageHidden || !environment.visible()) return;
      let active = false;
      try { active = environment.hasSessionHint(); } catch { /* Blocked cookies are not a session. */ }
      void controller.connect(active);
    });
  };
  const resume = () => { pageHidden = false; recover(); };
  const hide = () => { pageHidden = true; clear(); };
  environment.window.addEventListener("focus", resume);
  environment.window.addEventListener("pageshow", resume);
  environment.window.addEventListener("online", recover);
  environment.window.addEventListener("pagehide", hide);
  environment.document.addEventListener("visibilitychange", recover);
  recover();
  return () => {
    stopped = true;
    environment.window.removeEventListener("focus", resume);
    environment.window.removeEventListener("pageshow", resume);
    environment.window.removeEventListener("online", recover);
    environment.window.removeEventListener("pagehide", hide);
    environment.document.removeEventListener("visibilitychange", recover);
    clear();
  };
}
