import { htmlElement } from "./overlay-focus.ts";

type InertLease = { users: number; previous: string | null; applied: string };
const inertLeases = new WeakMap<HTMLElement, InertLease>();

function borrowInert(element: HTMLElement): () => void {
  let lease = inertLeases.get(element);
  if (!lease) {
    const previous = element.getAttribute("inert");
    if (previous === null) element.setAttribute("inert", "");
    lease = { users: 0, previous, applied: element.getAttribute("inert")! };
    inertLeases.set(element, lease);
  }
  lease.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.users !== 0) return;
    inertLeases.delete(element);
    // Do not undo another owner's change, or an inert state present on entry.
    if (element.getAttribute("inert") !== lease.applied) return;
    if (lease.previous === null) element.removeAttribute("inert");
    else element.setAttribute("inert", lease.previous);
  };
}

/** Inert sibling branches, never an ancestor of the dialog itself. */
export function isolateOverlay(panel: HTMLElement): () => void {
  const document = panel.ownerDocument;
  const leased = new Map<HTMLElement, () => void>();
  let finished = false;
  let scheduled = false;
  const reconcile = () => {
    scheduled = false;
    if (finished || !panel.isConnected) return;
    const needed = new Set<HTMLElement>();
    let branch: HTMLElement = panel;
    for (let parent = branch.parentElement; parent; parent = branch.parentElement) {
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== branch && htmlElement(sibling, document) && !["SCRIPT", "STYLE", "LINK", "META"].includes(sibling.tagName)) needed.add(sibling);
      }
      if (parent === document.body) break;
      branch = parent;
    }
    for (const [element, release] of leased) {
      if (!needed.has(element)) { release(); leased.delete(element); }
    }
    for (const element of needed) if (!leased.has(element)) leased.set(element, borrowInert(element));
  };
  reconcile();
  const observer = new MutationObserver(() => {
    if (scheduled || finished) return;
    scheduled = true;
    queueMicrotask(reconcile);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    for (const release of leased.values()) release();
    leased.clear();
  };
}

type StyleLease = { style: CSSStyleDeclaration; property: string; value: string; priority: string; applied: string; appliedPriority: string };
type ScrollLease = { users: number; styles: StyleLease[] };
const scrollLeases = new WeakMap<Document, ScrollLease>();

function borrowStyle(style: CSSStyleDeclaration, property: string, replacement: string): StyleLease {
  const value = style.getPropertyValue(property), priority = style.getPropertyPriority(property);
  style.setProperty(property, replacement);
  const appliedPriority = style.getPropertyPriority(property);
  return { style, property, value, priority, applied: style.getPropertyValue(property), appliedPriority };
}

export function lockOverlayScroll(document: Document): () => void {
  let lease = scrollLeases.get(document);
  if (!lease) {
    const styles: StyleLease[] = [];
    const view = document.defaultView;
    const gutter = Math.max(0, (view?.innerWidth ?? 0) - document.documentElement.clientWidth);
    if (view && gutter > 0) {
      const current = Number.parseFloat(view.getComputedStyle(document.body).paddingInlineEnd) || 0;
      styles.push(borrowStyle(document.body.style, "padding-inline-end", `${current + gutter}px`));
    }
    styles.push(borrowStyle(document.documentElement.style, "overflow", "hidden"));
    styles.push(borrowStyle(document.body.style, "overflow", "hidden"));
    lease = { users: 0, styles };
    scrollLeases.set(document, lease);
  }
  lease.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.users !== 0) return;
    scrollLeases.delete(document);
    for (const entry of [...lease.styles].reverse()) {
      if (entry.style.getPropertyValue(entry.property) !== entry.applied) continue;
      if (entry.style.getPropertyPriority(entry.property) !== entry.appliedPriority) continue;
      if (entry.value) entry.style.setProperty(entry.property, entry.value, entry.priority);
      else entry.style.removeProperty(entry.property);
    }
  };
}
