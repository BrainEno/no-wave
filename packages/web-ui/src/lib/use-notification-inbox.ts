import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { Locale } from "./content.ts";
import type { NotificationController, NotificationSnapshot } from "./notification-controller.ts";
import { inboxActionFeedback, inboxFocusSuccessor, notificationInboxModel, type InboxAction, type InboxFilters, type InboxRow } from "./notification-inbox-model.ts";
import { observePendingFocus } from "./pending-focus-intent.ts";
import { notificationInboxCopy } from "./notification-inbox-copy.ts";
import { focusElement, htmlElement, nativeModalAbove, visibleElement } from "./overlay-focus.ts";

/** UI focus/announcements never acquire identity or retry an uncertain write. */
export function useNotificationInbox(controller: NotificationController, snapshot: NotificationSnapshot, locale: Locale, filters: InboxFilters, rows: readonly InboxRow[]) {
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const tickets = useRef({ identity: 0, operation: 0 });
  const focusFrame = useRef(0);
  const pendingFocus = useRef<(() => void) | null>(null);
  const [cursor, setCursor] = useState<{ actor: string; id: string } | null>(null);
  const activeRowId = cursor?.actor === snapshot.actorId && rows.some(row => row.id === cursor.id) ? cursor.id : rows[0]?.id ?? null;
  const [announcement, setAnnouncement] = useState<{ actor: string | null; text: string } | null>(null);

  useEffect(() => {
    const owner = tickets.current;
    mounted.current = true;
    let lastSession = controller.getSnapshot().session;
    let lastActor = controller.getSnapshot().actorId;
    let lastProblem = controller.getSnapshot().error;
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot();
      if (next.session !== lastSession || next.actorId !== lastActor || next.error === "account-changed" && lastProblem !== next.error) {
        owner.identity++;
        owner.operation++;
        window.cancelAnimationFrame(focusFrame.current);
        pendingFocus.current?.();
        pendingFocus.current = null;
        setCursor(null);
        setAnnouncement(null);
      }
      lastSession = next.session; lastActor = next.actorId; lastProblem = next.error;
    });
    return () => {
      mounted.current = false;
      owner.identity++;
      owner.operation++;
      window.cancelAnimationFrame(focusFrame.current);
      pendingFocus.current?.();
      pendingFocus.current = null;
      unsubscribe();
    };
  }, [controller]);

  useEffect(() => {
    tickets.current.operation++;
    window.cancelAnimationFrame(focusFrame.current);
    pendingFocus.current?.();
    pendingFocus.current = null;
    setCursor(null);
    setAnnouncement(null);
  }, [locale, filters.view, filters.kind]);

  const run = useCallback(async (action: InboxAction): Promise<void> => {
    const container = root.current;
    if (!container) return;
    const before = controller.getSnapshot();
    const model = notificationInboxModel(before, locale, filters);
    const allowed = action.kind === "mark" ? model.canWrite : action.kind === "more" ? model.canLoadMore : model.canRefresh;
    if (!allowed) {
      if (before.pending !== null) setAnnouncement({ actor: before.actorId, text: notificationInboxCopy(locale).busy });
      return;
    }
    const epoch = tickets.current.identity;
    const ticket = ++tickets.current.operation;
    const document = container.ownerDocument;
    const initiator = htmlElement(document.activeElement, document) && container.contains(document.activeElement) ? document.activeElement : null;
    const priorIds = model.rows.map(row => row.id);
    pendingFocus.current?.();
    window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = 0;
    const intent = observePendingFocus(document, initiator);
    const releaseIntent = () => {
      intent.dispose();
      if (pendingFocus.current === releaseIntent) pendingFocus.current = null;
    };
    pendingFocus.current = releaseIntent;
    setAnnouncement(null);
    let queued = false;
    try {
      try {
        if (action.kind === "mark") await controller.markRead(action.id);
        else if (action.kind === "more") await controller.loadMore();
        else await controller.refresh();
      } catch {
        // An injected transport may throw even though the production controller
        // already classifies failures. Never retry a read-state mutation here.
        if (mounted.current && epoch === tickets.current.identity && ticket === tickets.current.operation) {
          setAnnouncement({ actor: before.actorId, text: notificationInboxCopy(locale).failed });
        }
        return;
      }
      const after = controller.getSnapshot();
      if (!mounted.current || epoch !== tickets.current.identity || ticket !== tickets.current.operation || before.actorId !== after.actorId || after.session !== "active") return;
      const text = inboxActionFeedback(before, after, action, locale, filters);
      if (text) setAnnouncement({ actor: after.actorId, text });
      if (!initiator || !intent.mayRepair()) return;
      const repair = window.requestAnimationFrame(() => {
        if (focusFrame.current === repair) focusFrame.current = 0;
        try {
          // The listener must outlive the promise: new input can arrive between
          // the state commit and this frame. A native dialog also owns focus.
          if (!intent.mayRepair() || nativeModalAbove(container)) return;
          if (!mounted.current || ticket !== tickets.current.operation || epoch !== tickets.current.identity || !visibleElement(container)) return;
          const current = document.activeElement;
          // A reader who moved to a filter, the bell or another field owns that
          // focus. Completion only repairs focus lost by its own disabled/removed UI.
          if (current !== initiator && current !== document.body && current !== null) return;
          if (document.visibilityState === "hidden") return;
          const latest = controller.getSnapshot();
          if (latest.actorId !== before.actorId || latest.session !== "active") return;
          const nextRows = notificationInboxModel(latest, locale, filters).rows;
          const nextIds = nextRows.map(row => row.id);
          let target: string | null = null;
          if (action.kind === "mark" && action.id !== undefined) target = inboxFocusSuccessor(priorIds, nextIds, action.id);
          if (action.kind === "more") {
            const previous = new Set(priorIds);
            target = nextIds.find(id => !previous.has(id)) ?? null;
          }
          if (target !== null) {
            const row = Array.from(container.querySelectorAll<HTMLElement>("[data-notification-id]")).find(element => element.dataset.notificationId === target);
            if (focusElement(row, true)) return;
          }
          if (focusElement(initiator)) return;
          focusElement(container.querySelector<HTMLElement>("[data-inbox-focus-fallback]"));
        } finally { releaseIntent(); }
      });
      focusFrame.current = repair;
      queued = true;
    } finally {
      if (!queued) releaseIntent();
    }
  }, [controller, locale, filters]);

  const onFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const container = root.current;
    if (!container || !htmlElement(event.target, container.ownerDocument)) return;
    const row = event.target.closest<HTMLElement>("[data-notification-id]");
    const actor = controller.getSnapshot().actorId;
    if (!row || !container.contains(row) || !row.dataset.notificationId || actor === null) return;
    const id = row.dataset.notificationId;
    setCursor(previous => previous?.actor === actor && previous.id === id ? previous : { actor, id });
  }, [controller]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const container = root.current;
    if (!container || !htmlElement(event.target, container.ownerDocument) || !event.target.hasAttribute("data-notification-id")) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-notification-id]")).filter(visibleElement);
    const index = rows.indexOf(event.target);
    if (index < 0 || rows.length === 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    focusElement(rows[next], true);
  }, []);

  return { root, run, onKeyDown, onFocusCapture, activeRowId,
    announcement: snapshot.session === "active" && announcement?.actor === snapshot.actorId ? announcement?.text ?? "" : "" };
}
