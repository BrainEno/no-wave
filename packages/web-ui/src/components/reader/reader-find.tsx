import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Locale } from "@/lib/content.ts";
import { findInReadingBlocks, nextReadingMatch, readingFindElements, readingFindText, readingMatchRange, type ReadingFindResult } from "@/lib/reader-find.ts";
import { readerFindCopy } from "@/lib/reader-find-copy.ts";
import { observePendingFocus } from "@/lib/pending-focus-intent.ts";
import { nativeModalAbove } from "@/lib/overlay-focus.ts";
import { focusReadingBlock, scrollReaderTo } from "@/lib/reader-location.ts";

const EMPTY: ReadingFindResult = { matches: [], moreMatches: false, limitedText: false, invalidQuery: false, unavailable: false };
const ALL_PAINT = "nw-reader-find";
const ACTIVE_PAINT = "nw-reader-find-current";
type HighlightRegistry = { get(name: string): unknown; set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCapability = { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: HighlightRegistry } };

export function ReaderFind({ locale, edition }: { locale: Locale; edition: string }) {
  const copy = readerFindCopy(locale);
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [foldWidth, setFoldWidth] = useState(true);
  const [result, setResult] = useState(EMPTY);
  const [readyKey, setReadyKey] = useState("");
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [paintSupported, setPaintSupported] = useState(true);
  const [feedback, setFeedback] = useState("");
  const pending = useRef<(() => void) | null>(null);
  const releaseFocus = useRef<(() => void) | null>(null);
  const sourceElements = useRef<HTMLElement[]>([]);
  const searchKey = JSON.stringify([edition, query, caseSensitive, foldWidth]);
  const currentSearch = useRef(searchKey);
  currentSearch.current = searchKey;
  const ready = readyKey === searchKey && !busy;
  const current = result.matches[active];

  useEffect(() => () => { pending.current?.(); releaseFocus.current?.(); }, [edition]);

  useEffect(() => {
    if (!open) return;
    const article = document.getElementById("nw-article");
    if (!article) return;
    let timer = 0;
    let disposed = false;
    const search = () => {
      window.clearTimeout(timer);
      setBusy(true);
      setReadyKey("");
      timer = window.setTimeout(() => {
        if (disposed || !article.isConnected) return;
        const elements = readingFindElements(article);
        const blocks = elements.map(element => ({ id: element.dataset.block ?? "", text: readingFindText(element) }));
        const found = findInReadingBlocks(blocks, query, { caseSensitive, foldWidth });
        if (disposed || currentSearch.current !== searchKey) return;
        sourceElements.current = elements;
        setResult(found);
        setActive(-1);
        setFeedback("");
        setReadyKey(searchKey);
        setBusy(false);
      }, 160);
    };
    search();
    const observer = new MutationObserver(search);
    observer.observe(article, { childList: true, characterData: true, subtree: true });
    return () => { disposed = true; window.clearTimeout(timer); observer.disconnect(); };
  }, [caseSensitive, foldWidth, open, query, searchKey]);

  useEffect(() => {
    if (!open || !ready || !query.trim()) return;
    const capability = window as unknown as HighlightCapability;
    const registry = capability.CSS?.highlights;
    const Constructor = capability.Highlight;
    setPaintSupported(Boolean(registry && Constructor));
    if (!registry || !Constructor) return;
    const ranges = result.matches.map(match => {
      const element = sourceElements.current[match.blockIndex];
      return element ? readingMatchRange(element, match) : null;
    });
    const all = new Constructor(...ranges.filter((range): range is Range => range !== null));
    const currentRange = ranges[active];
    const selected = new Constructor(...(currentRange ? [currentRange] : []));
    const previousAll = registry.get(ALL_PAINT), previousActive = registry.get(ACTIVE_PAINT);
    registry.set(ALL_PAINT, all);
    registry.set(ACTIVE_PAINT, selected);
    return () => {
      for (const [name, owned, previous] of [[ALL_PAINT, all, previousAll], [ACTIVE_PAINT, selected, previousActive]] as const) {
        if (registry.get(name) !== owned) continue;
        if (previous === undefined) registry.delete(name);
        else registry.set(name, previous);
      }
    };
  }, [active, open, query, ready, result]);

  function toggle(initiator: HTMLElement) {
    pending.current?.();
    if (open) { close(); return; }
    setOpen(true);
    const intent = observePendingFocus(document, initiator);
    const frame = window.requestAnimationFrame(() => {
      try { if (intent.mayRepair() && input.current?.isConnected) input.current.focus(); }
      finally { intent.dispose(); pending.current = null; }
    });
    pending.current = () => { window.cancelAnimationFrame(frame); intent.dispose(); };
  }

  const close = useCallback((returnFocus = true) => {
    pending.current?.();
    pending.current = null;
    composing.current = false;
    setOpen(false);
    setFeedback("");
    setReadyKey("");
    if (returnFocus && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, []);

  const locate = useCallback((direction: -1 | 1, initiator: HTMLElement) => {
    if (!ready || composing.current) return;
    const index = nextReadingMatch(active, direction, result.matches.length);
    const match = result.matches[index];
    if (!match) return;
    pending.current?.();
    const expected = searchKey;
    const intent = observePendingFocus(document, initiator);
    let frame = 0;
    const cancel = () => { window.cancelAnimationFrame(frame); intent.dispose(); };
    pending.current = cancel;
    setActive(index);
    frame = window.requestAnimationFrame(() => {
      try {
        const element = sourceElements.current[match.blockIndex];
        const article = document.getElementById("nw-article");
        if (currentSearch.current !== expected || !element?.isConnected || !article?.contains(element)) return;
        if (!intent.mayRepair() || nativeModalAbove(article)) { setFeedback(copy.interrupted); return; }
        const range = readingMatchRange(element, match);
        if (!range) { setFeedback(copy.moved); return; }
        const block = element.getBoundingClientRect(), box = range.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (box.top - block.top) / Math.max(1, block.height)));
        if (!scrollReaderTo(element, fraction, Math.min(200, window.innerHeight * 0.3))) { setFeedback(copy.moved); return; }
        releaseFocus.current?.();
        releaseFocus.current = focusReadingBlock(element);
        setFeedback(copy.active(index + 1, result.matches.length));
      } finally {
        intent.dispose();
        if (pending.current === cancel) pending.current = null;
      }
    });
  }, [active, copy, ready, result.matches, searchKey]);

  useEffect(() => {
    if (!open) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing.current || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const article = document.getElementById("nw-article");
      if (!(target instanceof HTMLElement) || !article || nativeModalAbove(article)) return;
      const inSearch = section.current?.contains(target) ?? false;
      if (!inSearch && (!article.contains(target) || target.closest("input, textarea, select, [contenteditable='true']"))) return;
      if (event.key === "F3") {
        event.preventDefault();
        locate(event.shiftKey ? -1 : 1, target);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(inSearch);
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [close, locate, open]);

  return (
    <section className="nw-reader-find" ref={section}>
      <button className="nw-btn" ref={trigger} type="button" aria-expanded={open} aria-controls={id} onClick={event => toggle(event.currentTarget)}>{copy.toggle}</button>
      {open ? (
        <form id={id} role="search" aria-label={copy.toggle} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current)) event.preventDefault();
        }} onSubmit={event => {
          event.preventDefault();
          const initiator = document.activeElement;
          if (initiator instanceof HTMLElement) locate(1, initiator);
        }}>
          <p className="nw-m">{copy.hint}</p>
          <label>{copy.query}<input ref={input} type="search" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="nw-reading-actions">
            <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />{copy.caseSensitive}</label>
            <label><input type="checkbox" checked={foldWidth} onChange={event => setFoldWidth(event.target.checked)} />{copy.foldWidth}</label>
          </div>
          <p role="status">{result.unavailable ? copy.unsupported : busy ? copy.searching : ready && query.trim() ? result.invalidQuery ? copy.invalid : result.matches.length ? copy.count(result.matches.length) : copy.none : ""}</p>
          {result.moreMatches && ready ? <p>{copy.more}</p> : null}
          {result.limitedText && ready ? <p>{copy.limited}</p> : null}
          {!paintSupported ? <p>{copy.noPaint}</p> : null}
          {ready && current ? <p className="nw-find-excerpt">……{current.before}<mark>{current.text}</mark>{current.after}……</p> : null}
          <div className="nw-reading-actions">
            <button className="nw-btn" type="button" disabled={!ready || !result.matches.length} onClick={event => locate(-1, event.currentTarget)}>{copy.previous}</button>
            <button className="nw-btn" type="submit" disabled={!ready || !result.matches.length}>{copy.next}</button>
            <button type="button" onClick={() => { setQuery(""); setFeedback(""); input.current?.focus(); }}>{copy.clear}</button>
            <button type="button" onClick={() => close()}>{copy.close}</button>
          </div>
          {feedback ? <p role="status">{feedback}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
