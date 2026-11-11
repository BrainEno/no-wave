import type { Locale } from "./content.ts";

/** Pure helpers behind the shared site chrome. */
export type NotificationItem = { id: string; eventKey: string; payload: string; createdAt: string; readAt: string | null };
export type NotificationRow = { item: NotificationItem; text: string; href?: string };
export type DeletedArticleNotice = { type: "article.deleted"; articleId: string; purgesAt: string };
export type GrainOffset = readonly [number, number];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isNotificationItem(value: unknown): value is NotificationItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.eventKey === "string" && typeof value.payload === "string" && typeof value.createdAt === "string" && (value.readAt === null || typeof value.readAt === "string");
}
export function parseDeletedArticleNotice(payload: string): DeletedArticleNotice | null {
  let parsed: unknown; try { parsed = JSON.parse(payload); } catch { return null; }
  if (!isRecord(parsed) || parsed.type !== "article.deleted" || typeof parsed.articleId !== "string" || typeof parsed.purgesAt !== "string") return null;
  return { type: "article.deleted", articleId: parsed.articleId, purgesAt: parsed.purgesAt };
}
function parsePayload(payload: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(payload); return isRecord(value) ? value : null; } catch { return null; } }
function safeArticleHref(value: unknown, locale: Locale): string | undefined {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return undefined;
  return `${locale === "en" ? "/en" : ""}/articles/${encodeURIComponent(value)}`;
}
function calendarDay(timestamp: string): string | null { const parsed = new Date(timestamp); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10); }
function daysFromNow(timestamp: string, now = Date.now()): number | null { const parsed = new Date(timestamp); if (Number.isNaN(parsed.getTime())) return null; return Math.max(0, Math.ceil((parsed.getTime() - now) / 86_400_000)); }
export function deletionNoticeText(notice: DeletedArticleNotice, locale: Locale = "zh-CN"): string {
  const day = calendarDay(notice.purgesAt), days = daysFromNow(notice.purgesAt);
  if (locale === "en") return day === null ? "A work you commented on was deleted by its author; your comment will be removed with it." : `A work you commented on was deleted by its author; your comment will be removed with it on ${day}${days && days > 0 ? ` (about ${days} days from now)` : ""}.`;
  return day === null ? "你评论过的一篇作品已被作者删除，你的评论会随作品一起清除。" : `你评论过的一篇作品已被作者删除，你的评论会在 ${day}${days && days > 0 ? `（约 ${days} 天后）` : ""} 随作品一起清除。`;
}
function notificationText(payload: Record<string, unknown>, locale: Locale): { text: string; href?: string } {
  const en = locale === "en";
  switch (payload.type) {
    case "article.deleted": return { text: deletionNoticeText(payload as unknown as DeletedArticleNotice, locale) };
    case "article.liked": return { text: en ? "Someone liked your work." : "有人喜欢了你的作品。", href: safeArticleHref(payload.slug, locale) };
    case "article.commented": case "article.comment_replied": return { text: en ? "There is a new comment on your work." : "你的作品收到新评论。", href: safeArticleHref(payload.slug, locale) };
    case "user.followed": return { text: en ? "Someone started following you." : "有人开始关注你。", href: typeof payload.followerId === "string" ? `/authors/${encodeURIComponent(payload.followerId)}` : undefined };
    case "message.created": return { text: en ? "You received a new message." : "你收到一条新私信。", href: "/messages" };
    default: return { text: en ? "You have a new notification." : "你有一条新通知。" };
  }
}
export function notificationRows(payload: unknown, locale: Locale = "zh-CN"): NotificationRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const rows: NotificationRow[] = [];
  for (const value of payload.data) {
    if (!isNotificationItem(value)) continue;
    const body = parsePayload(value.payload);
    rows.push({ item: value, ...(body ? notificationText(body, locale) : { text: locale === "en" ? "You have a new notification." : "你有一条新通知。" }) });
  }
  return rows;
}
export function parseUnreadCount(payload: unknown): number | null { const value = isRecord(payload) && "data" in payload ? payload.data : payload; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null; return Math.max(0, Math.trunc(value)); }
export function unreadBadge(count: number): string { if (!Number.isFinite(count) || count <= 0) return ""; const whole = Math.max(0, Math.trunc(count)); return whole > 99 ? "99+" : String(whole); }
export function sessionMarkerFromCookie(cookie: string, name: string): string | undefined { const prefix = `${name}=`; for (const part of cookie.split(";")) { const entry = part.trim(); if (!entry.startsWith(prefix)) continue; try { return decodeURIComponent(entry.slice(prefix.length)); } catch { return undefined; } } return undefined; }
export function grainTileData(size: number, random: () => number = Math.random): Uint8ClampedArray { const pixels = new Uint8ClampedArray(size * size * 4); for (let index = 0; index < pixels.length; index += 4) { const value = Math.max(0, Math.min(255, Math.floor(random() * 256))); pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value; pixels[index + 3] = 255; } return pixels; }
export function grainOffsets(size: number, count = 16, random: () => number = Math.random): GrainOffset[] { return Array.from({ length: count }, (): GrainOffset => [Math.floor(random() * size), Math.floor(random() * size)]); }
const NATIVE_SCROLL_PREFIXES = ["/write", "/account", "/admin", "/sign-in", "/forgot-password", "/reset-password", "/verify-email"] as const;
export function shouldUseSmoothScroll(pathname: string): boolean { const bare = pathname.replace(/^\/en(?=\/|$)/, "") || "/"; return !NATIVE_SCROLL_PREFIXES.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`)); }
