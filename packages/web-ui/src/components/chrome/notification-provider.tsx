import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { hasUsableSession, SESSION_MARKER_COOKIE } from "@bot-thk/web-http";
import { usePathname } from "@/lib/framework/navigation.ts";
import { sessionMarkerFromCookie } from "@/lib/chrome.ts";
import { createNotificationController, type NotificationController } from "@/lib/notification-controller.ts";
import { bindNotificationRecovery } from "@/lib/notification-recovery.ts";

const NotificationContext = createContext<NotificationController | null>(null);

/** An SSR-safe, shell-scoped owner; no private request runs during rendering. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(createNotificationController);
  const pathname = usePathname();
  useEffect(() => bindNotificationRecovery(controller, {
    window, document,
    visible: () => document.visibilityState === "visible",
    hasSessionHint: () => hasUsableSession(sessionMarkerFromCookie(document.cookie, SESSION_MARKER_COOKIE)),
    flush: flushSync,
  }), [controller, pathname]);
  return <NotificationContext.Provider value={controller}>{children}</NotificationContext.Provider>;
}

export function useNotificationActions(): NotificationController {
  const controller = useContext(NotificationContext);
  if (!controller) throw new Error("Notification controls require the site shell.");
  return controller;
}

export function useNotifications(visible: boolean) {
  const controller = useNotificationActions();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => visible ? controller.watchFeed() : undefined, [controller, visible]);
  return { controller, snapshot };
}
