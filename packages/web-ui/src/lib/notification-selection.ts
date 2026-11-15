import type { NotificationSnapshot } from "./notification-controller.ts";

export type NotificationSelectionState = "waiting" | "ready" | "filtered" | "older" | "missing";
const NOTICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** URL selection is a locator inside an authorized snapshot, never an actor. */
export function notificationSelectionId(value: unknown): string | null {
  return typeof value === "string" && NOTICE_ID.test(value) ? value.toLowerCase() : null;
}

export function readNotificationSelection(search: string | URLSearchParams): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const values = params.getAll("notice");
  return values.length === 1 ? notificationSelectionId(values[0]) : null;
}

export function notificationSelectionState(snapshot: NotificationSnapshot, visible: readonly string[], selected: string | null): NotificationSelectionState | null {
  if (selected === null || snapshot.session !== "active" || snapshot.actorId === null || snapshot.error === "account-changed") return null;
  if (!snapshot.loaded) return "waiting";
  if (visible.some(id => notificationSelectionId(id) === selected)) return "ready";
  if (snapshot.items.some(row => notificationSelectionId(row.item.id) === selected)) return "filtered";
  return snapshot.nextCursor !== null ? "older" : "missing";
}
