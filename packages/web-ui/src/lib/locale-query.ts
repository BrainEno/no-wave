import { notificationSelectionId } from "./notification-selection.ts";
import { MAX_PAGE, parsePage, parseWorkType } from "./work-types.ts";
import type { LocalePage } from "./locale-navigation.ts";

/** A locale link transports page state, never arbitrary bearer/return URLs. */
function singleValue(source: URLSearchParams, name: string, limit: number): string | null {
  const values = source.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0]!;
  if (value.length > limit || /[\u0000-\u001f\u007f\ufffd]/.test(value)) return null;
  return value;
}

function keepText(source: URLSearchParams, result: URLSearchParams, maximum: number): void {
  const value = singleValue(source, "q", maximum);
  if (value === null || value.trim().length === 0) return;
  result.set("q", value);
}

function keepPage(source: URLSearchParams, result: URLSearchParams): void {
  const value = singleValue(source, "page", String(MAX_PAGE).length);
  if (value === null || !/^\d+$/.test(value)) return;
  const page = parsePage(value);
  if (page > 1) result.set("page", String(page));
}

function keepType(source: URLSearchParams, result: URLSearchParams): void {
  const value = singleValue(source, "type", 30);
  if (value === null) return;
  const type = parseWorkType(value);
  if (type !== null) result.set("type", type);
}

function keepTab(source: URLSearchParams, result: URLSearchParams): void {
  const tab = singleValue(source, "tab", 10);
  if (tab === "authors" || tab === "categories") result.set("tab", tab);
}

function keepRecipient(source: URLSearchParams, result: URLSearchParams): void {
  const value = singleValue(source, "to", 300);
  if (value === null) return;
  const recipient = value.trim();
  if (recipient.length === 0 || /[\\/?#%]/.test(recipient)) return;
  result.set("to", recipient);
}

function keepInboxFilters(source: URLSearchParams, result: URLSearchParams): void {
  const view = singleValue(source, "view", 6);
  const kind = singleValue(source, "kind", 8);
  const notice = notificationSelectionId(singleValue(source, "notice", 36));
  if (view === "unread" || view === "read") result.set("view", view);
  switch (kind) {
    case "comments":
    case "likes":
    case "follows":
    case "messages":
    case "system": result.set("kind", kind);
  }
  if (notice !== null) result.set("notice", notice);
}

/** Keep the same filters each registered loader actually consumes. */
export function localeQuery(page: LocalePage, source: URLSearchParams): string {
  const result = new URLSearchParams();
  switch (page) {
    case "archive":
      keepText(source, result, 200);
      keepPage(source, result);
      keepType(source, result);
      break;
    case "authors":
    case "categories":
    case "tags":
      keepText(source, result, 200);
      keepPage(source, result);
      break;
    case "author":
      keepPage(source, result);
      keepType(source, result);
      break;
    case "category":
    case "tag":
      keepPage(source, result);
      break;
    case "search":
      keepText(source, result, 100);
      keepTab(source, result);
      keepType(source, result);
      break;
    case "messages":
      keepRecipient(source, result);
      break;
    case "notifications":
      keepInboxFilters(source, result);
      break;
  }
  const search = result.toString();
  return search ? "?" + search : "";
}
