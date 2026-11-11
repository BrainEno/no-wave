import type { Locale } from "./content.ts";

/**
 * Pure helpers behind the shared site chrome.
 *
 * Keeping the parsing, badge, grain and route decisions here means the client
 * component only owns effects and rendering: the public SSR shell stays free of
 * session reads, and the rules below can be tested without a browser.
 */

export type NotificationItem = {
  id: string;
  eventKey: string;
  payload: string;
  createdAt: string;
  readAt: string | null;
};

export type DeletedArticleNotice = {
  type: "article.deleted";
  articleId: string;
  purgesAt: string;
};

export type NotificationNotice =
  | DeletedArticleNotice
  | { type: "article.commented" | "article.comment_replied" | "article.liked"; slug: string | null; locale: string | null }
  | { type: "user.followed"; followerId: string | null }
  | { type: "message.created"; conversationId: string | null }
  | { type: "unknown" };

export type NotificationRow = {
  item: NotificationItem;
  notice: NotificationNotice;
};

export type GrainOffset = readonly [number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNotificationItem(value: unknown): value is NotificationItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.eventKey === "string" &&
    typeof value.payload === "string" && typeof value.createdAt === "string" &&
    (value.readAt === null || typeof value.readAt === "string");
}

/** Parse the deletion payload for the retention notice. */
export function parseDeletedArticleNotice(payload: string): DeletedArticleNotice | null {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== "article.deleted") return null;
  if (typeof parsed.articleId !== "string" || typeof parsed.purgesAt !== "string") return null;
  return { type: "article.deleted", articleId: parsed.articleId, purgesAt: parsed.purgesAt };
}

function calendarDay(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function daysFromNow(timestamp: string, now = Date.now()): number | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.ceil((parsed.getTime() - now) / 86_400_000));
}

export function deletionNoticeText(notice: DeletedArticleNotice, locale: Locale = "zh-CN"): string {
  const day = calendarDay(notice.purgesAt);
  const days = daysFromNow(notice.purgesAt);
  if (locale === "en") {
    if (day === null) return "A work you commented on was deleted by its author; your comment will be removed with it.";
    if (days === null || days === 0) {
      return `A work you commented on was deleted by its author; your comment will be removed with it on ${day}.`;
    }
    return `A work you commented on was deleted by its author; your comment will be removed with it on ${day} (about ${days} days from now).`;
  }
  if (day === null) return "你评论过的一篇作品已被作者删除，你的评论会随作品一起清除。";
  if (days === null || days === 0) return `你评论过的一篇作品已被作者删除，你的评论会在 ${day} 随作品一起清除。`;
  return `你评论过的一篇作品已被作者删除，你的评论会在 ${day}（约 ${days} 天后）随作品一起清除。`;
}

/** Malformed and future payloads remain visible as a generic notification. */
export function parseNotificationNotice(payload: string): NotificationNotice {
  const deletion = parseDeletedArticleNotice(payload);
  if (deletion) return deletion;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return { type: "unknown" }; }
  if (!isRecord(parsed)) return { type: "unknown" };
  const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,300}$/.test(value) ? value : null;
  switch (parsed.type) {
    case "article.commented":
    case "article.comment_replied":
    case "article.liked":
      return { type: parsed.type, slug: typeof parsed.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.slug) && parsed.slug.length <= 160 ? parsed.slug : null, locale: typeof parsed.locale === "string" ? parsed.locale : null };
    case "user.followed": return { type: parsed.type, followerId: identifier(parsed.followerId) };
    case "message.created": return { type: parsed.type, conversationId: identifier(parsed.conversationId) };
    default: return { type: "unknown" };
  }
}

/** Only local, validated routes are built from payload fields; never trust a URL in a payload. */
export function notificationPresentation(notice: NotificationNotice, locale: Locale): { text: string; href: string | null } {
  const en = locale === "en";
  const prefix = en ? "/en" : "";
  switch (notice.type) {
    case "article.deleted": return { text: deletionNoticeText(notice, locale), href: null };
    case "article.commented": return { text: en ? "Someone commented on your work." : "有人评论了你的作品。", href: notice.slug ? `${prefix}/articles/${notice.slug}#nw-comments-title` : null };
    case "article.comment_replied": return { text: en ? "Someone replied to your comment." : "有人回复了你的评论。", href: notice.slug ? `${prefix}/articles/${notice.slug}#nw-comments-title` : null };
    case "article.liked": return { text: en ? "Someone liked your work." : "有人喜欢了你的作品。", href: notice.slug ? `${notice.locale === "en" ? "/en" : notice.locale === "zh-CN" || notice.locale === "zh-TW" ? "" : prefix}/articles/${notice.slug}` : null };
    case "user.followed": return { text: en ? "Someone followed you." : "有人关注了你。", href: notice.followerId ? `${prefix}/authors/${encodeURIComponent(notice.followerId)}` : null };
    case "message.created": return { text: en ? "You have a new message." : "你收到一条新私信。", href: notice.conversationId ? `${prefix}/messages/${encodeURIComponent(notice.conversationId)}` : `${prefix}/messages` };
    case "unknown": return { text: en ? "You have a notification." : "你收到一条通知。", href: "/write" };
  }
}

export function notificationRows(payload: unknown): NotificationRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.filter(isNotificationItem).map((item) => ({ item, notice: parseNotificationNotice(item.payload) }));
}

/** The API answers `{ data: number }`; a malformed body is never a badge. */
export function parseUnreadCount(payload: unknown): number | null {
  const value = isRecord(payload) && "data" in payload ? payload.data : payload;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.max(0, Math.trunc(value));
}

export function unreadBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  const whole = Math.max(0, Math.trunc(count));
  return whole > 99 ? "99+" : String(whole);
}

/** Reads the non-sensitive session marker from `document.cookie` after hydration. */
export function sessionMarkerFromCookie(cookie: string, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const entry = part.trim();
    if (!entry.startsWith(prefix)) continue;
    try { return decodeURIComponent(entry.slice(prefix.length)); } catch { return undefined; }
  }
  return undefined;
}

/** One-time 256×256 noise tile; afterwards frames only shift a repeating pattern. */
export function grainTileData(size: number, random: () => number = Math.random): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const value = Math.max(0, Math.min(255, Math.floor(random() * 256)));
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  return pixels;
}

export function grainOffsets(size: number, count = 16, random: () => number = Math.random): GrainOffset[] {
  return Array.from({ length: count }, (): GrainOffset => [
    Math.floor(random() * size),
    Math.floor(random() * size),
  ]);
}

const NATIVE_SCROLL_PREFIXES = [
  "/write", "/account", "/admin", "/sign-in",
  "/forgot-password", "/reset-password", "/verify-email",
] as const;

/**
 * Tool and form routes keep native scrolling: a transformed smoother can move
 * content between mousedown and mouseup and silently swallow a button click.
 */
export function shouldUseSmoothScroll(pathname: string): boolean {
  const bare = pathname.replace(/^\/en(?=\/|$)/, "") || "/";
  return !NATIVE_SCROLL_PREFIXES.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`));
}
