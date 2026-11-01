"use client";

import { useCallback, useEffect, useState } from "react";

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

/** One notice, as the REST API serializes it. */
export type NotificationItem = {
  id: string;
  eventKey: string;
  payload: string;
  createdAt: string;
  readAt: string | null;
};

/** The only notice the API writes today: a work's tombstone, and its date. */
export type DeletedArticleNotice = { type: "article.deleted"; articleId: string; purgesAt: string };

function isNotificationItem(value: unknown): value is NotificationItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<NotificationItem>;
  return typeof item.id === "string" && typeof item.eventKey === "string" &&
    typeof item.payload === "string" && typeof item.createdAt === "string" &&
    (item.readAt === null || typeof item.readAt === "string");
}

/**
 * The payload is a JSON string on the wire (the serializer matches the GraphQL
 * notification contract), so it is parsed here — and a notice whose shape this
 * screen does not know is dropped rather than shown as a blank row, which keeps
 * the inbox rendering after the API learns a new kind of notice.
 */
function parseDeletedArticleNotice(payload: string): DeletedArticleNotice | null {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const notice = parsed as Partial<DeletedArticleNotice>;
  if (notice.type !== "article.deleted") return null;
  if (typeof notice.articleId !== "string" || typeof notice.purgesAt !== "string") return null;
  return { type: "article.deleted", articleId: notice.articleId, purgesAt: notice.purgesAt };
}

/** The calendar day a timestamp falls on, for a date the reader can act on. */
function calendarDay(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Whole days from now until a timestamp, floored at zero. */
function daysFromNow(timestamp: string): number | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.ceil((parsed.getTime() - Date.now()) / 86_400_000));
}

/**
 * The sentence a reader gets about a deletion. The title is deliberately
 * absent — see the note at the top of this file — so the id is the only thing
 * that could identify the work, and after the sweep runs there is nothing left
 * to name even if the payload carried one.
 */
export function deletionNoticeText(notice: DeletedArticleNotice): string {
  const day = calendarDay(notice.purgesAt);
  const days = daysFromNow(notice.purgesAt);
  if (day === null) return "你评论过的一篇作品已被作者删除，你的评论会随作品一起清除。";
  if (days === null || days === 0) return `你评论过的一篇作品已被作者删除，你的评论会在 ${day} 随作品一起清除。`;
  return `你评论过的一篇作品已被作者删除，你的评论会在 ${day}（约 ${days} 天后）随作品一起清除。`;
}

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
    const response = await fetch("/api/authoring/notifications", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    // No session means no inbox; the desk shows its own sign-in panel for that,
    // so this section simply renders nothing rather than a second explanation.
    if (response.status === 401) { setState("ready"); setItems([]); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("通知响应格式不正确。");
    setItems(data.filter(isNotificationItem));
    setUnreadCount(data.filter((item): boolean => isNotificationItem(item) && item.readAt === null).length);
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
      const response = await fetch(id === undefined ? "/api/authoring/notifications/read-all" : `/api/authoring/notifications/${id}/read`, {
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

  const notices = items
    .map((item) => ({ item, notice: parseDeletedArticleNotice(item.payload) }))
    .filter((entry): entry is { item: NotificationItem; notice: DeletedArticleNotice } => entry.notice !== null);

  return (
    <section className="nw-authoring-inbox" aria-label="通知">
      <h2>通知{unreadCount > 0 ? `（${unreadCount} 未读）` : ""}</h2>
      {state === "loading" ? <p>载入中…</p> : null}
      {state === "ready" && notices.length === 0 ? <p>还没有通知。</p> : null}
      {notices.length > 0 ? (
        <ul className="nw-authoring-inbox-list">
          {notices.map(({ item, notice }) => (
            <li className="nw-authoring-inbox-row" key={item.id}>
              <p className={item.readAt === null ? "nw-authoring-inbox-text nw-unread" : "nw-authoring-inbox-text"}>
                {deletionNoticeText(notice)}
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
