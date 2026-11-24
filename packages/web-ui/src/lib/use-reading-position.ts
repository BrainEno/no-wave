import { useCallback, useEffect, useRef, useState } from "react";
import { useReadingShelf } from "../components/reader/reading-shelf-provider.tsx";
import { readingShelfCopy, shelfProblemText } from "./reading-shelf-copy.ts";
import { captureReadingPosition, findReadingPosition, readingBlocksIn, type ReadingPosition } from "./reading-position.ts";
import { shelfIdentity, type ShelfRecord } from "./reading-shelf.ts";
import { observePendingFocus } from "./pending-focus-intent.ts";
import { nativeModalAbove } from "./overlay-focus.ts";
import { focusReadingBlock, scrollReaderTo } from "./reader-location.ts";
import type { Locale } from "./content.ts";

const lineInViewport = () => Math.min(160, Math.max(96, window.innerHeight * 0.2));
const editingTarget = (target: EventTarget | null) => target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;

/** Remember only an opted-in edition, after actual reading input; never overwrite on arrival. */
export function useReadingPosition(identity: string, record: ShelfRecord | null, sourceRevision: string, locale: Locale) {
  const { store, actions } = useReadingShelf();
  const consent = record?.tracking ?? null;
  const armed = useRef<string | null>(null);
  const alive = useRef(false);
  const pendingResume = useRef<(() => void) | null>(null);
  const restoreTabIndex = useRef<(() => void) | null>(null);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingResume.current?.();
      restoreTabIndex.current?.();
    };
  }, [identity]);

  const arm = useCallback(() => {
    armed.current = store.getSnapshot().entries.find(entry => shelfIdentity(entry) === identity)?.tracking ?? null;
  }, [identity, store]);

  useEffect(() => {
    if (!consent) return;
    const article = document.getElementById("nw-article");
    if (!article) return;
    let frame = 0;
    let timer = 0;
    let pending: ReadingPosition | null = null;
    const flush = async () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!pending) return;
      const position = pending;
      pending = null;
      const result = await actions.checkpoint(identity, consent, position);
      if (!result.ok && result.code !== "changed" && alive.current) {
        setFeedback(shelfProblemText(result.code, locale));
        setFailed(true);
      }
    };
    const measure = () => {
      frame = 0;
      if (armed.current !== consent || document.hidden || !article.isConnected || nativeModalAbove(article)) return;
      if (document.getSelection()?.isCollapsed === false) return;
      const captured = captureReadingPosition(readingBlocksIn(article).blocks, lineInViewport(), sourceRevision);
      if (!captured) return;
      pending = captured;
      if (!timer) timer = window.setTimeout(() => { void flush(); }, 1000);
    };
    const onScroll = () => { if (armed.current === consent && !frame) frame = window.requestAnimationFrame(measure); };
    const onReadingInput = (event: Event) => {
      if (!event.isTrusted || editingTarget(event.target) || nativeModalAbove(article)) return;
      if (event instanceof KeyboardEvent && (event.isComposing || !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key))) return;
      if (event instanceof WheelEvent && event.ctrlKey) return;
      armed.current = consent;
    };
    const scrollbar = (event: PointerEvent) => {
      if (event.clientX >= document.documentElement.clientWidth) onReadingInput(event);
    };
    const onHide = () => { if (document.hidden) void flush(); };
    window.addEventListener("wheel", onReadingInput, { passive: true, capture: true });
    window.addEventListener("touchmove", onReadingInput, { passive: true, capture: true });
    window.addEventListener("keydown", onReadingInput, true);
    window.addEventListener("pointerdown", scrollbar, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("wheel", onReadingInput, true);
      window.removeEventListener("touchmove", onReadingInput, true);
      window.removeEventListener("keydown", onReadingInput, true);
      window.removeEventListener("pointerdown", scrollbar, true);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [actions, consent, identity, locale, sourceRevision, store]);

  function resume(initiator: HTMLElement) {
    pendingResume.current?.();
    const copy = readingShelfCopy(locale);
    const position = record?.position;
    const article = document.getElementById("nw-article");
    if (!position || !article) return;
    if (window.location.hash) { setFeedback(copy.fragment); setFailed(false); return; }
    const intent = observePendingFocus(document, initiator);
    let frame = 0;
    const cancel = () => { window.cancelAnimationFrame(frame); intent.dispose(); };
    pendingResume.current = cancel;
    setFeedback("");
    setFailed(false);
    frame = window.requestAnimationFrame(() => {
      try {
        if (!store.refresh()) { setFeedback(copy.unavailable); setFailed(true); return; }
        const latest = store.getSnapshot().entries.find(entry => shelfIdentity(entry) === identity);
        if (!alive.current || !article.isConnected || document.getElementById("nw-article") !== article) return;
        if (!intent.mayRepair() || nativeModalAbove(article) || window.location.hash || JSON.stringify(latest?.position) !== JSON.stringify(position)) {
          setFeedback(copy.interrupted);
          return;
        }
        const { blocks, elements } = readingBlocksIn(article);
        const target = findReadingPosition(position, blocks);
        if (target.kind !== "found") {
          setFeedback(target.kind === "ambiguous" ? copy.ambiguousPosition : copy.missingPosition);
          return;
        }
        const element = elements[target.index]!;
        if (!scrollReaderTo(element, position.offset, lineInViewport())) { setFeedback(copy.missingPosition); return; }
        restoreTabIndex.current?.();
        restoreTabIndex.current = focusReadingBlock(element);
        arm();
        setFeedback(position.sourceRevision !== sourceRevision ? copy.changedText : copy.resumed);
      } finally {
        intent.dispose();
        if (pendingResume.current === cancel) pendingResume.current = null;
      }
    });
  }

  return { arm, resume, feedback, failed };
}
