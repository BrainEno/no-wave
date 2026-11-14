import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationController, type NotificationSnapshot } from "./notification-controller.ts";
import { notificationProblemText, notificationSummary } from "./notification-feedback.ts";
import type { NotificationProblem } from "./notification-transport.ts";

function state(unread: number | null = 2): NotificationSnapshot {
  return { ...createNotificationController().getServerSnapshot(), session: "active", status: "ready", loaded: true, unread,
    items: [false, false, true].map((read, index) => ({ read, item: { id: String(index), eventKey: "test", payload: "{}", createdAt: "2026-11-01T00:00:00.000Z", readAt: null } })) };
}

test("unloaded totals and visible unread rows are labelled separately rather than clamped to each other", () => {
  const snapshot = { ...state(52), nextCursor: "opaque-cursor" };
  assert.match(notificationSummary(snapshot, "zh-CN")!, /已载入 3 条，其中 2 条未读；全收件箱 52 条未读/);
  assert.match(notificationSummary(snapshot, "zh-CN")!, /未读数包含尚未载入的通知/);
  assert.match(notificationSummary(snapshot, "en")!, /3 loaded, 2 unread here; 52 unread in the whole inbox/);
  assert.match(notificationSummary(snapshot, "en")!, /not yet loaded/);
});

test("a fully loaded consistent inbox does not falsely claim missing older notices", () => {
  assert.doesNotMatch(notificationSummary(state(), "zh-CN")!, /尚未载入|发生了变化/);
  assert.doesNotMatch(notificationSummary(state(), "en")!, /not yet loaded|changed during/);
});

test("a concurrent server-side read is explained, not hidden by changing the authoritative total", () => {
  assert.match(notificationSummary(state(0), "zh-CN")!, /2 条未读；全收件箱 0 条未读/);
  assert.match(notificationSummary(state(0), "zh-CN")!, /读取期间状态发生了变化/);
  assert.match(notificationSummary(state(0), "en")!, /changed during the read/);
});

test("an arrival above a completed cursor still explains a nonzero unseen unread total", () => {
  const snapshot = { ...state(1), items: state().items.map((row) => ({ ...row, read: true })) };
  assert.match(notificationSummary(snapshot, "zh-CN")!, /其中 0 条未读；全收件箱 1 条未读/);
  assert.match(notificationSummary(snapshot, "en")!, /not yet loaded/);
});

test("unknown and stale counts are honest; loading shells do not pretend to have a measured total", () => {
  assert.equal(notificationSummary({ ...state(), loaded: false }, "zh-CN"), null);
  assert.match(notificationSummary(state(null), "en")!, /unknown unread/);
  assert.match(notificationSummary(state(null), "zh-CN")!, /全收件箱 未知/);
  assert.match(notificationSummary({ ...state(), error: "unavailable" }, "zh-CN")!, /上次确认的值/);
  assert.match(notificationSummary({ ...state(), error: "timeout" }, "en")!, /last confirmed value/);
});

test("every failure has localized, non-diagnostic recovery copy", () => {
  const problems: NotificationProblem[] = ["unauthenticated", "account-changed", "unavailable", "invalid-response", "timeout", "cancelled", "stalled-page"];
  for (const problem of problems) {
    const zh = notificationProblemText(problem, "zh-CN"), en = notificationProblemText(problem, "en");
    assert.ok(zh.length > 0 && en.length > 0 && zh !== en);
    assert.doesNotMatch(zh + en, /synthetic-private|stack trace|Bearer|Cookie/);
    assert.match(en, /Sign in|Refresh/);
  }
});
