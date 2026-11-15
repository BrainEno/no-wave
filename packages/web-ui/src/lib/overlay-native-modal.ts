import { htmlElement, nativeModalAbove } from "./overlay-focus.ts";

/**
 * Native leave/confirmation dialogs own the top layer. Inerting their ancestor
 * is harmless to showModal, but inerting the dialog node itself is not. Pause
 * our own isolation before opening and resume only after the native stack ends.
 */
export function observeNativeModal(panel: HTMLElement, change: (blocked: boolean, previous: boolean | null) => void): () => void {
  const document = panel.ownerDocument;
  let closed = false;
  let blocked: boolean | null = null;
  let scheduled = false;
  const abort = new AbortController();

  const publish = (next: boolean) => {
    if (closed || next === blocked) return;
    const previous = blocked;
    blocked = next;
    change(next, previous);
  };
  const sync = () => {
    scheduled = false;
    if (!closed) publish(nativeModalAbove(panel));
  };
  const schedule = () => {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  };
  const isDialog = (event: Event): boolean => htmlElement(event.target, document) && event.target.tagName === "DIALOG";
  const beforeToggle = (event: Event) => {
    if (!isDialog(event)) return;
    // beforetoggle may be cancelled, or show() may be non-modal. Recheck the
    // real :modal state after the native operation, never infer a lasting trap.
    if ("newState" in event && event.newState === "open") publish(true);
    schedule();
  };
  const nativeEvent = (event: Event) => {
    if (isDialog(event)) schedule();
  };
  const options = { capture: true, signal: abort.signal };
  document.addEventListener("beforetoggle", beforeToggle, options);
  document.addEventListener("toggle", nativeEvent, options);
  document.addEventListener("close", nativeEvent, options);
  document.addEventListener("cancel", nativeEvent, options);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  sync();
  return () => {
    if (closed) return;
    closed = true;
    abort.abort();
    observer.disconnect();
  };
}
