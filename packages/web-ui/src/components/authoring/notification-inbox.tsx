import { useId } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { usePageLocation, useRouter } from "@/lib/framework/navigation.ts";
import type { Locale } from "@/lib/content.ts";
import { useNotifications } from "@/components/chrome/notification-provider.tsx";
import { notificationInboxCopy } from "@/lib/notification-inbox-copy.ts";
import { INBOX_KINDS, INBOX_VIEWS, inboxFilterHref, notificationInboxModel, parseInboxFilters } from "@/lib/notification-inbox-model.ts";
import { readNotificationSelection, notificationSelectionState } from "@/lib/notification-selection.ts";
import { useNotificationSelection } from "@/lib/use-notification-selection.ts";
import { useNotificationInbox } from "@/lib/use-notification-inbox.ts";

export type { NotificationItem, DeletedArticleNotice } from "@/lib/chrome.ts";
export { deletionNoticeText } from "@/lib/chrome.ts";

/** The desk and both localized inbox pages use the same API-authorized store. */
export function NotificationInbox({ locale = "zh-CN", fullPage = false }: { locale?: Locale; fullPage?: boolean }) {
  const { controller, snapshot } = useNotifications(true);
  const location = usePageLocation();
  const router = useRouter();
  const filters = parseInboxFilters(fullPage ? location.search : "");
  const model = notificationInboxModel(snapshot, locale, filters);
  const selected = readNotificationSelection(fullPage ? location.search : "");
  const selectedState = notificationSelectionState(snapshot, model.rows.map(row => row.id), selected);
  const interaction = useNotificationInbox(controller, snapshot, locale, filters, model.rows);
  const jump = useNotificationSelection(controller, snapshot, interaction.root, selected, location.key);
  const copy = notificationInboxCopy(locale);
  const selectionText = selectedState === "waiting" ? copy.selectedWaiting : selectedState === "ready" ? copy.selectedReady : selectedState === "filtered" ? copy.selectedFiltered : selectedState === "older" ? copy.selectedOlder : copy.selectedMissing;
  const labelId = useId();
  const helpId = useId();
  const filterId = useId();
  if (snapshot.session === "signed-out" && !fullPage) return null;
  const unread = snapshot.unread;
  const unreadLabel = unread !== null && unread > 0 ? locale === "en" ? ` (${unread} unread)` : `（${unread} 未读）` : "";
  const signIn = `/sign-in?next=${encodeURIComponent(inboxFilterHref(locale, filters, selected))}`;

  return (
    <section ref={interaction.root} className="nw-authoring-inbox" aria-label={copy.title} lang={locale}
      aria-busy={model.pending} onKeyDown={interaction.onKeyDown} onFocusCapture={interaction.onFocusCapture}>
      <h2 id={labelId}>{copy.title}{unreadLabel}</h2>
      {fullPage ? <>
        <nav className="nw-inbox-filters" aria-label={copy.filters}>
          <span>{copy.statusFilter}</span>
          {INBOX_VIEWS.map(view => <Link key={view} className="nw-btn" scroll={false}
            href={inboxFilterHref(locale, { ...filters, view }, selected)} aria-current={filters.view === view ? "page" : undefined}>{copy[view]}</Link>)}
          <label htmlFor={filterId}>{copy.kindFilter}</label>
          <select id={filterId} className="nw-fld" value={filters.kind} onChange={event => {
            const kind = INBOX_KINDS.find(value => value === event.currentTarget.value);
            if (kind) router.push(inboxFilterHref(locale, { ...filters, kind }, selected));
          }}>
            {INBOX_KINDS.map(kind => <option key={kind} value={kind}>{copy[kind]}</option>)}
          </select>
          {model.filtered ? <Link className="nw-btn" scroll={false} href={inboxFilterHref(locale, { view: "all", kind: "all" }, selected)}>{copy.reset}</Link> : null}
        </nav>
        <p className="nw-m">{copy.loadedOnly}</p>
        <p className="nw-m" id={helpId}>{copy.keyboard} {copy.timezone}</p>
      </> : null}
      {selectedState !== null ? <aside className="nw-inbox-selection" aria-label={locale === "en" ? "Selected notification" : "所选通知"}>
        <p role="status">{selectionText}</p>
        {selectedState === "ready" ? <button className="nw-btn" type="button" onClick={jump}>{copy.jump}</button> : null}
        {selectedState === "filtered" ? <Link className="nw-btn" scroll={false} href={inboxFilterHref(locale, { view: "all", kind: "all" }, selected)}>{copy.showWithoutFilters}</Link> : null}
      </aside> : null}
      {model.problem ? <p className="nw-auth-error" role="alert">{model.problem}</p> : null}
      {!snapshot.loaded && !snapshot.error && snapshot.session !== "signed-out" ? <p>{copy.loading}</p> : null}
      {snapshot.session === "signed-out" ? <p>{copy.signedOut} <Link href={signIn}>{copy.signIn}</Link></p> : null}
      {snapshot.session === "active" ? <button className="nw-btn" type="button" data-inbox-focus-fallback
        disabled={!model.canRefresh} onClick={() => void interaction.run({ kind: "refresh" })}>{copy.refresh}</button> : null}
      {model.emptyText ? <p>{model.emptyText}</p> : null}
      {model.summary ? <p>{model.summary}</p> : null}
      <p className="nw-inbox-feedback" role="status" aria-live="polite" aria-atomic="true">{interaction.announcement}</p>
      {model.rows.length > 0 ? (
        <ul className="nw-authoring-inbox-list" aria-labelledby={labelId} aria-describedby={fullPage ? helpId : undefined}>
          {model.rows.map((row, index) => (
            <li className="nw-authoring-inbox-row" key={row.id} data-notification-id={row.id} tabIndex={fullPage && interaction.activeRowId === row.id ? 0 : -1}
              aria-posinset={index + 1} aria-setsize={snapshot.nextCursor !== null ? -1 : model.rows.length}>
              {fullPage && model.rows[index - 1]?.group !== row.group ? <h3 className="nw-inbox-day">{row.groupLabel}</h3> : null}
              <p className={row.read ? "nw-authoring-inbox-text" : "nw-authoring-inbox-text nw-unread"}>
                {row.text}{row.href ? <> <Link href={row.href}>{copy.view}</Link></> : null}
                <time dateTime={row.dateTime ?? undefined}> {row.date}</time>
              </p>
              {!row.read ? <button className="nw-btn" type="button" disabled={!model.canWrite}
                onClick={() => void interaction.run({ kind: "mark", id: row.id })}>{copy.mark}</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.session === "active" && snapshot.nextCursor ? <button className="nw-btn" type="button"
        disabled={!model.canLoadMore} onClick={() => void interaction.run({ kind: "more" })}>{copy.more}</button> : null}
      {model.remainder ? <p className="nw-m">{model.remainder}</p> : null}
      {snapshot.session === "active" && snapshot.loaded && unread !== null && unread > 0 ? <button className="nw-btn" type="button"
        disabled={!model.canWrite} onClick={() => void interaction.run({ kind: "mark" })}>{copy.markAll}</button> : null}
    </section>
  );
}
