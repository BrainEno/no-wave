import { Link } from "@/lib/framework/link.tsx";
import { dateLabel } from "@/lib/format.ts";
import { notificationPresentation } from "@/lib/chrome.ts";
import { notificationEntries } from "@/lib/notification-controller.ts";
import { notificationProblemText, notificationSummary } from "@/lib/notification-feedback.ts";
import { useNotifications } from "@/components/chrome/notification-provider.tsx";

export type { NotificationItem, DeletedArticleNotice } from "@/lib/chrome.ts";
export { deletionNoticeText } from "@/lib/chrome.ts";

/** The desk and bell observe the same shell-scoped, API-authorized inbox. */
export function NotificationInbox() {
  const { controller, snapshot } = useNotifications(true);
  if (snapshot.session === "signed-out") return null;
  const pending = snapshot.pending !== null;
  const notices = notificationEntries(snapshot);
  const summary = notificationSummary(snapshot, "zh-CN");
  return (
    <section className="nw-authoring-inbox" aria-label="通知" aria-busy={pending}>
      <h2>通知{snapshot.unread !== null && snapshot.unread > 0 ? `（${snapshot.unread} 未读）` : ""}</h2>
      {snapshot.error ? <p className="nw-auth-error" role="alert">{notificationProblemText(snapshot.error, "zh-CN")}</p> : null}
      {!snapshot.loaded && !snapshot.error ? <p>载入中…</p> : null}
      {snapshot.session === "active" ? <button className="nw-btn" type="button" disabled={pending} onClick={() => void controller.refresh()}>刷新通知</button> : null}
      {snapshot.loaded && notices.length === 0 ? <p>{snapshot.unread !== null && snapshot.unread > 0 ? "尚有未读通知，请刷新以取得最新列表。" : "还没有通知。"}</p> : null}
      {summary ? <p>{summary}</p> : null}
      {notices.length > 0 ? (
        <ul className="nw-authoring-inbox-list">
          {notices.map(({ item, notice, read }) => {
            const view = notificationPresentation(notice, "zh-CN");
            return (
              <li className="nw-authoring-inbox-row" key={item.id}>
                <p className={read ? "nw-authoring-inbox-text" : "nw-authoring-inbox-text nw-unread"}>
                  {view.text}{view.href ? <> <Link href={view.href}>查看</Link></> : null}
                  <time dateTime={item.createdAt}> {dateLabel(item.createdAt, "zh-CN")}</time>
                </p>
                {!read ? <button className="nw-btn" type="button" disabled={pending} onClick={() => void controller.markRead(item.id)}>标记已读</button> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {snapshot.nextCursor ? <button className="nw-btn" type="button" disabled={pending} onClick={() => void controller.loadMore()}>加载更多通知</button> : null}
      {snapshot.unread !== null && snapshot.unread > 0 ? <button className="nw-btn" type="button" disabled={pending} onClick={() => void controller.markRead()}>全部标为已读</button> : null}
    </section>
  );
}
