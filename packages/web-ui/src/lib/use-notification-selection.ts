import { useCallback, useEffect, useState, type RefObject } from "react";
import type { NotificationController, NotificationSnapshot } from "./notification-controller.ts";
import { notificationSelectionId } from "./notification-selection.ts";
import { focusElement, focusLandmark, htmlElement, nativeModalAbove, visibleElement } from "./overlay-focus.ts";

function selectedRow(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-notification-id]"))
    .find(row => notificationSelectionId(row.dataset.notificationId) === id);
}

/**
 * A selected notice may arrive after hydration. Focus once after a verified
 * first page, but never scan pages, write read state or follow a new identity.
 * An explicit Jump button is available if the reader moved in the meantime.
 */
export function useNotificationSelection(controller: NotificationController, snapshot: NotificationSnapshot, root: RefObject<HTMLElement | null>, selected: string | null, requestKey: string) {
  // A route rebind clears the controller in an effect. Capture a verified actor
  // from this render first, and only replace that origin for a new URL intent.
  const [requestOwner, setRequestOwner] = useState(() => ({ key: requestKey, selected, actor: snapshot.actorId }));
  if (requestOwner.key !== requestKey || requestOwner.selected !== selected) {
    setRequestOwner({ key: requestKey, selected, actor: snapshot.actorId });
  }
  const jump = useCallback(() => {
    const container = root.current;
    const current = controller.getSnapshot();
    if (!container || selected === null || current.session !== "active" || current.actorId === null || current.actorId !== snapshot.actorId ||
        current.error === "account-changed" || !current.loaded || !visibleElement(container) || nativeModalAbove(container)) return;
    const row = selectedRow(container, selected);
    if (!row || !current.items.some(entry => notificationSelectionId(entry.item.id) === selected)) return;
    if (!focusElement(row, true) && focusLandmark(row)) row.scrollIntoView({ block: "nearest" });
  }, [controller, snapshot.actorId, root, selected]);

  useEffect(() => {
    const container = root.current;
    const view = container?.ownerDocument.defaultView;
    if (!container || !view || selected === null) return;
    const document = container.ownerDocument;
    const active = document.activeElement;
    const activeElement = htmlElement(active, document) ? active : null;
    // The route commits before the chrome hides its source panel. A link to
    // this exact URL is the navigation origin, not a newly opened dialog.
    const sourceLink = activeElement?.closest<HTMLAnchorElement>("a[href]");
    const fromNavigation = sourceLink?.href === view.location.href;
    let interrupted = activeElement !== null && (activeElement.closest(".nw-inbox-filters") !== null ||
      !fromNavigation && activeElement.closest("[role=dialog], dialog") !== null);
    let finished = false;
    let frame = 0;
    let actor = requestOwner.actor ?? controller.getSnapshot().actorId;
    const abort = new AbortController();
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      abort.abort();
      unsubscribe?.();
      view.cancelAnimationFrame(frame);
    };
    const interrupt = () => { interrupted = true; };
    const options = { capture: true, signal: abort.signal };
    document.addEventListener("pointerdown", interrupt, options);
    document.addEventListener("keydown", interrupt, options);
    document.addEventListener("focusin", event => {
      // The chrome's committed-navigation focus on main is compatible with the
      // pending row. A different field, filter or dialog is a new reader intent.
      if (event.target !== container && (!htmlElement(event.target, document) || event.target.tagName !== "MAIN")) interrupt();
    }, options);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") finish();
    }, options);
    document.addEventListener("wheel", interrupt, { ...options, passive: true });
    document.addEventListener("touchmove", interrupt, { ...options, passive: true });
    view.addEventListener("resize", interrupt, { signal: abort.signal });
    view.addEventListener("pagehide", finish, { signal: abort.signal });
    view.addEventListener("blur", interrupt, { signal: abort.signal });

    const resolve = () => {
      frame = 0;
      if (finished || !container.isConnected || document.visibilityState === "hidden") { finish(); return; }
      const state = controller.getSnapshot();
      if (state.session === "signed-out" || state.error === "account-changed" || state.error && !state.loaded) { finish(); return; }
      if (state.session !== "active" || state.actorId === null) return;
      if (actor !== null && state.actorId !== actor) { finish(); return; }
      actor = state.actorId;
      if (!state.loaded) return;
      const row = selectedRow(container, selected);
      if (!interrupted && row && visibleElement(container) && !nativeModalAbove(container)) {
        if (!focusElement(row, true) && focusLandmark(row)) row.scrollIntoView({ block: "nearest" });
      }
      // Absence means filtered, older or unavailable. It is not permission to
      // enumerate private history automatically, even for a well-formed UUID.
      finish();
    };
    const schedule = () => {
      if (finished) return;
      // Latch verified identity synchronously, not on the first paint. A route
      // rebind briefly clears the store before verifying the same actor again;
      // that empty state is not evidence that a replacement actor was accepted.
      const next = controller.getSnapshot();
      if (next.error === "account-changed" || next.error && !next.loaded) { finish(); return; }
      if (actor !== null && next.actorId !== null && next.actorId !== actor) { finish(); return; }
      actor ??= next.actorId;
      if (frame === 0) frame = view.requestAnimationFrame(resolve);
    };
    unsubscribe = controller.subscribe(schedule);
    schedule();
    return finish;
  }, [controller, root, selected, requestKey, requestOwner]);

  return jump;
}
