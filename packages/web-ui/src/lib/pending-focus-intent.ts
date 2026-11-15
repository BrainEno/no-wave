import { eventWithin } from "./overlay-focus.ts";

/**
 * Disabling/removing a pending action often drops focus on body. That is the
 * only case where a completion may repair it. Pointer, keyboard, selection or
 * window changes in the meantime mean the reader now owns a different intent.
 */
export function observePendingFocus(document: Document, initiator: HTMLElement | null): { mayRepair(): boolean; dispose(): void } {
  let interrupted = initiator === null;
  let disposed = false;
  const abort = new AbortController();
  const stopRepair = () => { interrupted = true; };
  const options = { capture: true, signal: abort.signal };
  document.addEventListener("pointerdown", event => {
    if (!initiator || !eventWithin(event, initiator)) stopRepair();
  }, options);
  document.addEventListener("focusin", event => {
    if (!initiator || !eventWithin(event, initiator)) stopRepair();
  }, options);
  document.addEventListener("keydown", event => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) stopRepair();
  }, options);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopRepair();
  }, options);
  // Scrolling and viewport changes are reader intents even when focus remains
  // on body after disabling a button. A completion must not scroll them back.
  document.addEventListener("wheel", stopRepair, { ...options, passive: true });
  document.addEventListener("touchmove", stopRepair, { ...options, passive: true });
  document.defaultView?.addEventListener("resize", stopRepair, { signal: abort.signal });
  document.defaultView?.addEventListener("blur", stopRepair, { signal: abort.signal });
  document.defaultView?.addEventListener("pagehide", stopRepair, { signal: abort.signal });
  return {
    mayRepair: () => !disposed && !interrupted && document.visibilityState !== "hidden" && document.getSelection()?.isCollapsed !== false,
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
    },
  };
}
