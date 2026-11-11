import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { dateLabel } from "@/lib/format.ts";
import {
  deletionNoticeText,
  isNotificationItem,
  notificationRows,
  notificationPresentation,
  parseUnreadCount,
  type DeletedArticleNotice,
  type NotificationItem,
} from "@/lib/chrome.ts";

export type { NotificationItem, DeletedArticleNotice } from "@/lib/chrome.ts";
export { deletionNoticeText } from "@/lib/chrome.ts";

/**
 * The notification inbox on the writing desk.
 *
 * It exists because deleting a work eventually deletes the comments under it,
 * and those are other people's words: the API writes each commenter a notice
 * naming the date the sweep runs, but a notice nobody can read is a ledger
 * entry, not a message. This is where it becomes readable.
 *
 * Two deliberate limits, both honest:
 *
 * - The notice the API writes today carries the work's id, not its title
 *   (`article.deleted` is structural, like `message.created`), so the sentence
 *   below says "a work you commented on" rather than naming it. Naming it means
 *   carrying the title into the payload — a follow-up, not a rendering trick.
 * - The inbox is read when the desk opens. There is no polling and no push: a
 *   reader learns another author's deletion the next time they open their desk.
 *   That is a real gap, and it is much smaller than the one this closes.
 *
 * The component fetches from the same-origin `/api/authoring/notifications*` proxies, so
 * it is served identically by the App Router and the React Router prototype.
 *
 * The routes live under `/api/authoring/` for one reason: the access cookie is
 * scoped to that path, so a browser sends it there and nowhere else. An inbox
 * at `/api/notifications` would not receive it and would only work by accident,
 * through the refresh-and-retry path — one token rotation per desk open.
 */

type InboxState = "loading" | "ready" | "error";

function messageOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return "通知暂时无法载入。";
}

export function NotificationInbox() {
  const [state, setState] = useState<InboxState>("loading");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    const [response, countResponse] = await Promise.all([
      fetch("/api/authoring/notifications", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/authoring/notifications/unread-count", { credentials: "same-origin", cache: "no-store" }),
    ]);
    const payload: unknown = await response.json().catch(() => null);
    // No session means no inbox; the desk shows its own sign-in panel for that,
    // so this section simply renders nothing rather than a second explanation.
    if (response.status === 401 || countResponse.status === 401) { setState("ready"); setItems([]); setUnreadCount(0); return; }
    if (!response.ok || !countResponse.ok) throw new Error(messageOf(payload));
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("通知响应格式不正确。");
    setItems(data.filter(isNotificationItem));
    const count = parseUnreadCount(await countResponse.json().catch(() => null));
    if (count === null) throw new Error("未读通知数量格式不正确。");
    setUnreadCount(count);
    setError("");
    setState("ready");
  }, []);

  // The inbox is read once, when the desk opens: there is no polling and no
  // push (see the note at the top of this file).
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await reload();
        if (active) setState("ready");
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "通知暂时无法载入。");
        setState("error");
      }
    })();
    return () => { active = false; };
  }, [reload]);

  async function markRead(id?: string) {
    setPending(true);
    try {
      const response = await fetch(id === undefined ? "/api/authoring/notifications/read-all" : `/api/authoring/notifications/${encodeURIComponent(id)}/read`, {
        method: id === undefined ? "POST" : "PUT",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(messageOf(await response.json().catch(() => null)));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "标记已读失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  if (state === "error") {
    return (
      <section className="nw-authoring-inbox" aria-label="通知">
        <h2>通知</h2>
        <p className="nw-auth-error" role="alert">{error}</p>
      </section>
    );
  }

  const notices = notificationRows({ data: items });

  return (
    <section className="nw-authoring-inbox" aria-label="通知">
      <h2>通知{unreadCount > 0 ? `（${unreadCount} 未读）` : ""}</h2>
      {error !== "" ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {state === "loading" ? <p>载入中…</p> : null}
      {state === "ready" && notices.length === 0 ? <p>{unreadCount > 0 ? "最近没有通知，较早的未读通知可能仍然存在。" : "还没有通知。"}</p> : null}
      {state === "ready" && items.length >= 50 ? <p>这里只显示最近 50 条通知；未读数包含更早的通知。</p> : null}
      {notices.length > 0 ? (
        <ul className="nw-authoring-inbox-list">
          {notices.map(({ item, notice }) => (
            <li className="nw-authoring-inbox-row" key={item.id}>
              <p className={item.readAt === null ? "nw-authoring-inbox-text nw-unread" : "nw-authoring-inbox-text"}>
                {notificationPresentation(notice, "zh-CN").text}{notificationPresentation(notice, "zh-CN").href ? <> <Link href={notificationPresentation(notice, "zh-CN").href!}>查看</Link></> : null}
                <time dateTime={item.createdAt}> {dateLabel(item.createdAt, "zh-CN")}</time>
              </p>
              {item.readAt === null ? (
                <button className="nw-btn" type="button" disabled={pending} onClick={() => void markRead(item.id)}>
                  标记已读
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {unreadCount > 0 ? (
        <button className="nw-btn" type="button" disabled={pending} onClick={() => void markRead()}>
          全部标为已读
        </button>
      ) : null}
    </section>
  );
}
