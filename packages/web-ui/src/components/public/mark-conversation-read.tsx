import { useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { useMessagingWrite, MessagingActor } from "@/components/public/messaging-controls.tsx";

/** Mark-all is explicit and account-bound, never silently retried or given a create key. */
export function MarkConversationRead({ locale, conversationId, actor, writer }: {
  locale: Locale; conversationId: string; actor: MessagingActor; writer: ReturnType<typeof useMessagingWrite>;
}) {
  const ui = getUi(locale).messages;
  const viewerId = actor.id;
  const { controller, snapshot } = writer;
  const [marked, setMarked] = useState(false);
  const problem = snapshot.problem;
  const state = snapshot.busy ? "marking" : marked ? "marked" : problem === null ? "idle"
    : problem === "unauthenticated" || problem === "account-changed" ? "signed-out" : problem === "missing" ? "missing" : "unconfirmed";
  const hintId = `nw-mark-read-hint-${conversationId}`;
  const target = `${locale === "zh-CN" ? "" : `/${locale}`}/messages/${conversationId}`;

  async function markRead() {
    if (snapshot.busy) return;
    setMarked(false);
    const receipt = await controller.attempt("", actor.currentId());
    if (receipt?.kind === "read") setMarked(true);
  }

  return (
    <div className="nw-mark-read">
      <p className="nw-m nw-mark-read-hint" id={hintId}>{ui.markReadHint}</p>
      <button type="button" className="nw-thread-btn" aria-describedby={hintId} disabled={state === "marking" || !viewerId} onClick={() => void markRead()}>
        {state === "marking" ? ui.markingRead : ui.markRead}
      </button>
      {state === "marked" ? <p className="nw-m nw-mark-read-status" role="status">{ui.markReadSuccess}</p> : null}
      {state === "unconfirmed" ? <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadFailed}</p> : null}
      {state === "missing" ? <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadMissing}</p> : null}
      {state === "signed-out" ? (
        <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadSignIn}{" "}
          <Link target="_blank" rel="noopener noreferrer" href={`/sign-in?next=${encodeURIComponent(target)}`}>
            {getUi(locale).reader.saveSignInAction}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
