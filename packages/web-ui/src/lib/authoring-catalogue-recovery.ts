type CatalogueRecovery = { verifyAccount(): Promise<void>; connect(): Promise<void> };
type CatalogueRecoveryEnvironment = {
  window: EventTarget; document: EventTarget; visible(): boolean; suspend(): void;
  flush(callback: () => void): void;
};

/** No polling, writes or persisted query: ordinary focus probes identity, BFCache hides private state before capture. */
export function bindCatalogueRecovery(controller: CatalogueRecovery, environment: CatalogueRecoveryEnvironment): () => void {
  let pendingProbe: Promise<void> | null = null;
  let suspended = false;
  const verify = () => {
    if (suspended || !environment.visible() || pendingProbe) return;
    const probe = controller.verifyAccount();
    pendingProbe = probe;
    const complete = () => { if (pendingProbe === probe) pendingProbe = null; };
    void probe.then(complete, complete);
  };
  const hide = () => {
    suspended = true;
    pendingProbe = null;
    environment.flush(environment.suspend);
  };
  const show = (event: Event) => {
    suspended = false;
    if ("persisted" in event && event.persisted === true) {
      environment.flush(environment.suspend);
      void controller.connect();
    }
  };
  environment.window.addEventListener("focus", verify);
  environment.window.addEventListener("online", verify);
  environment.window.addEventListener("pagehide", hide);
  environment.window.addEventListener("pageshow", show);
  environment.document.addEventListener("visibilitychange", verify);
  return () => {
    environment.window.removeEventListener("focus", verify);
    environment.window.removeEventListener("online", verify);
    environment.window.removeEventListener("pagehide", hide);
    environment.window.removeEventListener("pageshow", show);
    environment.document.removeEventListener("visibilitychange", verify);
  };
}
