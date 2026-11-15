import assert from "node:assert/strict";
import test from "node:test";
import { notificationSelectionId, readNotificationSelection, notificationSelectionState } from "./notification-selection.ts";
import { notificationPresentation } from "./chrome.ts";
import { alternatePath } from "./locale-navigation.ts";
import { createNotificationController, type NotificationSnapshot } from "./notification-controller.ts";
import { inboxActionFeedback, inboxFilterHref, inboxFocusSuccessor, notificationInboxModel, parseInboxFilters } from "./notification-inbox-model.ts";

const all = { view: "all", kind: "all" } as const;
const now = Date.parse("2026-11-12T03:00:00.000Z");
function snapshot(): NotificationSnapshot {
  const payloads = [{ type: "article.commented", slug: "english-work", locale: "en" }, { type: "user.followed", followerId: "writer-17" }, { type: "future.event" }];
  return { ...createNotificationController().getServerSnapshot(), session: "active", actorId: "reader-17", status: "ready", loaded: true,
    unread: 52, nextCursor: "opaque-private-cursor",
    items: payloads.map((payload, index) => ({ read: index === 1, item: {
      id: String(index), eventKey: "test", payload: JSON.stringify(payload),
      createdAt: index === 0 ? "2026-11-12T00:01:00.000Z" : index === 1 ? "2026-11-11T23:59:00.000Z" : "invalid", readAt: null,
    } })) };
}

test("full inbox projection localizes text and UTC dates while preserving payload edition destinations", () => {
  const state = snapshot();
  const en = notificationInboxModel(state, "en", all, now);
  const zh = notificationInboxModel(state, "zh-CN", all, now);
  assert.equal(en.rows[0]?.text, "Someone commented on your work.");
  assert.equal(en.rows[0]?.href, "/en/articles/english-work#nw-comments-title");
  assert.equal(zh.rows[0]?.href, en.rows[0]?.href);
  assert.equal(en.rows[0]?.groupLabel, "Today");
  assert.equal(en.rows[1]?.groupLabel, "Yesterday");
  assert.equal(zh.rows[0]?.groupLabel, "今天");
  assert.equal(zh.rows[1]?.groupLabel, "昨天");
  assert.equal(en.rows[2]?.dateTime, null);
  assert.equal(en.rows[2]?.date, "Date unavailable");
  assert.equal(en.rows[2]?.href, "/en/notifications");
  assert.equal(zh.rows[2]?.href, "/notifications");
  assert.match(en.summary!, /52 unread in the whole inbox/);
  assert.equal(state.items[1]?.item.readAt, null, "projection cannot invent a persisted read timestamp");
});

test("filters never reinterpret the server total as the count in the loaded subset", () => {
  const state = snapshot();
  const unread = notificationInboxModel(state, "en", { view: "unread", kind: "all" }, now);
  assert.deepEqual(unread.rows.map(row => row.id), ["0", "2"]);
  assert.equal(unread.loaded, 3);
  assert.equal(unread.visible, 2);
  assert.match(unread.summary!, /3 loaded, 2 unread here; 52 unread/);
  const missing = notificationInboxModel(state, "en", { view: "all", kind: "likes" }, now);
  assert.equal(missing.visible, 0);
  assert.equal(missing.emptyText, "No loaded notifications match these filters.");
  assert.match(missing.remainder!, /Older notifications may still match/);
  assert.equal(missing.canLoadMore, true);
  const read = notificationInboxModel(state, "en", { view: "read", kind: "follows" }, now);
  assert.deepEqual(read.rows.map(row => row.id), ["1"]);
});

test("unverified and replacement identities cannot project cached private rows", () => {
  const source = snapshot();
  for (const change of [{ session: "unknown" }, { session: "signed-out" }, { actorId: null }, { error: "account-changed" } ] as const) {
    const model = notificationInboxModel({ ...source, ...change }, "en", all, now);
    assert.equal(model.rows.length, 0);
    assert.equal(model.summary, null);
    assert.equal(model.emptyText, null);
    assert.equal(model.canWrite, false);
    assert.equal(model.canLoadMore, false);
  }
  const verifying = notificationInboxModel({ ...source, actorId: null }, "en", all, now);
  assert.equal(verifying.canRefresh, true, "an explicit read may verify an account; a write may not");
});

test("pending operations disable every conflicting UI mutation and keep the measured list visible", () => {
  const state = { ...snapshot(), pending: "mark" as const };
  const model = notificationInboxModel(state, "en", all, now);
  assert.equal(model.rows.length, 3);
  assert.equal(model.canWrite, false);
  assert.equal(model.canRefresh, false);
  assert.equal(model.canLoadMore, false);
  assert.equal(model.pending, true);
});

test("empty and stale states never pretend an unread inbox is empty", () => {
  const state = { ...snapshot(), items: [], unread: 1, nextCursor: null };
  assert.match(notificationInboxModel(state, "en", all, now).emptyText!, /Unread notifications remain/);
  assert.equal(notificationInboxModel({ ...state, loaded: false }, "en", all, now).emptyText, null);
  assert.match(notificationInboxModel({ ...state, error: "unavailable" }, "en", all, now).summary!, /last confirmed value/);
  assert.equal(notificationInboxModel({ ...state, unread: 0 }, "en", all, now).emptyText, "No notifications yet.");
});

test("filter URLs only transport registered state and reject ambiguity", () => {
  assert.deepEqual(parseInboxFilters("?view=unread&kind=messages&token=private"), { view: "unread", kind: "messages" });
  for (const search of ["?view=unread&view=read", "?view=UnRead", "?kind=%00", "?view[]=read", "?kind=messages&kind=likes"]) {
    assert.deepEqual(parseInboxFilters(search), all);
  }
  assert.equal(inboxFilterHref("en", { view: "unread", kind: "messages" }), "/en/notifications?view=unread&kind=messages");
  assert.equal(inboxFilterHref("zh-CN", all), "/notifications");
});

test("focus successor favors a stable row then next, previous or the empty-list fallback", () => {
  const before = ["a", "b", "c", "d"];
  assert.equal(inboxFocusSuccessor(before, ["a", "b", "c"], "b"), "b");
  assert.equal(inboxFocusSuccessor(before, ["a", "c"], "b"), "c");
  assert.equal(inboxFocusSuccessor(before, ["a"], "d"), "a");
  assert.equal(inboxFocusSuccessor(before, ["new"], "b"), "new");
  assert.equal(inboxFocusSuccessor(before, [], "b"), null);
});

test("announcements require a confirmed action for the same verified actor", () => {
  const before = snapshot();
  const marked = { ...before, items: before.items.map(row => ({ ...row, read: true })) };
  assert.equal(inboxActionFeedback(before, marked, { kind: "mark", id: "0" }, "en", all), "Notification marked read.");
  assert.match(inboxActionFeedback(before, marked, { kind: "mark" }, "en", all)!, /marked read/);
  assert.equal(inboxActionFeedback(before, { ...marked, actorId: "replacement" }, { kind: "mark" }, "en", all), null);
  assert.equal(inboxActionFeedback(before, { ...marked, session: "signed-out" }, { kind: "mark" }, "en", all), null);
  assert.match(inboxActionFeedback(before, { ...marked, error: "timeout" }, { kind: "mark" }, "en", all)!, /not fully confirmed/);
  assert.match(inboxActionFeedback(before, before, { kind: "mark", id: "0" }, "en", all)!, /not fully confirmed/);
  assert.equal(inboxActionFeedback(before, before, { kind: "more" }, "en", { view: "all", kind: "likes" }), "This page added no matching notifications.");
});


const selectedId = "70000000-0000-4000-8000-000000000001";

test("unknown-notice selection is a validated inbox locator that survives language and filter changes", () => {
  const href = notificationPresentation({ type: "unknown" }, "en", selectedId).href;
  assert.equal(href, `/en/notifications?notice=${selectedId}`);
  assert.equal(alternatePath(href!, "en"), `/notifications?notice=${selectedId}`);
  assert.equal(inboxFilterHref("en", { view: "unread", kind: "system" }, selectedId), `/en/notifications?view=unread&kind=system&notice=${selectedId}`);
  for (const value of [undefined, null, "../write", "https://outside.invalid", selectedId + " ", selectedId.replace("4000", "0000"), "<script>"]) {
    assert.equal(notificationSelectionId(value), null);
    assert.equal(notificationPresentation({ type: "unknown" }, "en", typeof value === "string" ? value : undefined).href, "/en/notifications");
  }
  assert.equal(readNotificationSelection(`?notice=${selectedId.toUpperCase()}`), selectedId);
  assert.equal(readNotificationSelection(`?notice=${selectedId}&notice=${selectedId}`), null);
  assert.equal(readNotificationSelection("?notice=%00"), null);
});

test("selected notice states distinguish filters, unloaded history and unavailable rows without acquiring identity", () => {
  const source = snapshot();
  const state = { ...source, items: [{ ...source.items[0]!, item: { ...source.items[0]!.item, id: selectedId } }] };
  assert.equal(notificationSelectionState(state, [selectedId], selectedId), "ready");
  assert.equal(notificationSelectionState(state, [], selectedId), "filtered");
  assert.equal(notificationSelectionState({ ...state, items: [] }, [], selectedId), "older");
  assert.equal(notificationSelectionState({ ...state, items: [], nextCursor: null }, [], selectedId), "missing");
  assert.equal(notificationSelectionState({ ...state, loaded: false }, [], selectedId), "waiting");
  for (const change of [{ actorId: null }, { session: "signed-out" }, { error: "account-changed" }] as const) {
    assert.equal(notificationSelectionState({ ...state, ...change }, [selectedId], selectedId), null);
  }
  assert.equal(notificationSelectionState(state, [selectedId], null), null);
});
