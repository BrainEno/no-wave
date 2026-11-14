import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { dateLabel } from "@/lib/format.ts";
import type { MessagingController } from "@/lib/messaging-intent.ts";
import { MessagingActorNotice, MessagingPendingGuard, useMessagingActor, useMessagingWrite } from "@/components/public/messaging-controls.tsx";
import { SectionHeading } from "@/components/ui/parts.tsx";
import { MarkConversationRead } from "@/components/public/mark-conversation-read.tsx";

/**
 * 私信线程 — one conversation's messages (#198).
 *
 * Four states, and the interesting one is the third:
 *
 *   - **401** — signed out. Sign-in link.
 *   - **404** — no such conversation *or* not a member. The API deliberately
 *     makes these indistinguishable, and so does this view: saying "you are not
 *     part of this" would confirm the conversation exists to anyone holding its
 *     id. It is also not a failure — retrying will not help.
 *   - **403 on the message list** — the API's own asymmetry: the header hides
 *     membership, the message list does not. Rendered as "not found or not
 *     yours" for the reader, because that is what it means to them, without
 *     pretending the API answered 404.
 *   - **failed** — the read broke. Say so, offer a retry.
 *
 * Paging walks *backwards*: the API returns the newest page first and takes a
 * `before` cursor for everything older. So the list renders in the order it
 * arrives (oldest at the top of the page) and "older" prepends.
 *
 * Each attempted reply retains its key and body until it succeeds or the
 * reader explicitly abandons it. A lost response is not proof of failure.
 */

type Message = { id: string; senderId: string; body: string; createdAt: string };

type ThreadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "missing" }
  | { kind: "ready"; messages: Message[]; more: boolean; cursor: string | null }
  | { kind: "failed" };

const PAGE_SIZE = 100;

export function ThreadView({
  locale,
  conversationId,
}: {
  locale: Locale;
  conversationId: string;
}) {
  const ui = getUi(locale).messages;
  const [state, setState] = useState<ThreadState>({ kind: "loading" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const actor = useMessagingActor();
  const viewerId = actor.id;
  const [draft, setDraft] = useState("");
  const { controller: write, snapshot: writeState } = useMessagingWrite({ kind: "reply", conversationId });
  const sending = writeState.busy;
  const problem = writeState.problem;
  const sendError = problem === null ? "none" : problem === "account-changed" || problem === "unauthenticated" ? "signed-out"
    : problem === "invalid" || problem === "missing" ? "invalid" : problem === "changed" || problem === "conflict" || problem === "too-long" ? problem : "failed";
  const generation = useRef(0);

  const load = useCallback(
    async (before: string | null, prepend: boolean) => {
      const mine = ++generation.current;
      if (prepend) setLoadingOlder(true);
      else setState({ kind: "loading" });

      const query = `/api/authoring/inbox/${encodeURIComponent(conversationId)}/messages?limit=${PAGE_SIZE}${
        before === null ? "" : `&before=${encodeURIComponent(before)}`
      }`;
      try {
        const response = await fetch(query, {
          headers: { accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (mine !== generation.current) return;

        if (response.status === 401) {
          setState({ kind: "signed-out" });
          return;
        }
        // 404 and 403 both mean "this is not yours to read". Neither is a
        // transient failure, so neither gets a retry button that would lie.
        if (response.status === 404 || response.status === 403) {
          setState({ kind: "missing" });
          return;
        }
        if (!response.ok) {
          setState({ kind: "failed" });
          return;
        }

        const payload: unknown = await response.json().catch(() => null);
        if (mine !== generation.current) return;
        const page = readMessages(payload);
        if (page === null) {
          setState({ kind: "failed" });
          return;
        }

        setState((previous) => {
          if (prepend && previous.kind === "ready") {
            return { kind: "ready", messages: [...page, ...previous.messages], more: page.length === PAGE_SIZE, cursor: page[0]?.id ?? previous.cursor };
          }
          return { kind: "ready", messages: page, more: page.length === PAGE_SIZE, cursor: page[0]?.id ?? null };
        });
      } catch {
        if (mine === generation.current) setState({ kind: "failed" });
      } finally {
        if (mine === generation.current) setLoadingOlder(false);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    void load(null, false);
    return () => { generation.current += 1; };
  }, [load]);

  const send = useCallback(async () => {
    const receipt = await write.attempt(draft, viewerId);
    if (receipt?.kind !== "reply") return;
    const created = receipt.message;
    setDraft("");
    setState((previous) => {
      if (previous.kind !== "ready" || previous.messages.some((message) => message.id === created.id)) return previous;
      return { ...previous, messages: [...previous.messages, created] };
    });
  }, [write, draft, viewerId]);

  const backHref = `${locale === "zh-CN" ? "" : `/${locale}`}/messages`;

  const composer = (
    <>
      <MessagingActorNotice actor={actor} locale={locale} />
      <form className="nw-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="nw-m nw-compose-label" htmlFor="nw-compose-body">{ui.compose}</label>
        <textarea
          id="nw-compose-body"
          className="nw-compose-box"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); write.dismissProblem(); }}
          placeholder={ui.placeholder}
          rows={3}
          disabled={sending}
        />
        <div className="nw-compose-actions">
          <button type="submit" className="nw-thread-btn" disabled={sending || draft.trim() === "" || !viewerId}>
            {sending ? ui.sending : ui.send}
          </button>
          {sendError === "failed" ? (
            <p className="nw-m nw-compose-error" role="alert">{ui.sendFailed}{" "}
              <button type="button" className="nw-compose-retry" onClick={() => void send()}>{ui.sendRetry}</button>
            </p>
          ) : null}
          {sendError === "too-long" ? <p className="nw-m nw-compose-error" role="alert">{ui.sendTooLong}</p> : null}
          {sendError === "invalid" ? <p className="nw-m nw-compose-error" role="alert">{ui.sendInvalid}</p> : null}
          {sendError === "signed-out" ? (
            <p className="nw-m nw-compose-error" role="alert">{ui.sendSignIn}{" "}
              <Link target="_blank" rel="noopener noreferrer" href={`/sign-in?next=${encodeURIComponent(`${backHref}/${conversationId}`)}`}>
                {getUi(locale).reader.saveSignInAction}
              </Link>
            </p>
          ) : null}
        </div>
        {sendError === "changed" || sendError === "conflict" ? (
          <div className="nw-m nw-compose-error" role="alert">
            <p>{sendError === "changed" ? ui.sendChanged : ui.sendConflict}</p>
            {sendError === "changed" ? (
              <button type="button" className="nw-compose-retry" onClick={() => {
                const original = write.getSnapshot().intent;
                if (original) setDraft(original.value);
                write.dismissProblem();
              }}>{ui.restoreMessage}</button>
            ) : null}
          </div>
        ) : null}
        {writeState.intent && !sending ? <button type="button" className="nw-compose-retry" onClick={() => write.discard()}>{ui.discardPending}</button> : null}
      </form>
    </>
  );

  if (state.kind === "loading") {
    return <main id="top" tabIndex={-1} lang={locale} className="nw-w"><Shell ui={ui} backHref={backHref} locale={locale} controller={write}><p className="nw-m nw-thread-note">{ui.threadLoading}</p></Shell></main>;
  }

  if (state.kind === "signed-out") {
    return (
      <main id="top" tabIndex={-1} lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale} controller={write}>
          <p className="nw-m nw-thread-note">
            {ui.signIn}{" "}
            <Link href={`/sign-in?next=${encodeURIComponent(`${backHref}/${conversationId}`)}`}>
              {getUi(locale).reader.saveSignInAction}
            </Link>
          </p>
        </Shell>
      </main>
    );
  }

  if (state.kind === "missing") {
    return (
      <main id="top" tabIndex={-1} lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale} controller={write}>
          {/* No retry: this is an answer, not a failure. */}
          <p className="nw-m nw-thread-note" role="status">{ui.conversationMissing}</p>
        </Shell>
      </main>
    );
  }

  if (state.kind === "failed") {
    return (
      <main id="top" tabIndex={-1} lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale} controller={write}>
          <div className="nw-thread-note" role="alert">
            <p>{ui.threadFailed}</p>
            <button type="button" className="nw-thread-btn" onClick={() => void load(null, false)}>{ui.retry}</button>
          </div>
        </Shell>
      </main>
    );
  }

  if (state.messages.length === 0) {
    return (
      <main id="top" tabIndex={-1} lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale} controller={write}>
          <p className="nw-m nw-thread-note">{ui.threadEmpty}</p>
          {composer}
        </Shell>
      </main>
    );
  }

  return (
    <main id="top" tabIndex={-1} lang={locale} className="nw-w">
      <Shell ui={ui} backHref={backHref} locale={locale} controller={write}>
        <div className="nw-thread">
          {state.more ? (
            <div className="nw-thread-more">
              <button
                type="button"
                className="nw-thread-btn"
                disabled={loadingOlder}
                onClick={() => void load(state.cursor, true)}
              >
                {loadingOlder ? ui.threadLoading : ui.older}
              </button>
            </div>
          ) : (
            <p className="nw-m nw-thread-end">{ui.oldest}</p>
          )}
          {state.messages.map((message) => (
            <article
              key={message.id}
              className={`nw-msg${message.senderId === viewerId ? " nw-msg-mine" : ""}`}
            >
              <p className="nw-m nw-msg-meta">
                {message.senderId === viewerId ? ui.you : message.senderId} · {dateLabel(message.createdAt, locale)}
              </p>
              <p className="nw-msg-body">{message.body}</p>
            </article>
          ))}
        </div>
        <MarkConversationRead key={conversationId} locale={locale} conversationId={conversationId} viewerId={viewerId} />
        {composer}
      </Shell>
    </main>
  );
}

function Shell({
  ui,
  backHref,
  locale,
  controller,
  children,
}: {
  ui: ReturnType<typeof getUi>["messages"];
  backHref: string;
  locale: Locale;
  controller: MessagingController;
  children: React.ReactNode;
}) {
  return (
    <>
      <SectionHeading zh={ui.title} latin="Conversation" />
      <Link className="nw-m nw-thread-back" href={backHref}>← {ui.back}</Link>
      <div lang={locale}>{children}</div>
      <MessagingPendingGuard controller={controller} locale={locale} />
    </>
  );
}

/**
 * Read a message page.
 *
 * The API returns the newest page in ascending order; a malformed entry is
 * dropped rather than rendered as an empty bubble, and a page that was entirely
 * malformed is a failed read rather than an empty conversation — telling a
 * reader "no messages yet" when the parse broke would be a lie about their
 * correspondence.
 */
function readMessages(payload: unknown): Message[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const messages: Message[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.body !== "string") continue;
    messages.push({
      id: record.id,
      senderId: typeof record.senderId === "string" ? record.senderId : "",
      body: record.body,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    });
  }
  if (data.length > 0 && messages.length === 0) return null;
  return messages;
}
