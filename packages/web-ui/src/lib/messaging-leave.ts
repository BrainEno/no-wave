import type { MessagingController } from "./messaging-intent.ts";

/** Always installed while mounted: a same-tick submit/unload must see the live store. */
export function bindMessagingUnload(controller: MessagingController, target: EventTarget): () => void {
  const warn = (event: Event) => {
    if (controller.getSnapshot().intent === null) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  target.addEventListener("beforeunload", warn);
  return () => target.removeEventListener("beforeunload", warn);
}
