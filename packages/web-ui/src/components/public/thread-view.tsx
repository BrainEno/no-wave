"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { dateLabel } from "@/lib/format.ts";
import { MESSAGE_BODY_MAX_CHARS } from "@bot-thk/web-http";
import { IDEMPOTENCY_KEY_HEADER, intentForAttempt, type PendingIntent } from "@/lib/idempotency-key.ts";
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
  const [viewerId, setViewerId] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<"none" | "failed" | "invalid" | "conflict" | "changed" | "too-long" | "signed-out">("none");
  const generation = useRef(0);
  const pending = useRef<PendingIntent | null>(null);
  const inFlight = useRef(false);

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
    if (inFlight.current) return;
    const text = draft.trim();
    if (text === "") return;
    if (text.length > MESSAGE_BODY_MAX_CHARS) {
      setSendError("too-long");
      return;
    }

    const payload = JSON.stringify({ body: text });
    let intent: PendingIntent | null;
    try {
      intent = intentForAttempt(pending.current, payload);
    } catch {
      setSendError("failed");
      return;
    }
    if (!intent) {
      setSendError("changed");
      return;
    }
    pending.current = intent;
    inFlight.current = true;
    setSending(true);
    setSendError("none");
    try {
      const response = await fetch(`/api/authoring/inbox/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: intent.key,
        },
        body: intent.payload,
      });
      if (response.status === 401) { setSendError("signed-out"); return; }
      if (response.status === 409) { setSendError("conflict"); return; }
      if (response.status === 400) { setSendError("invalid"); return; }
      if (!response.ok) { setSendError("failed"); return; }

      const created = readSentMessage(await response.json().catch(() => null));
      if (created === null || created.body !== text) {
        // The write may have succeeded even if its response cannot be displayed.
        setSendError("failed");
        return;
      }
      pending.current = null;
      setDraft("");
      setState((previous) => {
        if (previous.kind !== "ready" || previous.messages.some((message) => message.id === created.id)) return previous;
        return { ...previous, messages: [...previous.messages, created] };
      });
    } catch {
      // The request may have been stored even though its response was lost.
      setSendError("failed");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, [conversationId, draft]);

  // Who "you" are — decoration only. A failure leaves messages attributed by id
  // rather than taking the conversation down.
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
        // The conversation is still readable without it.
      }
    })();
    return () => { active = false; };
  }, []);

  const backHref = `${locale === "zh-CN" ? "" : `/${locale}`}/messages`;

  const composer = (
    <form className="nw-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="nw-m nw-compose-label" htmlFor="nw-compose-body">{ui.compose}</label>
      <textarea
        id="nw-compose-body"
        className="nw-compose-box"
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setSendError("none"); }}
        placeholder={ui.placeholder}
        rows={3}
        disabled={sending}
      />
      <div className="nw-compose-actions">
        <button type="submit" className="nw-thread-btn" disabled={sending || draft.trim() === ""}>
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
              if (!pending.current) return;
              const original = JSON.parse(pending.current.payload) as { body: string };
              setDraft(original.body);
              setSendError("none");
            }}>{ui.restoreMessage}</button>
          ) : null}{" "}
          <button type="button" className="nw-compose-retry" onClick={() => { pending.current = null; setSendError("none"); }}>{ui.discardPending}</button>
        </div>
      ) : null}
    </form>
  );

  if (state.kind === "loading") {
    return <main lang={locale} className="nw-w"><Shell ui={ui} backHref={backHref} locale={locale}><p className="nw-m nw-thread-note">{ui.threadLoading}</p></Shell></main>;
  }

  if (state.kind === "signed-out") {
    return (
      <main lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale}>
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
      <main lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale}>
          {/* No retry: this is an answer, not a failure. */}
          <p className="nw-m nw-thread-note" role="status">{ui.conversationMissing}</p>
        </Shell>
      </main>
    );
  }

  if (state.kind === "failed") {
    return (
      <main lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale}>
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
      <main lang={locale} className="nw-w">
        <Shell ui={ui} backHref={backHref} locale={locale}>
          <p className="nw-m nw-thread-note">{ui.threadEmpty}</p>
          {composer}
        </Shell>
      </main>
    );
  }

  return (
    <main lang={locale} className="nw-w">
      <Shell ui={ui} backHref={backHref} locale={locale}>
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
        <MarkConversationRead key={conversationId} locale={locale} conversationId={conversationId} />
        {composer}
      </Shell>
    </main>
  );
}

function Shell({
  ui,
  backHref,
  locale,
  children,
}: {
  ui: ReturnType<typeof getUi>["messages"];
  backHref: string;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <>
      <SectionHeading zh={ui.title} latin="Conversation" />
      <Link className="nw-m nw-thread-back" href={backHref}>← {ui.back}</Link>
      <div lang={locale}>{children}</div>
    </>
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

/** A successful replay is a success too; malformed responses retain the key. */
function readSentMessage(payload: unknown): Message | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.body !== "string" ||
      typeof record.senderId !== "string" || !record.senderId || typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt))) return null;
  return { id: record.id, senderId: record.senderId, body: record.body, createdAt: record.createdAt };
}
