import { eventWithin, focusElement, focusLandmark, htmlElement, nativeModalAbove, outsideTabNeighbor, tabBoundary, tabStops, visibleElement } from "./overlay-focus.ts";
import { isolateOverlay, lockOverlayScroll } from "./overlay-isolation.ts";
import { observeNativeModal } from "./overlay-native-modal.ts";
import { createOverlayFocusMemory } from "./overlay-focus-memory.ts";

export type OverlayCloseReason = "escape" | "close" | "outside" | "tab-leave" | "focus-leave" | "navigate" | "route" | "replace" | "responsive" | "hidden" | "unmount";
export type OverlayHandle = { dismiss(reason: OverlayCloseReason): void; dispose(): void };
type OverlayOptions = { panel: HTMLElement; trigger: HTMLElement; modal: boolean; onDismiss(reason: OverlayCloseReason): void;
  onNavigate?(href: string, origin: HTMLElement): void; fallback?(): HTMLElement | null };
const currentOverlays = new WeakMap<Document, OverlayHandle>();

/** One live chrome overlay owns listeners; replacement never returns old focus. */
export function activateOverlay(options: OverlayOptions): OverlayHandle {
  const { panel, trigger, modal } = options;
  const document = panel.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error("An overlay requires a live document.");
  currentOverlays.get(document)?.dispose();
  const previousFocus = htmlElement(document.activeElement, document) ? document.activeElement : null;
  let disposed = false;
  let redirecting = false;
  let repairFrame = 0;
  const memory = createOverlayFocusMemory(panel);
  let releaseIsolation: (() => void) | undefined;
  let releaseScroll: (() => void) | undefined;
  let releaseNative: (() => void) | undefined;
  const abort = new AbortController();

  function focusInside(): void {
    if (disposed || nativeModalAbove(panel)) return;
    const stops = tabStops(panel);
    const preferred = panel.querySelector<HTMLElement>("[data-overlay-initial-focus]");
    const target = memory.candidate();
    redirecting = true;
    if (!focusElement(target, modal) && !(target && focusLandmark(target)) && !focusElement(preferred, modal) && !focusElement(stops[0], modal)) focusLandmark(panel);
    redirecting = false;
  }

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    abort.abort();
    observer.disconnect();
    hostObserver.disconnect();
    view!.cancelAnimationFrame(repairFrame);
    releaseNative?.();
    releaseIsolation?.();
    releaseScroll?.();
    memory.clear();
    if (currentOverlays.get(document) === handle) currentOverlays.delete(document);
  }

  function restore(): void {
    if (document.visibilityState === "hidden" || currentOverlays.has(document) || nativeModalAbove(panel)) return;
    if (focusElement(trigger)) return;
    if (previousFocus && !panel.contains(previousFocus) && focusElement(previousFocus)) return;
    const fallback = options.fallback?.();
    if (fallback) focusLandmark(fallback);
  }

  function dismiss(reason: OverlayCloseReason): void {
    if (disposed) return;
    cleanup();
    options.onDismiss(reason);
    if (["escape", "close", "responsive", "hidden"].includes(reason)) restore();
    if (reason === "outside") {
      const address = view!.location.href;
      // A pointerdown microtask runs before the browser's default focus action.
      // Wait one frame so a real outside control wins, and do not interrupt a
      // text selection, replacement panel, detached shell or committed route.
      view!.requestAnimationFrame(() => {
        if (!panel.isConnected || !trigger.isConnected || view!.location.href !== address || document.getSelection()?.isCollapsed === false) return;
        const active = document.activeElement;
        if (active === document.body || active === null || panel.contains(active)) restore();
      });
    }
  }

  const handle: OverlayHandle = { dismiss, dispose: cleanup };
  currentOverlays.set(document, handle);
  const listener = { capture: true, signal: abort.signal };

  document.addEventListener("keydown", event => {
    if (disposed || event.defaultPrevented || event.isComposing || nativeModalAbove(panel)) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); dismiss("escape");
      return;
    }
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!modal && !panel.contains(document.activeElement)) {
      dismiss("tab-leave");
      return; // The trigger's own Tab order belongs to the document, not us.
    }
    const boundary = tabBoundary(panel, document.activeElement, event.shiftKey);
    if (!boundary) return;
    event.preventDefault();
    if (modal) focusElement(boundary, true);
    else {
      const neighbor = outsideTabNeighbor(panel, event.shiftKey);
      dismiss("tab-leave");
      if (!focusElement(neighbor)) restore();
    }
  }, listener);

  document.addEventListener("pointerdown", event => {
    if (disposed || modal || event.button !== 0 || nativeModalAbove(panel) || eventWithin(event, panel) || eventWithin(event, trigger)) return;
    dismiss("outside");
  }, listener);

  document.addEventListener("focusin", event => {
    if (disposed || redirecting || nativeModalAbove(panel)) return;
    if (eventWithin(event, panel)) {
      if (htmlElement(event.target, document)) memory.remember(event.target);
      return;
    }
    if (!modal && eventWithin(event, trigger)) return;
    if (!modal) { dismiss("focus-leave"); return; }
    focusInside();
  }, listener);

  document.addEventListener("click", event => {
    if (disposed || !eventWithin(event, panel) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.composedPath().find(node => htmlElement(node, document) && node.tagName === "A") as HTMLAnchorElement | undefined;
    if (!anchor || anchor.hasAttribute("download") || anchor.target && anchor.target !== "_self") return;
    let address: URL;
    try { address = new URL(anchor.href, view!.location.href); } catch { return; }
    if (address.origin !== view!.location.origin) return;
    const samePageHash = address.pathname === view!.location.pathname && address.search === view!.location.search && address.hash !== "";
    if (event.defaultPrevented && !samePageHash) return;
    options.onNavigate?.(address.pathname + address.search + address.hash, anchor);
  }, listener);

  const scheduleRepair = () => {
    if (disposed || repairFrame) return;
    repairFrame = view!.requestAnimationFrame(() => {
      repairFrame = 0;
      if (disposed || nativeModalAbove(panel)) return;
      if (!visibleElement(panel)) { dismiss("hidden"); return; }
      const active = document.activeElement;
      if (htmlElement(active, document) && panel.contains(active) && visibleElement(active)) return;
      if (modal || memory.lost() && (active === document.body || active === null || memory.owns(active))) focusInside();
    });
  };
  const observer = new MutationObserver(scheduleRepair);
  observer.observe(panel, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "tabindex", "class", "style", "aria-hidden"] });

  // Ancestor removal/visibility is not a mutation inside the panel itself.
  // Ignore ordinary page animations; only mutations on the host chain matter.
  const hostObserver = new MutationObserver(records => {
    if (!panel.isConnected || !trigger.isConnected) { dismiss("hidden"); return; }
    if (records.some(record => record.type === "attributes" && record.target instanceof Element && record.target.contains(panel))) scheduleRepair();
  });
  hostObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["hidden", "inert", "class", "style", "aria-hidden"] });
  document.addEventListener("visibilitychange", () => {
    if (modal && document.visibilityState === "hidden") dismiss("unmount");
  }, { signal: abort.signal });
  view.addEventListener("pagehide", () => { if (modal) dismiss("unmount"); }, { signal: abort.signal });

  // Initial focus precedes inertness, so the browser never has to hide the
  // currently focused trigger from accessibility while focus still rests on it.
  const initial = panel.querySelector<HTMLElement>("[data-overlay-initial-focus]");
  if (!nativeModalAbove(panel) && !focusElement(initial, modal)) focusInside();
  if (modal) {
    releaseScroll = lockOverlayScroll(document);
    releaseNative = observeNativeModal(panel, (blocked, previous) => {
      releaseIsolation?.();
      releaseIsolation = undefined;
      if (disposed || blocked || !visibleElement(panel)) return;
      releaseIsolation = isolateOverlay(panel);
      if (previous !== true) return;
      const active = document.activeElement;
      // A native close normally restores its opener. Repair only a lost focus,
      // not a new focus deliberately chosen by a route or another dialog.
      if (active === document.body || !htmlElement(active, document) || !visibleElement(active)) focusInside();
    });
  }
  return handle;
}
