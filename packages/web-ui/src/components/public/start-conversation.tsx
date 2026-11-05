"use client";

import { useRef, useState } from "react";
import { CONVERSATION_ID_PATTERN } from "@bot-thk/web-http";
import { Link } from "@/lib/framework/link.tsx";
import { useRouter } from "@/lib/framework/navigation.ts";
import { IDEMPOTENCY_KEY_HEADER, intentForAttempt, type PendingIntent } from "@/lib/idempotency-key.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";

type StartError = "none" | "failed" | "invalid" | "conflict" | "changed" | "signed-out";

/** Start a one-to-one conversation; the API adds the signed-in user. */
export function StartConversation({ locale, initialRecipient, viewerId }: {
  locale: Locale;
  initialRecipient: string;
  viewerId: string;
}) {
  const ui = getUi(locale).messages;
  const router = useRouter();
  const [recipient, setRecipient] = useState(initialRecipient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StartError>("none");
  const inFlight = useRef(false);
  const pending = useRef<PendingIntent | null>(null);
  const inboxHref = locale === "zh-CN" ? "/messages" : `/${locale}/messages`;

  async function start() {
    if (inFlight.current) return;
    const id = recipient.trim();
    if (!id || id.length > 300 || (viewerId && id === viewerId)) {
      setError("invalid");
      return;
    }
    const payload = JSON.stringify({ participantIds: [id] });
    let intent: PendingIntent | null;
    try {
      intent = intentForAttempt(pending.current, payload);
    } catch {
      setError("failed");
      return;
    }
    if (!intent) {
      setError("changed");
      return;
    }
    pending.current = intent;
    inFlight.current = true;
    setBusy(true);
    setError("none");
    try {
      const response = await fetch("/api/authoring/inbox", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: intent.key },
        body: intent.payload,
      });
      if (response.status === 401) { setError("signed-out"); return; }
      if (response.status === 409) { setError("conflict"); return; }
      if (response.status === 400) { setError("invalid"); return; }
      if (!response.ok) { setError("failed"); return; }
      const data: unknown = await response.json().catch(() => null);
      const conversationId = readConversationId(data);
      if (!conversationId) { setError("failed"); return; }
      pending.current = null;
      router.push(`${inboxHref}/${encodeURIComponent(conversationId)}`);
    } catch {
      // A lost response can still mean the conversation was created.
      setError("failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function restoreRecipient() {
    if (!pending.current) return;
    const payload = JSON.parse(pending.current.payload) as { participantIds: string[] };
    setRecipient(payload.participantIds[0] ?? "");
    setError("none");
  }

  return (
    <form className="nw-compose" onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <h2 className="nw-compose-title">{ui.startTitle}</h2>
      <label className="nw-m nw-compose-label" htmlFor="nw-recipient">{ui.recipientLabel}</label>
      <input id="nw-recipient" className="nw-compose-input" type="text" value={recipient}
        onChange={(event) => { setRecipient(event.target.value); setError("none"); }}
        aria-describedby="nw-recipient-hint" placeholder={ui.recipientPlaceholder} maxLength={300} disabled={busy} />
      <p id="nw-recipient-hint" className="nw-m nw-compose-hint">{ui.recipientHint}</p>
      <div className="nw-compose-actions">
        <button type="submit" className="nw-thread-btn" disabled={busy || !recipient.trim()}>
          {busy ? ui.starting : ui.start}
        </button>
      </div>
      {error === "failed" ? <p className="nw-m nw-compose-error" role="alert">{ui.startFailed}</p> : null}
      {error === "invalid" ? <p className="nw-m nw-compose-error" role="alert">{ui.startInvalid}</p> : null}
      {error === "signed-out" ? (
        <p className="nw-m nw-compose-error" role="alert">{ui.startSignIn}{" "}
          <Link target="_blank" rel="noopener noreferrer" href={`/sign-in?next=${encodeURIComponent(inboxHref)}`}>
            {getUi(locale).reader.saveSignInAction}
          </Link>
        </p>
      ) : null}
      {error === "changed" || error === "conflict" ? (
        <div className="nw-m nw-compose-error" role="alert">
          <p>{error === "changed" ? ui.startChanged : ui.startConflict}</p>
          {error === "changed" ? <button type="button" className="nw-compose-retry" onClick={restoreRecipient}>{ui.restoreRecipient}</button> : null}{" "}
          <button type="button" className="nw-compose-retry" onClick={() => { pending.current = null; setError("none"); }}>{ui.discardPending}</button>
        </div>
      ) : null}
    </form>
  );
}

function readConversationId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id) ? id : null;
}
