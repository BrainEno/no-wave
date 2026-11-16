export const READER_SCROLL_EVENT = "nw:reader-scroll";
export type ReaderScrollRequest = { element: HTMLElement; fraction: number; line: number; handled: boolean };

export function readerScrollRequest(event: Event): ReaderScrollRequest | null {
  if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return null;
  const request = event.detail as Partial<ReaderScrollRequest>;
  if (!(request.element instanceof HTMLElement) || request.element.ownerDocument !== document || !request.element.isConnected) return null;
  if (!request.element.closest("#nw-article") || typeof request.fraction !== "number" || !Number.isFinite(request.fraction)) return null;
  if (request.fraction < 0 || request.fraction > 1 || typeof request.line !== "number" || !Number.isFinite(request.line) || request.line < 0 || request.line > window.innerHeight) return null;
  return request as ReaderScrollRequest;
}

/** The chrome handles transformed scrolling; reduced-motion/native readers need no animation dependency. */
export function scrollReaderTo(element: HTMLElement, fraction: number, line: number): boolean {
  if (!element.isConnected || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return false;
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return false;
  const request: ReaderScrollRequest = { element, fraction, line, handled: false };
  window.dispatchEvent(new CustomEvent(READER_SCROLL_EVENT, { detail: request }));
  if (!request.handled) window.scrollBy({ top: rect.top + fraction * rect.height - line, behavior: "instant" });
  return true;
}

export function focusReadingBlock(element: HTMLElement): () => void {
  const previous = element.getAttribute("tabindex");
  if (previous === null) element.setAttribute("tabindex", "-1");
  const release = () => {
    element.removeEventListener("blur", release);
    if (previous === null && element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
  };
  element.addEventListener("blur", release, { once: true });
  element.focus({ preventScroll: true });
  return release;
}
