import type { MessagingPrivacy } from "./messaging-privacy.ts";

export type MessagingPrivacyEnvironment = {
  window: EventTarget;
  document: EventTarget;
  visible(): boolean;
  /** UI adapters can flush the concealment before a browser takes a page snapshot. */
  flush?(work: () => void): void;
};

/** Events invalidate private display, not just an expiry marker; they never replay writes. */
export function bindMessagingPrivacyRecovery(privacy: Pick<MessagingPrivacy, "check" | "conceal" | "cancel">, environment: MessagingPrivacyEnvironment): () => void {
  let stopped = false;
  let queued = false;
  let frozen = false;
  const visible = () => { try { return environment.visible(); } catch { return false; } };
  const conceal = () => {
    if (environment.flush) environment.flush(privacy.conceal);
    else privacy.conceal();
  };
  const recover = () => {
    conceal();
    if (queued || frozen || !visible()) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!stopped && !frozen && visible()) void privacy.check();
    });
  };
  const focus = () => { frozen = false; recover(); };
  const hide = () => { frozen = true; conceal(); };
  const visibility = () => { if (visible()) frozen = false; recover(); };
  const show = (event: Event) => {
    // A normal initial pageshow is not a restoration and must not turn an
    // initial failed /session into a hidden automatic retry behind the UI.
    if (frozen || (event as PageTransitionEvent).persisted) focus();
  };
  const bindings: [EventTarget, string, EventListener][] = [
    [environment.window, "focus", focus], [environment.window, "online", recover],
    [environment.window, "pagehide", hide], [environment.window, "pageshow", show],
    [environment.document, "visibilitychange", visibility],
  ];
  for (const [target, type, listener] of bindings) target.addEventListener(type, listener);
  if (visible()) void privacy.check(); else privacy.conceal();
  return () => {
    stopped = true;
    for (const [target, type, listener] of bindings) target.removeEventListener(type, listener);
    privacy.cancel();
  };
}
