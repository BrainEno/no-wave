import type { Locale } from "./content.ts";
import type { NotificationSnapshot } from "./notification-controller.ts";
import type { NotificationProblem } from "./notification-transport.ts";

export function notificationProblemText(problem: NotificationProblem, locale: Locale): string {
  const en = locale === "en";
  switch (problem) {
    case "unauthenticated": return en ? "Your session has expired. Sign in again." : "登录已过期，请重新登录。";
    case "invalid-response": return en ? "The notification response was invalid. Refresh to try again." : "通知响应格式不正确，请刷新通知重试。";
    case "timeout": return en ? "Notifications timed out. Refresh to try again." : "通知载入超时，请刷新通知重试。";
    case "stalled-page": return en ? "The notification page did not advance. Refresh to try again." : "通知分页没有前进，请刷新通知重试。";
    case "cancelled":
    case "unavailable": return en ? "Notifications are temporarily unavailable. Refresh to try again." : "通知暂时无法载入，请刷新通知重试。";
  }
}

/** The API total is the whole inbox, not the number of visible unread rows. */
export function notificationSummary(snapshot: NotificationSnapshot, locale: Locale): string | null {
  if (!snapshot.loaded) return null;
  const loaded = snapshot.items.length;
  const visibleUnread = snapshot.items.filter((item) => !item.read).length;
  const total = snapshot.unread;
  const en = locale === "en";
  const summary = en ? `${loaded} loaded, ${visibleUnread} unread here; ${total === null ? "unknown" : total} unread in the whole inbox.`
    : `已载入 ${loaded} 条，其中 ${visibleUnread} 条未读；全收件箱 ${total === null ? "未知" : total} 条未读。`;
  if (snapshot.error) return summary + (en ? " The count is the last confirmed value; refresh to reconcile." : " 数量为上次确认的值，请刷新通知核对。");
  if (total !== null && total < visibleUnread) return summary + (en ? " The inbox changed during the read; refresh to reconcile." : " 读取期间状态发生了变化，请刷新通知核对。");
  if (snapshot.nextCursor || total !== null && total > visibleUnread) return summary + (en ? " The total includes notifications not yet loaded." : " 未读数包含尚未载入的通知。");
  return summary;
}
