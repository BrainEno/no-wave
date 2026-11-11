import assert from "node:assert/strict";
import test from "node:test";
import { getUi } from "./ui-copy.ts";
import { SESSION_MARKER_COOKIE, hasUsableSession, tokenCookieHeaders } from "@bot-thk/web-http";
import {
  deletionNoticeText,
  grainOffsets,
  grainTileData,
  isNotificationItem,
  notificationRows,
  parseNotificationNotice,
  notificationPresentation,
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

test("notification rows retain unknown and malformed payloads but reject invalid envelopes", () => {
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
  assert.equal(rows.length, 3);
  assert.equal(rows[0].item.id, item.id);
  assert.deepEqual(rows[0].notice, notice);
  assert.equal(rows[1].notice.type, "message.created");
  assert.equal(rows[2].notice.type, "unknown");
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

test("the marker the proxy sets is the cookie the top bar can actually read", () => {
  // A browser's document.cookie contains every cookie except the HttpOnly ones.
  // Feed the proxy's own Set-Cookie output through that rule, then through the
  // two helpers SiteChrome uses. This is the #161 regression: when marker was
  // HttpOnly the bell could never see a signed-in session.
  const request = new Request("https://no-wave.test/api/auth/login", {
    headers: { origin: "https://no-wave.test" },
  });
  const now = Date.now();
  const emitted = tokenCookieHeaders(request, {
    accessToken: `access-token-${"a".repeat(32)}`,
    refreshToken: "r".repeat(43),
    tokenType: "Bearer",
    accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    refreshExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }, now);
  const visible = emitted
    .filter((cookie) => !/HttpOnly/.test(cookie))
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

  assert.match(visible, new RegExp(`${SESSION_MARKER_COOKIE}=`));
  assert.equal(visible.includes("nw_access="), false, "the access token stays off the page");
  assert.equal(visible.includes("nw_refresh="), false, "the refresh token stays off the page");
  assert.equal(hasUsableSession(sessionMarkerFromCookie(visible, SESSION_MARKER_COOKIE), now), true);
  assert.equal(hasUsableSession(sessionMarkerFromCookie(`foo=1; ${visible}; bar=2`, SESSION_MARKER_COOKIE), now), true);
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
  for (const path of ["/write", "/write/media", "/write/notion", "/account", "/admin/featured", "/sign-in", "/en/write", "/forgot-password"]) {
    assert.equal(shouldUseSmoothScroll(path), false, path);
  }
  for (const path of ["/", "/en", "/articles/some-slug", "/en/articles", "/authors", "/administrator", "/write-up"]) {
    assert.equal(shouldUseSmoothScroll(path), true, path);
  }
});


test("notification presentations cover API event types, unknown payloads, and safe links", () => {
  const cases = [
    [{ type: "article.commented", slug: "my-work" }, /评论/, "/articles/my-work#nw-comments-title"],
    [{ type: "article.comment_replied", slug: "my-work" }, /回复/, "/articles/my-work#nw-comments-title"],
    [{ type: "article.liked", slug: "my-work", locale: "en" }, /喜欢/, "/en/articles/my-work"],
    [{ type: "user.followed", followerId: "user-1" }, /关注/, "/authors/user-1"],
    [{ type: "message.created", conversationId: "conversation-1" }, /私信/, "/messages/conversation-1"],
    [{ type: "future.event" }, /通知/, "/write"],
  ] as const;
  for (const [payload, text, href] of cases) {
    const parsed = parseNotificationNotice(JSON.stringify(payload));
    const view = notificationPresentation(parsed, "zh-CN");
    assert.match(view.text, text);
    assert.equal(view.href, href);
    assert.ok(notificationPresentation(parsed, "en").text.length > 0);
  }
  assert.equal(notificationPresentation(parseNotificationNotice('{"type":"article.liked","slug":"//evil.test"}'), "en").href, null);
  assert.equal(notificationPresentation(parseNotificationNotice('{"type":"user.followed","followerId":".."}'), "en").href, null);
  assert.equal(notificationPresentation(parseNotificationNotice(JSON.stringify(notice)), "en").href, null, "deleted works are no longer publicly reachable");
});

test("notification types emitted by known API producers have dedicated presentations", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "application/services.ts",
    "persistence/sqlite-engagement-store.ts", "persistence/postgres-engagement-store.ts",
    "persistence/sqlite-profile-store.ts", "persistence/postgres-profile-store.ts",
    "persistence/sqlite-notification-store.ts", "persistence/postgres-notification-store.ts",
  ];
  const emitted = new Set<string>();
  for (const file of files) {
    const source = await readFile(new URL(`../../../../apps/api/src/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?:type:\s*|recipients\.set\([^\n]*?,\s*)"((?:article|user|message)\.[a-z_]+)"/g)) emitted.add(match[1]!);
  }
  assert.deepEqual([...emitted].sort(), ["article.comment_replied", "article.commented", "article.deleted", "article.liked", "message.created", "user.followed"]);
  for (const type of emitted) assert.notEqual(parseNotificationNotice(JSON.stringify({ type, articleId: "a", purgesAt: "2999-01-01" })).type, "unknown", type);
});
