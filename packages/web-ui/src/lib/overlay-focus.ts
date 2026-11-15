const CANDIDATES = [
  "a[href]", "area[href]", "button", "input:not([type=hidden])", "select", "textarea",
  "summary", "iframe", "[tabindex]", '[contenteditable="true"]', "audio[controls]", "video[controls]",
].join(",");

export function htmlElement(node: unknown, document: Document): node is HTMLElement {
  const Constructor = document.defaultView?.HTMLElement;
  return Constructor !== undefined && node instanceof Constructor;
}

export function visibleElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && element.getClientRects().length > 0;
}

/** Use native disabled/fieldset/visibility semantics, not a stale selector list. */
export function tabStops(container: HTMLElement): HTMLElement[] {
  const document = container.ownerDocument;
  const eligible = Array.from(container.querySelectorAll(CANDIDATES)).filter((element): element is HTMLElement =>
    htmlElement(element, document) && element.tabIndex >= 0 && visibleElement(element));
  const radioSelected = (element: HTMLElement): boolean => {
    if (element.tagName !== "INPUT") return true;
    const radio = element as HTMLInputElement;
    if (radio.type !== "radio" || !radio.name) return true;
    const group = eligible.filter((candidate): candidate is HTMLInputElement => candidate.tagName === "INPUT" &&
      (candidate as HTMLInputElement).type === "radio" && (candidate as HTMLInputElement).name === radio.name &&
      (candidate as HTMLInputElement).form === radio.form);
    return (group.find(candidate => candidate.checked) ?? group[0]) === radio;
  };
  return eligible.filter(radioSelected).map((element, order) => ({ element, order })).sort((a, b) => {
    const aIndex = a.element.tabIndex > 0 ? a.element.tabIndex : Infinity;
    const bIndex = b.element.tabIndex > 0 ? b.element.tabIndex : Infinity;
    return aIndex === bIndex ? a.order - b.order : aIndex - bIndex;
  }).map(item => item.element);
}

export function focusElement(element: HTMLElement | null | undefined, reveal = false): boolean {
  if (!element || !visibleElement(element)) return false;
  try {
    element.focus({ preventScroll: true });
    if (element.ownerDocument.activeElement !== element) return false;
    if (reveal) element.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  } catch { return false; }
}

export function eventWithin(event: Event, element: HTMLElement): boolean {
  return event.composedPath().includes(element) || event.target instanceof Node && element.contains(event.target);
}

export function nativeModalAbove(panel: HTMLElement): boolean {
  let dialogs: NodeListOf<Element>;
  try { dialogs = panel.ownerDocument.querySelectorAll("dialog:modal"); }
  catch { dialogs = panel.ownerDocument.querySelectorAll("dialog[open]"); }
  return Array.from(dialogs).some(dialog => dialog !== panel);
}

export function tabBoundary(panel: HTMLElement, current: Element | null, backward: boolean): HTMLElement | null {
  const stops = tabStops(panel);
  if (stops.length === 0) return panel;
  const index = stops.findIndex(element => element === current);
  if (index < 0) {
    // A temporarily focused row/landmark has tabindex=-1. Its next native Tab
    // stop can still be inside the panel; it is not automatically an exit.
    if (current && panel.contains(current) && current !== panel) {
      const direction = backward ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
      if (stops.some(element => element.tabIndex === 0 && (current.compareDocumentPosition(element) & direction) !== 0)) return null;
    }
    return backward ? stops.at(-1)! : stops[0]!;
  }
  if (backward && index === 0) return stops.at(-1)!;
  if (!backward && index === stops.length - 1) return stops[0]!;
  return null;
}

/** The non-modal bell leaves, rather than traps, the document's Tab sequence. */
export function outsideTabNeighbor(panel: HTMLElement, backward: boolean): HTMLElement | null {
  const stops = tabStops(panel.ownerDocument.body);
  const positions = stops.map((element, index) => panel.contains(element) ? index : -1).filter(index => index >= 0);
  if (positions.length === 0) return null;
  const start = backward ? positions[0]! - 1 : positions.at(-1)! + 1;
  for (let index = start; index >= 0 && index < stops.length; index += backward ? -1 : 1) {
    if (!panel.contains(stops[index]!)) return stops[index]!;
  }
  return null;
}

/** A temporary focus target must not leave a new sequential Tab stop behind. */
export function focusLandmark(element: HTMLElement): boolean {
  const previous = element.getAttribute("tabindex");
  if (previous === null) element.setAttribute("tabindex", "-1");
  if (!focusElement(element)) {
    if (previous === null && element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
    return false;
  }
  if (previous === null) element.addEventListener("blur", () => {
    if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
  }, { once: true });
  return true;
}

export function focusNavigationDestination(document: Document, hash = ""): boolean {
  let identifier = "";
  try { identifier = decodeURIComponent(hash.replace(/^#/, "")); } catch { /* Malformed fragments fall back to main. */ }
  const target = identifier ? document.getElementById(identifier) : null;
  const main = target ?? document.querySelector("main");
  if (main && htmlElement(main, document) && focusLandmark(main)) return true;
  const heading = document.querySelector("h1");
  return heading !== null && htmlElement(heading, document) && focusLandmark(heading);
}
