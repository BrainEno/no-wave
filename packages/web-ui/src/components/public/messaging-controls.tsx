import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigationBlocker } from "@/lib/framework/navigation.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { createMessagingController, type MessagingController } from "@/lib/messaging-intent.ts";
import { createMessagingTransport, MessagingRequestError, type MessagingTarget } from "@/lib/messaging-transport.ts";
import { bindMessagingUnload } from "@/lib/messaging-leave.ts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog.tsx";

type ActorState = { id: string; status: "loading" | "ready" | "failed" };

/** Identity is pinned to this mounted private screen, not re-read behind a pending intent. */
export function useMessagingActor() {
  const [transport] = useState(createMessagingTransport);
  const [actor, setActor] = useState<ActorState>({ id: "", status: "loading" });
  const request = useRef<AbortController | null>(null);
  const pinned = useRef("");
  const load = useCallback(async () => {
    if (pinned.current) return;
    request.current?.abort();
    const next = new AbortController();
    request.current = next;
    setActor({ id: "", status: "loading" });
    try {
      const id = await transport.actor(next.signal);
      if (request.current !== next) return;
      pinned.current = id;
      setActor({ id, status: "ready" });
    } catch (error: unknown) {
      if (request.current !== next || error instanceof MessagingRequestError && error.code === "cancelled") return;
      setActor({ id: "", status: "failed" });
    }
  }, [transport]);
  useEffect(() => {
    void load();
    return () => { const old = request.current; request.current = null; old?.abort(); };
  }, [load]);
  return { ...actor, retry: load };
}

export function MessagingActorNotice({ actor, locale }: { actor: ReturnType<typeof useMessagingActor>; locale: Locale }) {
  const ui = getUi(locale).messages;
  if (actor.status === "ready") return null;
  return actor.status === "failed" ? (
    <p className="nw-m nw-compose-error" role="alert">{ui.accountFailed}{" "}
      <button type="button" className="nw-compose-retry" onClick={() => void actor.retry()}>{ui.accountRetry}</button>
    </p>
  ) : <p className="nw-m nw-compose-hint" role="status">{ui.accountLoading}</p>;
}

export function useMessagingWrite(target: MessagingTarget) {
  const [controller] = useState(() => createMessagingController(target));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
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
