import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { activateOverlay, type OverlayCloseReason, type OverlayHandle } from "./overlay-lifecycle.ts";
import { focusNavigationDestination, htmlElement, nativeModalAbove, visibleElement } from "./overlay-focus.ts";
import { observePendingFocus } from "./pending-focus-intent.ts";
import { localeOf } from "./locale-navigation.ts";

type ChromeOverlay = "bell" | "menu";
type ChromeLocation = { pathname: string; search: string; hash: string; key: string };
type NavigationIntent = { href: string; origin: HTMLElement; focus: ReturnType<typeof observePendingFocus> };

/** Own the two panels together: there is never a pair of competing focus traps. */
export function useChromeOverlays(location: ChromeLocation) {
  const [active, setActive] = useState<ChromeOverlay | null>(null);
  const bellTrigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const bellPanel = useRef<HTMLDivElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null);
  const owned = useRef<{ kind: ChromeOverlay; handle: OverlayHandle } | null>(null);
  const navigation = useRef<NavigationIntent | null>(null);
  const previousLocation = useRef(location.key);
  const destinationFrame = useRef(0);
  const destinationIntent = useRef<ReturnType<typeof observePendingFocus> | null>(null);
  const samePageFrame = useRef(0);

  const clearNavigation = useCallback(() => {
    navigation.current?.focus.dispose();
    navigation.current = null;
    window.cancelAnimationFrame(destinationFrame.current);
    destinationFrame.current = 0;
    destinationIntent.current?.dispose();
    destinationIntent.current = null;
  }, []);

  const trackNavigation = useCallback((href: string, origin: HTMLElement) => {
    clearNavigation();
    navigation.current = { href, origin, focus: observePendingFocus(origin.ownerDocument, origin) };
  }, [clearNavigation]);

  const onLanguageNavigate = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const anchor = event.currentTarget;
    if (anchor.hasAttribute("download") || anchor.target && anchor.target !== "_self") return;
    const address = new URL(anchor.href, window.location.href);
    if (address.origin !== window.location.origin || localeOf(address.pathname) === localeOf(window.location.pathname)) return;
    trackNavigation(address.pathname + address.search + address.hash, anchor);
  }, [trackNavigation]);

  const dismiss = useCallback((reason: OverlayCloseReason = "close") => {
    if (owned.current) owned.current.handle.dismiss(reason);
    else setActive(null);
  }, []);

  const toggle = useCallback((kind: ChromeOverlay) => {
    clearNavigation();
    if (owned.current?.kind === kind) { owned.current.handle.dismiss("close"); return; }
    owned.current?.handle.dispose();
    setActive(previous => previous === kind ? null : kind);
  }, [clearNavigation]);

  useEffect(() => {
    if (active === null) return;
    const panel = active === "bell" ? bellPanel.current : menuPanel.current;
    const trigger = active === "bell" ? bellTrigger.current : menuTrigger.current;
    if (!panel || !trigger) { setActive(null); return; }
    const handle = activateOverlay({
      panel, trigger, modal: active === "menu",
      fallback: () => Array.from(document.querySelectorAll<HTMLElement>(".nw-pill a, .nw-pill button")).find(visibleElement) ?? document.querySelector("main"),
      onDismiss: reason => {
        if (reason !== "route" && reason !== "navigate") clearNavigation();
        setActive(previous => previous === active ? null : previous);
      },
      onNavigate: (href, origin) => {
        trackNavigation(href, origin);
        const next = new URL(href, window.location.href);
        if (next.pathname !== window.location.pathname || next.search !== window.location.search) return;
        window.cancelAnimationFrame(samePageFrame.current);
        // Native confirmation can block even a same-page link. Let it open
        // first; its Escape/Cancel must return to a still-visible menu item.
        samePageFrame.current = window.requestAnimationFrame(() => {
          if (owned.current?.handle !== handle || nativeModalAbove(panel) || navigation.current?.href !== href) return;
          const mayFocus = navigation.current.focus.mayRepair();
          clearNavigation();
          handle.dismiss("navigate");
          if (mayFocus) focusNavigationDestination(document, next.hash);
        });
      },
    });
    owned.current = { kind: active, handle };
    const resize = () => {
      if (active === "menu" && window.getComputedStyle(trigger).display === "none") handle.dismiss("responsive");
    };
    window.addEventListener("resize", resize);
    resize();
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(samePageFrame.current);
      handle.dispose();
      if (owned.current?.handle === handle) owned.current = null;
    };
  }, [active, clearNavigation, trackNavigation]);

  useEffect(() => {
    if (previousLocation.current === location.key) return;
    previousLocation.current = location.key;
    const intent = navigation.current;
    // Transfer this navigation's observer into the commit-to-paint phase.
    // clearNavigation still cancels an older destination, not the new lease.
    navigation.current = null;
    const focusedAtCommit = document.activeElement;
    const panelWasFocused = focusedAtCommit !== null && (bellPanel.current?.contains(focusedAtCommit) || menuPanel.current?.contains(focusedAtCommit));
    const mayFocus = intent?.focus.mayRepair() ?? false;
    clearNavigation();
    dismiss("route");
    // Back/Forward can close a panel without a click captured inside it. Leaving
    // its focused Close button hidden is not a valid destination either.
    if (!mayFocus && !panelWasFocused) { intent?.focus.dispose(); return; }
    const focus = mayFocus && intent ? intent.focus : observePendingFocus(document, htmlElement(focusedAtCommit, document) ? focusedAtCommit : null);
    if (focus !== intent?.focus) intent?.focus.dispose();
    destinationIntent.current = focus;
    const frame = window.requestAnimationFrame(() => {
      try {
        if (destinationIntent.current !== focus || !focus.mayRepair()) return;
        if (document.querySelector("dialog[open]")) return;
        const current = document.activeElement;
        if (current !== focusedAtCommit && current !== document.body && current !== null) return;
        focusNavigationDestination(document, location.hash);
      } finally {
        focus.dispose();
        if (destinationIntent.current === focus) {
          destinationIntent.current = null;
          if (destinationFrame.current === frame) destinationFrame.current = 0;
        }
      }
    });
    destinationFrame.current = frame;
  }, [location.key, location.pathname, location.search, location.hash, dismiss, clearNavigation]);

  useEffect(() => () => {
    window.cancelAnimationFrame(destinationFrame.current);
    window.cancelAnimationFrame(samePageFrame.current);
    clearNavigation();
    owned.current?.handle.dispose();
    owned.current = null;
  }, [clearNavigation]);

  return { bellOpen: active === "bell", menuOpen: active === "menu", bellTrigger, menuTrigger, bellPanel, menuPanel, toggle, dismiss, onLanguageNavigate };
}
