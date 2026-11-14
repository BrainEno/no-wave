import { useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { useRouter } from "@/lib/framework/navigation.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { MessagingPendingGuard, useMessagingWrite } from "@/components/public/messaging-controls.tsx";

/** Start a one-to-one conversation; the API still authenticates and adds the actor. */
export function StartConversation({ locale, initialRecipient, viewerId }: {
  locale: Locale;
  initialRecipient: string;
  viewerId: string;
}) {
  const ui = getUi(locale).messages;
  const router = useRouter();
  const [recipient, setRecipient] = useState(initialRecipient);
  const { controller, snapshot } = useMessagingWrite({ kind: "start" });
  const busy = snapshot.busy;
  const problem = snapshot.problem;
  const error = problem === null ? "none" : problem === "account-changed" || problem === "unauthenticated" ? "signed-out"
    : problem === "invalid" || problem === "missing" ? "invalid" : problem === "changed" || problem === "conflict" ? problem : "failed";
  const inboxHref = locale === "zh-CN" ? "/messages" : `/${locale}/messages`;

  async function start() {
    const receipt = await controller.attempt(recipient, viewerId);
    if (receipt?.kind === "start") router.push(`${inboxHref}/${encodeURIComponent(receipt.conversationId)}`);
  }

  return (
    <>
      <form className="nw-compose" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <h2 className="nw-compose-title">{ui.startTitle}</h2>
        <label className="nw-m nw-compose-label" htmlFor="nw-recipient">{ui.recipientLabel}</label>
        <input id="nw-recipient" className="nw-compose-input" type="text" value={recipient}
          onChange={(event) => { setRecipient(event.target.value); controller.dismissProblem(); }}
          aria-describedby="nw-recipient-hint" placeholder={ui.recipientPlaceholder} maxLength={300} disabled={busy} />
        <p id="nw-recipient-hint" className="nw-m nw-compose-hint">{ui.recipientHint}</p>
        <div className="nw-compose-actions">
          <button type="submit" className="nw-thread-btn" disabled={busy || !recipient.trim() || !viewerId}>
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
            {error === "changed" ? <button type="button" className="nw-compose-retry" onClick={() => {
              const original = controller.getSnapshot().intent;
              if (original) setRecipient(original.value);
              controller.dismissProblem();
            }}>{ui.restoreRecipient}</button> : null}
          </div>
        ) : null}
        {snapshot.intent && !busy ? <button type="button" className="nw-compose-retry" onClick={() => controller.discard()}>{ui.discardPending}</button> : null}
      </form>
      <MessagingPendingGuard controller={controller} locale={locale} />
    </>
  );
}
