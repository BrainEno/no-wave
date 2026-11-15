import type { Locale } from "./content.ts";
import { notificationPresentation, parseNotificationNotice, type NotificationNotice } from "./chrome.ts";
import type { NotificationSnapshot } from "./notification-controller.ts";
import { notificationProblemText, notificationSummary } from "./notification-feedback.ts";
import { notificationInboxPath } from "./locale-navigation.ts";
import { notificationSelectionId } from "./notification-selection.ts";
import { notificationInboxCopy } from "./notification-inbox-copy.ts";

export const INBOX_VIEWS = ["all", "unread", "read"] as const;
export const INBOX_KINDS = ["all", "comments", "likes", "follows", "messages", "system"] as const;
export type InboxView = typeof INBOX_VIEWS[number];
export type InboxKind = typeof INBOX_KINDS[number];
export type InboxFilters = Readonly<{ view: InboxView; kind: InboxKind }>;
export type InboxRow = Readonly<{ id: string; read: boolean; text: string; href: string | null; dateTime: string | null;
  date: string; group: string; groupLabel: string; kind: Exclude<InboxKind, "all"> }>;
export type InboxModel = Readonly<{ rows: readonly InboxRow[]; canWrite: boolean; canRefresh: boolean; canLoadMore: boolean;
  pending: boolean; emptyText: string | null; remainder: string | null; summary: string | null; problem: string | null; filtered: boolean; loaded: number; visible: number }>;

export function parseInboxFilters(input: string | URLSearchParams): InboxFilters {
  let params: URLSearchParams;
  try { params = typeof input === "string" ? new URLSearchParams(input) : input; }
  catch { return { view: "all", kind: "all" }; }
  const view = params.getAll("view");
  const kind = params.getAll("kind");
  return {
    view: view.length === 1 && INBOX_VIEWS.some(value => value === view[0]) ? view[0] as InboxView : "all",
    kind: kind.length === 1 && INBOX_KINDS.some(value => value === kind[0]) ? kind[0] as InboxKind : "all",
  };
}

export function inboxFilterHref(locale: Locale, filters: InboxFilters, noticeId: string | null = null): string {
  const params = new URLSearchParams();
  if (INBOX_VIEWS.includes(filters.view) && filters.view !== "all") params.set("view", filters.view);
  if (INBOX_KINDS.includes(filters.kind) && filters.kind !== "all") params.set("kind", filters.kind);
  const selected = notificationSelectionId(noticeId);
  if (selected !== null) params.set("notice", selected);
  const search = params.toString();
  return notificationInboxPath(locale) + (search ? "?" + search : "");
}

export function inboxNoticeKind(notice: NotificationNotice): Exclude<InboxKind, "all"> {
  switch (notice.type) {
    case "article.commented":
    case "article.comment_replied": return "comments";
    case "article.liked": return "likes";
    case "user.followed": return "follows";
    case "message.created": return "messages";
    case "article.deleted":
    case "unknown": return "system";
  }
}

function timestampParts(value: string, locale: Locale, now: number, formatter: Intl.DateTimeFormat): { dateTime: string | null; date: string; group: string; groupLabel: string } {
  const time = Date.parse(value);
  const copy = notificationInboxCopy(locale);
  if (!Number.isFinite(time)) return { dateTime: null, date: copy.undated, group: "undated", groupLabel: copy.undated };
  const instant = new Date(time);
  const day = instant.toISOString().slice(0, 10);
  const today = Number.isFinite(now) ? new Date(now).toISOString().slice(0, 10) : "";
  const yesterday = Number.isFinite(now) ? new Date(now - 86400000).toISOString().slice(0, 10) : "";
  const date = formatter.format(instant).replaceAll("/", ".");
  const groupLabel = day === today ? copy.today : day === yesterday ? copy.yesterday : date;
  return { dateTime: instant.toISOString(), date, group: day, groupLabel };
}

function matches(row: InboxRow, filters: InboxFilters): boolean {
  if (filters.view === "unread" && row.read) return false;
  if (filters.view === "read" && !row.read) return false;
  return filters.kind === "all" || row.kind === filters.kind;
}

/** Pure projection only: the controller and API still own every read mutation. */
export function notificationInboxModel(snapshot: NotificationSnapshot, locale: Locale, filters: InboxFilters, now = Date.now()): InboxModel {
  const copy = notificationInboxCopy(locale);
  const pending = snapshot.pending !== null;
  const active = snapshot.session === "active" && snapshot.actorId !== null && snapshot.error !== "account-changed";
  // A detached/stale projection must not re-render private rows after identity
  // is unknown, signed out or awaiting verification of a replacement account.
  const entries = active && snapshot.loaded ? snapshot.items : [];
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  const formatter = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
  for (const { item, read } of entries) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const notice = parseNotificationNotice(item.payload);
    const presentation = notificationPresentation(notice, locale, item.id);
    const row: InboxRow = { id: item.id, read, ...presentation, kind: inboxNoticeKind(notice), ...timestampParts(item.createdAt, locale, now, formatter) };
    if (matches(row, filters)) rows.push(row);
  }
  const filtered = filters.view !== "all" || filters.kind !== "all";
  const canRefresh = snapshot.session === "active" && !pending;
  const canWrite = active && snapshot.loaded && !pending;
  const canLoadMore = active && snapshot.loaded && snapshot.nextCursor !== null && !pending;
  let emptyText: string | null = null;
  if (active && snapshot.loaded && rows.length === 0) {
    emptyText = filtered ? copy.emptyFiltered : snapshot.unread !== null && snapshot.unread > 0 ? copy.unseen : copy.empty;
  }
  const remainder = active && snapshot.loaded && snapshot.nextCursor !== null ? copy.remaining : null;
  return { rows, pending, canWrite, canRefresh, canLoadMore, emptyText, remainder, filtered,
    loaded: seen.size, visible: rows.length,
    summary: active ? notificationSummary(snapshot, locale) : null,
    problem: snapshot.error ? notificationProblemText(snapshot.error, locale) : null };
}

/** Prefer the next surviving row, then the previous; never guess a new actor. */
export function inboxFocusSuccessor(before: readonly string[], after: readonly string[], removed: string): string | null {
  if (after.includes(removed)) return removed;
  const index = before.indexOf(removed);
  if (index < 0) return after[0] ?? null;
  const remaining = new Set(after);
  for (let position = index + 1; position < before.length; position++) if (remaining.has(before[position]!)) return before[position]!;
  for (let position = index - 1; position >= 0; position--) if (remaining.has(before[position]!)) return before[position]!;
  return after[0] ?? null;
}

export type InboxAction = { kind: "mark"; id?: string } | { kind: "refresh" } | { kind: "more" };
export function inboxActionFeedback(before: NotificationSnapshot, after: NotificationSnapshot, action: InboxAction, locale: Locale, filters: InboxFilters): string | null {
  if (before.actorId === null || before.actorId !== after.actorId || after.session !== "active") return null;
  const copy = notificationInboxCopy(locale);
  if (after.error || after.pending !== null) return copy.failed;
  if (action.kind === "refresh") return after.loaded ? copy.refreshed : copy.failed;
  if (action.kind === "more") {
    const old = new Set(before.items.map(row => row.item.id));
    const added = notificationInboxModel(after, locale, filters).rows.filter(row => !old.has(row.id));
    return added.length > 0 ? copy.moreLoaded : copy.noMoreMatches;
  }
  if (action.id !== undefined) {
    return after.items.some(row => row.item.id === action.id && row.read) ? copy.marked : copy.failed;
  }
  if (after.unread === 0) return copy.noneUnread;
  const previouslyUnread = before.items.filter(row => !row.read);
  const confirmed = new Map(after.items.map(row => [row.item.id, row.read]));
  return previouslyUnread.length > 0 && previouslyUnread.every(row => confirmed.get(row.item.id) === true) ? copy.markedAll : copy.failed;
}

