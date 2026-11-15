import { tabStops, visibleElement } from "./overlay-focus.ts";

type Bookmark = { element: HTMLElement; key: string | null; rowId: string | null; action: string | null;
  rowOrder: string[]; rowIndex: number; tabIndex: number };

/** A live list is not an array of fixed Tab indices: rows can move or vanish. */
export function createOverlayFocusMemory(panel: HTMLElement) {
  let bookmark: Bookmark | null = null;
  const rows = () => Array.from(panel.querySelectorAll<HTMLElement>("[data-notification-id]")).filter(visibleElement);
  const owned = (element: HTMLElement): boolean => panel.contains(element) && visibleElement(element);

  function remember(element: HTMLElement): void {
    if (!panel.contains(element)) return;
    const row = element.closest<HTMLElement>("[data-notification-id]");
    const ordered = rows();
    bookmark = {
      element, key: element.getAttribute("data-overlay-focus-key"),
      rowId: row && panel.contains(row) ? row.dataset.notificationId ?? null : null,
      action: element.getAttribute("data-overlay-action"),
      rowOrder: ordered.map(item => item.dataset.notificationId!),
      rowIndex: row ? ordered.indexOf(row) : -1,
      tabIndex: Math.max(0, tabStops(panel).indexOf(element)),
    };
  }

  function rowTarget(row: HTMLElement, action: string | null): HTMLElement {
    // Pending writes disable/remove their own control. Retain the readable row
    // rather than jumping to an unrelated notification at the same numeric slot.
    if (panel.getAttribute("aria-busy") === "true") return row;
    if (action !== null) {
      const sameAction = Array.from(row.querySelectorAll<HTMLElement>("[data-overlay-action]"))
        .find(element => element.getAttribute("data-overlay-action") === action && owned(element));
      if (sameAction) return sameAction;
    }
    return tabStops(row)[0] ?? row;
  }

  function candidate(): HTMLElement | null {
    if (bookmark === null) return panel.querySelector<HTMLElement>("[data-overlay-initial-focus]") ?? tabStops(panel)[0] ?? null;
    if (owned(bookmark.element)) return bookmark.element;
    if (bookmark.key !== null) {
      const sameKey = Array.from(panel.querySelectorAll<HTMLElement>("[data-overlay-focus-key]"))
        .find(element => element.getAttribute("data-overlay-focus-key") === bookmark!.key && owned(element));
      if (sameKey) return sameKey;
    }
    if (bookmark.rowId !== null) {
      const current = rows();
      const byId = new Map(current.map(row => [row.dataset.notificationId!, row]));
      const sameRow = byId.get(bookmark.rowId);
      if (sameRow) return rowTarget(sameRow, bookmark.action);
      const position = bookmark.rowOrder.indexOf(bookmark.rowId);
      for (let index = position + 1; index < bookmark.rowOrder.length; index++) {
        const next = byId.get(bookmark.rowOrder[index]!);
        if (next) return rowTarget(next, null);
      }
      for (let index = position - 1; index >= 0; index--) {
        const previous = byId.get(bookmark.rowOrder[index]!);
        if (previous) return rowTarget(previous, null);
      }
      // A full refresh may replace every row. Bound the old position rather
      // than allowing a stale index to escape the panel or a previous account.
      const replacement = current[Math.max(0, Math.min(bookmark.rowIndex, current.length - 1))];
      if (replacement) return rowTarget(replacement, null);
    }
    const stops = tabStops(panel);
    return stops[Math.min(bookmark.tabIndex, stops.length - 1)] ?? null;
  }

  return {
    remember, candidate,
    lost: () => bookmark !== null && !owned(bookmark.element),
    owns: (element: Element | null) => element !== null && bookmark?.element === element,
    clear() { bookmark = null; },
  };
}
