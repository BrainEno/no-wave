import assert from "node:assert/strict";
import test from "node:test";
import { getUi } from "./ui-copy.ts";
import {
  deletionNoticeText,
  grainOffsets,
  grainTileData,
  isNotificationItem,
  notificationRows,
  parseUnreadCount,
  sessionMarkerFromCookie,
  shouldUseSmoothScroll,
  unreadBadge,
} from "./chrome.ts";

const notice = {
  type: "article.deleted" as const,
  articleId: "11111111-1111-4111-8111-111111111111",
  purgesAt: "2999-01-01T00:00:00.000Z",
};

test("the writing entry is translated in both locales", () => {
  assert.equal(getUi("zh-CN").nav.write, "写作");
  assert.equal(getUi("en").nav.write, "Write");
});

test("unread badges stay within the design-system range", () => {
  assert.equal(unreadBadge(0), "");
  assert.equal(unreadBadge(1), "1");
  assert.equal(unreadBadge(99), "99");
  assert.equal(unreadBadge(100), "99+");
  assert.equal(unreadBadge(Number.NaN), "");
});

test("unread counts accept only the API's non-negative number envelope", () => {
  assert.equal(parseUnreadCount({ data: 4 }), 4);
  assert.equal(parseUnreadCount({ data: 12.9 }), 12);
  assert.equal(parseUnreadCount(7), 7);
  assert.equal(parseUnreadCount({ data: -1 }), null);
  assert.equal(parseUnreadCount({ data: "4" }), null);
  assert.equal(parseUnreadCount(null), null);
});

test("notification rows keep known notices and drop malformed or unknown ones", () => {
  const item = {
    id: "22222222-2222-4222-8222-222222222222",
    eventKey: "article.deleted",
    payload: JSON.stringify(notice),
    createdAt: "2026-01-01T00:00:00.000Z",
    readAt: null,
  };
  assert.equal(isNotificationItem(item), true);
  const rows = notificationRows({ data: [
    item,
    { ...item, id: "bad", readAt: 3 },
    { ...item, id: "unknown", payload: JSON.stringify({ type: "message.created" }) },
    { ...item, id: "broken", payload: "not-json" },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.id, item.id);
  assert.deepEqual(rows[0].notice, notice);
  assert.deepEqual(notificationRows({ data: "not-an-array" }), []);
});

test("deletion notices are localized and survive an invalid date", () => {
  assert.match(deletionNoticeText(notice, "zh-CN"), /2999-01-01/);
  assert.match(deletionNoticeText(notice, "en"), /A work you commented on/);
  const broken = { ...notice, purgesAt: "not-a-date" };
  assert.match(deletionNoticeText(broken, "zh-CN"), /你评论过的一篇作品/);
  assert.match(deletionNoticeText(broken, "en"), /A work you commented on/);
});

test("session markers are read from a cookie string without credentials", () => {
  assert.equal(sessionMarkerFromCookie("foo=1; nw_session=1893456000; bar=2", "nw_session"), "1893456000");
  assert.equal(sessionMarkerFromCookie("foo=1", "nw_session"), undefined);
  assert.equal(sessionMarkerFromCookie("nw_session=%ZZ", "nw_session"), undefined);
});

test("grain tile and offsets are generated once, deterministically", () => {
  let calls = 0;
  const random = () => (calls++ % 2 === 0 ? 0 : 0.5);
  const pixels = grainTileData(2, random);
  assert.equal(calls, 4);
  assert.deepEqual(Array.from(pixels), [0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
  const offsets = grainOffsets(256, 3, () => 0.5);
  assert.deepEqual(offsets, [[128, 128], [128, 128], [128, 128]]);
});

test("tool and form routes use native scrolling, reading routes keep the smoother", () => {
  for (const path of ["/write", "/write/media", "/account", "/admin/featured", "/sign-in", "/en/write", "/forgot-password"]) {
    assert.equal(shouldUseSmoothScroll(path), false, path);
  }
  for (const path of ["/", "/en", "/articles/some-slug", "/en/articles", "/authors", "/administrator", "/write-up"]) {
    assert.equal(shouldUseSmoothScroll(path), true, path);
  }
});
