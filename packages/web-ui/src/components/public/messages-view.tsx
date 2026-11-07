import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, SectionHeading } from "@/components/ui/parts.tsx";
import { StartConversation } from "@/components/public/start-conversation.tsx";

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
  const [state, setState] = useState<InboxState>({ kind: "loading" });
  const [viewerId, setViewerId] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/authoring/inbox?limit=${INBOX_LIMIT}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (mine !== generation.current) return;

      if (response.status === 401) {
        setState({ kind: "signed-out" });
        return;
      }
      if (!response.ok) {
        setState({ kind: "failed" });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (mine !== generation.current) return;
      const rows = readInbox(payload);
      if (rows === null) {
        setState({ kind: "failed" });
        return;
      }
      setState({ kind: "ready", rows });
    } catch {
      if (mine === generation.current) setState({ kind: "failed" });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  // Who "you" are. Read separately because it is decoration: a row that cannot
  // be attributed to somebody still renders, it just shows the id it has.
  // A failure here must not take the inbox down with it.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/authoring/session", {
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!active || !response.ok) return;
        const payload: unknown = await response.json().catch(() => null);
        const id = readViewerId(payload);
        if (active && id) setViewerId(id);
      } catch {
        // Not an error worth showing: the inbox is still the inbox.
      }
    })();
    return () => { active = false; };
  }, []);

  const heading = <SectionHeading zh={ui.eyebrow} latin="Inbox" />;

  if (state.kind === "loading") {
    return <main lang={locale} className="nw-w">{heading}<p className="nw-m nw-thread-note">{ui.loading}</p></main>;
  }

  if (state.kind === "signed-out") {
    return (
      <main lang={locale} className="nw-w">
        {heading}
        <EmptyState
          title={ui.signIn}
          body={ui.intro}
          href={`/sign-in?next=${encodeURIComponent(locale === "zh-CN" ? "/messages" : `/${locale}/messages`)}`}
          action={getUi(locale).reader.saveSignInAction}
        />
      </main>
    );
  }

  if (state.kind === "failed") {
    return (
      <main lang={locale} className="nw-w">
        {heading}
        <div className="nw-thread-note" role="alert">
          <p>{ui.failed}</p>
          <button type="button" className="nw-thread-btn" onClick={() => void load()}>{ui.retry}</button>
        </div>
      </main>
    );
  }

  if (state.rows.length === 0) {
    return (
      <main lang={locale} className="nw-w">
        {heading}
        <EmptyState title={ui.empty} body={ui.emptyHint} />
        <StartConversation locale={locale} initialRecipient={initialRecipient} viewerId={viewerId} />
      </main>
    );
  }

  return (
    <main lang={locale} className="nw-w">
      {heading}
      <p className="nw-m nw-thread-intro">{ui.intro}</p>
      <StartConversation locale={locale} initialRecipient={initialRecipient} viewerId={viewerId} />
      <div>
        {state.rows.map((row) => {
          const others = row.participantIds.filter((id) => id !== viewerId);
          return (
            <Link key={row.id} className="nw-cr" href={`${locale === "zh-CN" ? "" : `/${locale}`}/messages/${row.id}`}>
              <span className="nw-m">
                {row.unreadCount > 0 ? (
                  <span className="nw-thread-unread">{ui.unread(row.unreadCount)}</span>
                ) : (
                  ui.none
                )}
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
    </main>
  );
}

/** The signed-in account's id, or `""` when the payload does not carry one. */
function readViewerId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return "";
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
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
      id: record.id,
      participantIds: participants,
      unreadCount: typeof record.unreadCount === "number" && record.unreadCount >= 0 ? record.unreadCount : 0,
      lastActivityAt: typeof record.lastActivityAt === "string" ? record.lastActivityAt : "",
      lastMessageBody: typeof lastMessage.body === "string" ? lastMessage.body : "",
      lastMessageSenderId: typeof lastMessage.senderId === "string" ? lastMessage.senderId : "",
    });
  }
  if (data.length > 0 && rows.length === 0) return null;
  return rows;
}
