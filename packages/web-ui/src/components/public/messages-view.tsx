import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { apiErrorCode } from "@/lib/api-error.ts";
import { EmptyState, SectionHeading } from "@/components/ui/parts.tsx";
import { StartConversation } from "@/components/public/start-conversation.tsx";
import { MessagingActorNotice, useMessagingActor } from "@/components/public/messaging-controls.tsx";

/**
 * 私信收件箱 — the read half of messages (#198).
 *
 * The conversations API has been complete for a while and no Web surface called
 * it, so "私信" existed only for clients that already knew the endpoints.
 *
 * Three states again, and they must not collapse into one another:
 *
 *   - **401** — signed out. A sign-in link, not an empty inbox.
 *   - **empty** — signed in with no conversations. Point at the fact that
 *     conversations start between two readers.
 *   - **failed** — the read broke. Say so and offer a retry.
 *
 * The inbox is per-viewer and the page shell cannot see the access token, so the
 * list is fetched here with the browser's own cookie — the same split the feed
 * page uses, for the same reason.
 */

type ConversationRow = {
  id: string;
  participantIds: string[];
  unreadCount: number;
  lastActivityAt: string;
  lastMessageBody: string;
  lastMessageSenderId: string;
};
type InboxState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; rows: ConversationRow[] }
  | { kind: "failed" };
const INBOX_LIMIT = 50;

export function MessagesView({ locale, initialRecipient = "" }: { locale: Locale; initialRecipient?: string }) {
  const ui = getUi(locale).messages;
  const actor = useMessagingActor();
  const viewerId = actor.id;
  const [loaded, setLoaded] = useState<{ epoch: number; state: InboxState }>({ epoch: -1, state: { kind: "loading" } });
  const state: InboxState = loaded.epoch === actor.epoch ? loaded.state : { kind: "loading" };
  const generation = useRef(0);
  const privacy = actor.privacy;

  const load = useCallback(async () => {
    const lease = privacy.beginRead();
    if (!lease) return;
    const mine = ++generation.current;
    // Store the generation with its payload: a deferred React update cannot
    // relabel an old response with the epoch of a later successful check.
    const setState = (next: InboxState) => setLoaded({ epoch: lease.epoch, state: next });
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/authoring/inbox?limit=${INBOX_LIMIT}`, {
        headers: lease.headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: lease.signal,
      });
      if (mine !== generation.current || !lease.current()) return;
      if (response.status === 401) {
        setState({ kind: "signed-out" });
        lease.fail("unauthenticated");
        return;
      }
      if (response.status === 409) {
        const payload: unknown = await response.json().catch(() => null);
        if (mine !== generation.current || !lease.current()) return;
        if (apiErrorCode(payload) === "ACCOUNT_CHANGED") lease.fail("account-changed");
        else setState({ kind: "failed" });
        return;
      }
      if (!response.ok) {
        setState({ kind: "failed" });
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (mine !== generation.current || !lease.current()) return;
      const rows = readInbox(payload);
      if (rows === null) {
        setState({ kind: "failed" });
        return;
      }
      setState({ kind: "ready", rows });
    } catch {
      if (mine === generation.current && lease.current()) setState({ kind: "failed" });
    } finally { lease.finish(); }
  }, [privacy]);

  useEffect(() => {
    if (actor.readable) void load();
    else setLoaded({ epoch: actor.epoch, state: { kind: "loading" } });
    return () => { generation.current += 1; };
  }, [load, actor.readable, actor.epoch]);

  const signInHref = `/sign-in?next=${encodeURIComponent(locale === "zh-CN" ? "/messages" : `/${locale}/messages`)}`;
  function body() {
    if (!actor.readable) return <MessagingActorNotice actor={actor} locale={locale} signInHref={signInHref} />;
    if (state.kind === "loading") return <p className="nw-m nw-thread-note">{ui.loading}</p>;
    if (state.kind === "signed-out") {
      return <EmptyState title={ui.signIn} body={ui.intro} href={signInHref} action={getUi(locale).reader.saveSignInAction} />;
    }
    if (state.kind === "failed") {
      return <div className="nw-thread-note" role="alert">
        <p>{ui.failed}</p>
        <button type="button" className="nw-thread-btn" onClick={() => void load()}>{ui.retry}</button>
      </div>;
    }
    if (state.rows.length === 0) return <EmptyState title={ui.empty} body={ui.emptyHint} />;
    return <p className="nw-m nw-thread-intro">{ui.intro}</p>;
  }
  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <SectionHeading zh={ui.eyebrow} latin="Inbox" />
      {body()}
      {actor.readable ? <MessagingActorNotice actor={actor} locale={locale} signInHref={signInHref} /> : null}
      {/* Keep the controller and its navigation guard mounted when history is concealed. */}
      <StartConversation locale={locale} initialRecipient={initialRecipient} actor={actor} visible={actor.readable && state.kind === "ready"} />
      {actor.readable && state.kind === "ready" ? (
        <div>
          {state.rows.map((row) => {
            const others = row.participantIds.filter((id) => id !== viewerId);
            return (
              <Link key={row.id} className="nw-cr" href={`${locale === "zh-CN" ? "" : `/${locale}`}/messages/${row.id}`}>
                <span className="nw-m">
                  {row.unreadCount > 0 ? <span className="nw-thread-unread">{ui.unread(row.unreadCount)}</span> : ui.none}
                </span>
                <span className="nw-zh">
                  {others.length > 0 ? others.join("、") : ui.you}
                  <span className="nw-thread-preview"> — {row.lastMessageBody}</span>
                </span>
                <span className="nw-m">{ui.participants(row.participantIds.length)}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </main>
  );
}

/**
 * Read the inbox payload.
 *
 * A conversation without an id is dropped rather than rendered as a row that
 * links nowhere. `participantIds` and `unreadCount` default to safe values: a
 * missing count must not read as "5 unread", and a missing participant list must
 * not crash the row.
 *
 * A page where every entry was malformed is a broken read, not an empty inbox.
 */
function readInbox(payload: unknown): ConversationRow[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const rows: ConversationRow[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const participants = Array.isArray(record.participantIds)
      ? record.participantIds.filter((id): id is string => typeof id === "string")
      : [];
    const lastMessage = typeof record.lastMessage === "object" && record.lastMessage !== null
      ? (record.lastMessage as Record<string, unknown>)
      : {};
    rows.push({
      id: record.id, participantIds: participants,
      unreadCount: typeof record.unreadCount === "number" && record.unreadCount >= 0 ? record.unreadCount : 0,
      lastActivityAt: typeof record.lastActivityAt === "string" ? record.lastActivityAt : "",
      lastMessageBody: typeof lastMessage.body === "string" ? lastMessage.body : "",
      lastMessageSenderId: typeof lastMessage.senderId === "string" ? lastMessage.senderId : "",
    });
  }
  if (data.length > 0 && rows.length === 0) return null;
  return rows;
}
