import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useNavigationBlocker } from "@/lib/framework/navigation.ts";
import { Link } from "@/lib/framework/link.tsx";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { createMessagingController, type MessagingController } from "@/lib/messaging-intent.ts";
import type { MessagingTarget } from "@/lib/messaging-transport.ts";
import { createMessagingPrivacy, bindMessagingPrivacyWrite, type MessagingPrivacy } from "@/lib/messaging-privacy.ts";
import { bindMessagingPrivacyRecovery } from "@/lib/messaging-privacy-recovery.ts";
import { bindMessagingUnload } from "@/lib/messaging-leave.ts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog.tsx";

/** Reverification may revoke display; it must never silently replace the pinned account. */
export function useMessagingActor() {
  const [privacy] = useState(createMessagingPrivacy);
  const snapshot = useSyncExternalStore(privacy.subscribe, privacy.getSnapshot, privacy.getServerSnapshot);
  useEffect(() => bindMessagingPrivacyRecovery(privacy, {
    window, document, visible: () => document.visibilityState === "visible", flush: flushSync,
  }), [privacy]);
  return { ...snapshot, privacy, retry: privacy.check, currentId: privacy.currentId };
}
export type MessagingActor = ReturnType<typeof useMessagingActor>;

export function MessagingActorNotice({ actor, locale, signInHref = "/sign-in" }: { actor: MessagingActor; locale: Locale; signInHref?: string }) {
  const ui = getUi(locale).messages;
  if (actor.status === "ready") return null;
  if (actor.status === "loading" || actor.status === "hidden") {
    return <p className="nw-m nw-compose-hint" role="status">{actor.status === "hidden" ? ui.accountHidden : ui.accountLoading}</p>;
  }
  const changed = actor.status === "changed";
  const signedOut = actor.status === "signed-out";
  return (
    <p className="nw-m nw-compose-error" role="alert">
      {changed ? ui.accountChanged : signedOut ? ui.signIn : ui.accountFailed}{" "}
      {changed || signedOut ? <Link target="_blank" rel="noopener noreferrer" href={signInHref}>{getUi(locale).reader.saveSignInAction}</Link> : null}{" "}
      <button type="button" className="nw-compose-retry" onClick={() => void actor.retry()}>{ui.accountRetry}</button>
    </p>
  );
}

export function useMessagingWrite(target: MessagingTarget, privacy: MessagingPrivacy) {
  const [controller] = useState(() => createMessagingController(target));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => bindMessagingPrivacyWrite(privacy, controller), [privacy, controller]);
  useEffect(() => () => controller.cancel(), [controller]);
  return { controller, snapshot };
}

/** Exactly one route blocker per composer; read-all remains a separate explicit action. */
export function MessagingPendingGuard({ controller, locale }: { controller: MessagingController; locale: Locale }) {
  const ui = getUi(locale).messages;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const pendingNow = useCallback(() => controller.getSnapshot().intent !== null, [controller]);
  const blocker = useNavigationBlocker(pendingNow);
  useEffect(() => bindMessagingUnload(controller, window), [controller]);
  useEffect(() => {
    // Acknowledgment while a dialog is open releases the key, not the user's
    // navigation choice. Stay here; another intentional click can leave.
    if (snapshot.intent === null && blocker.state === "blocked") blocker.reset();
  }, [snapshot.intent, blocker]);
  return <ConfirmDialog open={blocker.state === "blocked"} title={ui.pendingTitle} description={ui.pendingLeave}
    confirmLabel={ui.leave} cancelLabel={ui.stay} tone="danger"
    onCancel={() => { if (blocker.state === "blocked") blocker.reset(); }}
    onConfirm={() => { if (blocker.state === "blocked") { controller.cancel(); blocker.proceed(); } }} />;
}
