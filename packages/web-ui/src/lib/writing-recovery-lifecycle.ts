import type { WritingRecoveryController } from "./writing-recovery-controller.ts";
import type { WritingRecoveryBoundary } from "./writing-recovery-boundary.ts";

export type RecoveryLifecycleEnvironment = {
  window: EventTarget;
  document: EventTarget;
  visible(): boolean;
  flush?(work: () => void): void;
};

/** Event-driven identity rechecks are reads only, not a request replay loop.
 * Cached DOM is removed synchronously at hidden/bfcache/account boundaries. */
export function bindWritingRecovery(
  controller: Pick<
    WritingRecoveryController,
    "connect" | "suspend" | "invalidate"
  >,
  actor: string,
  source: string,
  boundary: Pick<WritingRecoveryBoundary, "subscribe">,
  environment: RecoveryLifecycleEnvironment,
): () => void {
  let stopped = false,
    scheduled = false,
    hidden = false;
  const visible = () => {
    try {
      return environment.visible();
    } catch {
      return false;
    }
  };
  const hide = (synchronous = true) => {
    const work = () => {
      controller.suspend();
    };
    if (synchronous && environment.flush) environment.flush(work);
    else work();
  };
  const recover = (synchronous = true) => {
    hide(synchronous);
    if (stopped || scheduled || hidden || !visible()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped && !hidden && visible())
        void controller.connect(actor, "lifecycle");
    });
  };
  const online = () => recover();
  const resume = () => {
    hidden = false;
    recover();
  };
  const visibility = () => {
    hidden = !visible();
    recover();
  };
  const pagehide = () => {
    hidden = true;
    hide();
  };
  const pageshow = (event: Event) => {
    if (hidden || ("persisted" in event && event.persisted === true)) resume();
  };
  const stopBoundary = boundary.subscribe((origin) => {
    if (origin === source) return;
    const work = () => {
      controller.invalidate();
    };
    if (environment.flush) environment.flush(work);
    else work();
  });
  environment.window.addEventListener("focus", resume);
  environment.window.addEventListener("online", online);
  environment.window.addEventListener("pageshow", pageshow);
  environment.window.addEventListener("pagehide", pagehide);
  environment.document.addEventListener("visibilitychange", visibility);
  recover(false);
  return () => {
    stopped = true;
    stopBoundary();
    environment.window.removeEventListener("focus", resume);
    environment.window.removeEventListener("online", online);
    environment.window.removeEventListener("pageshow", pageshow);
    environment.window.removeEventListener("pagehide", pagehide);
    environment.document.removeEventListener("visibilitychange", visibility);
    hide(false);
  };
}
