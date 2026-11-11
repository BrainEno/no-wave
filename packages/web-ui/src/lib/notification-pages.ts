import { isNotificationItem, type NotificationItem } from "./chrome.ts";

/** The proxy and API share this page size. A full page may be the last page. */
export const NOTIFICATION_PAGE_SIZE = 50;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Construct the same base64url (createdAt|id) keyset used by the API. */
export function notificationCursor(item: NotificationItem): string {
  if (!ISO.test(item.createdAt) || !UUID.test(item.id)) throw new Error("通知分页游标格式不正确。");
  return btoa(`${item.createdAt}|${item.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type NotificationPage = { items: NotificationItem[]; nextCursor: string | null };

/** Reject malformed rows rather than silently hiding notifications or stalling. */
export function parseNotificationPage(payload: unknown): NotificationPage {
  if (typeof payload !== "object" || payload === null || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("通知响应格式不正确。");
  }
  const values: unknown[] = payload.data;
  if (values.length > NOTIFICATION_PAGE_SIZE || !values.every(isNotificationItem)) throw new Error("通知响应格式不正确。");
  const items = values as NotificationItem[];
  const last = items.at(-1);
  return { items, nextCursor: items.length === NOTIFICATION_PAGE_SIZE && last ? notificationCursor(last) : null };
}

/** Remove overlap by id without changing the order of already-visible entries. */
export function appendNotificationPage(existing: NotificationItem[], page: NotificationPage): NotificationItem[] {
  const seen = new Set(existing.map((item) => item.id));
  return existing.concat(page.items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }));
}

export async function fetchNotificationPage(cursor: string | null = null): Promise<NotificationPage | null> {
  const query = new URLSearchParams({ limit: String(NOTIFICATION_PAGE_SIZE) });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/authoring/notifications?${query}`, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("通知暂时无法载入。");
  return parseNotificationPage(await response.json().catch(() => null));
}
