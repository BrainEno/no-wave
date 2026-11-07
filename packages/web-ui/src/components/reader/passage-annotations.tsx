import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "@/lib/content.ts";
import { speechLang } from "@/lib/read-aloud.ts";
import { speakSequence, speechSupported, type Speaker } from "@/lib/speech.ts";
import { decodeSharedPassage, passageShareUrl, searchablePassage, type SharedPassage } from "@/lib/passage-share.ts";
import { passageAnchorFor, type SelectedPiece } from "@/lib/passage-selection.ts";
import {
  PASSAGE_LIMIT,
  PASSAGES_PER_WORK,
  anchorIn,
  characterCount,
  findPassage,
  parsePassages,
  passageExcerpt,
  passageStorageKey,
  relocate,
  removePassage,
  upsertPassage,
  type Passage,
  type PassageAnchor,
} from "@/lib/passages.ts";

/**
 * 划线 — marking a passage and keeping it, on the reader's own device.
 *
 * The rules are in `lib/passages.ts` and in ADR 0021. What is left here is the
 * half that needs a browser: collecting the work's text, turning a selection
 * into offsets, painting the marks, and the shelf they are listed on.
 *
 * Two capabilities are asked for before anything is drawn — the Custom
 * Highlight API to paint a passage without rewriting the reader's DOM, and
 * `localStorage` to keep it. Where either is missing the feature is absent
 * rather than broken: a button that cannot work is a promise the page cannot
 * keep, and a mark that cannot be painted is not a mark.
 *
 * Marks are never sent anywhere. There is no endpoint, no account and no port
 * method behind any of this: the work is already on the page, and the reader's
 * copy of it belongs to them.
 */

export type PassageLabels = {
  shelf: string;
  empty: string;
  mark: string;
  note: string;
  edit: string;
  locate: string;
  remove: string;
  /** Reading one passage aloud: the button on the shelf, and its pressed state. */
  read: string;
  readStop: string;
  cancel: string;
  save: string;
  placeholder: string;
  /** `已保存 · 这条笔记 N/280` */
  count: (used: number, total: number) => string;
  saved: string;
  removed: string;
  full: string;
  tooLong: string;
  /** Shown when the passage cannot be found in the work any more. */
  gone: string;
  /** Sharing one passage: the button on the shelf, and the dialog around it. */
  share: string;
  shareTitle: string;
  /** What travels in the link, said to the reader before they copy it. */
  shareHint: string;
  copy: string;
  copied: string;
  copyFailed: string;
  /** A passage someone else shared: the card, and what it offers. */
  shared: string;
  sharedSave: string;
  sharedDismiss: string;
  sharedSaved: string;
  /** The words in the link are not in the work any more. */
  sharedGone: string;
  /** Shown when the browser refuses to store anything. */
  storageError: string;
};

/** The two highlight registries: a plain mark, and one with a note beside it. */
const MARK = "nw-passage";
const MARK_NOTE = "nw-passage-note";
/** A passage that arrived in a link: painted, but not the reader's yet. */
const MARK_SHARED = "nw-passage-shared";
/** Text that is part of a work, not of the page furniture around it. */
const SKIP = "script, style, [aria-hidden='true']";

type TextPoint = { node: Text; start: number; end: number };
type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: { highlights?: HighlightRegistry };
};

/** The name `CSS.highlights` is registered under, and the constructor for one. */
function highlightApi(window: HighlightWindow): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const registry = window.CSS?.highlights;
  const Highlight = window.Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

type PassageAnnotationsProps = { slug: string; locale: Locale; labels: PassageLabels };

export function PassageAnnotations({ slug, locale, labels }: PassageAnnotationsProps) {
  const key = useMemo(() => passageStorageKey(slug), [slug]);
  const [supported, setSupported] = useState(false);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [toolbar, setToolbar] = useState<{ top: number; left: number; anchor: PassageAnchor } | null>(null);
  const [draft, setDraft] = useState<{ anchor: PassageAnchor; id: string | null; note: string } | null>(null);
  const [status, setStatus] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [canSpeak, setCanSpeak] = useState(false);
  /** The passage being shared, and the link it was written into. */
  const [share, setShare] = useState<{ passage: Passage; url: string } | null>(null);
  /**
   * A passage that arrived in a link, and where it was found in *this* copy of
   * the work. `at: null` means the words are no longer here: the card says so,
   * and nothing is painted — a link must not draw a mark over words it cannot
   * find.
   */
  const [incoming, setIncoming] = useState<{ shared: SharedPassage; at: { start: number; end: number } | null } | null>(null);
  const points = useRef<TextPoint[]>([]);
  const source = useRef("");
  const dialog = useRef<HTMLDialogElement>(null);
  const shareDialog = useRef<HTMLDialogElement>(null);
  const speaker = useRef<Speaker | null>(null);

  useEffect(() => { setCanSpeak(speechSupported()); }, []);

  useEffect(() => {
    const api = highlightApi(window as HighlightWindow);
    let storage = true;
    try { window.localStorage.getItem(key); } catch { storage = false; }
    setSupported(api !== null && storage);
  }, [key]);

  /** The work's text, as one string, with the offsets of every text node in it. */
  const index = useCallback(() => {
    const article = document.getElementById("nw-article");
    if (!article) return;
    const collected: TextPoint[] = [];
    let text = "";
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const point = node as Text;
      const element = point.parentElement;
      if (!element || element.closest(SKIP)) continue;
      const start = text.length;
      text += point.data;
      collected.push({ node: point, start, end: text.length });
    }
    points.current = collected;
    source.current = text;
  }, []);

  /** Where a span of the work's text lives in the DOM. */
  const rangeFor = useCallback((start: number, end: number): Range | null => {
    const first = points.current.find((point) => start >= point.start && start < point.end);
    const last = points.current.find((point) => end > point.start && end <= point.end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }, []);

  /** Paint every mark that can still be found, and forget the ones that cannot. */
  const paint = useCallback((list: Passage[]) => {
    const api = highlightApi(window as HighlightWindow);
    if (!api) return;
    const plain: Range[] = [];
    const noted: Range[] = [];
    for (const passage of list) {
      const where = relocate(passage, source.current);
      const range = where ? rangeFor(where.start, where.end) : null;
      if (range) (passage.note ? noted : plain).push(range);
    }
    if (plain.length) api.registry.set(MARK, new api.Highlight(...plain));
    else api.registry.delete(MARK);
    if (noted.length) api.registry.set(MARK_NOTE, new api.Highlight(...noted));
    else api.registry.delete(MARK_NOTE);
  }, [rangeFor]);

  const persist = useCallback((list: Passage[]): boolean => {
    try {
      window.localStorage.setItem(key, JSON.stringify(list));
      return true;
    } catch {
      setStatus(labels.storageError);
      return false;
    }
  }, [key, labels.storageError]);

  /**
   * A passage that arrived in a link.
   *
   * It is painted under a name of its own, because it is not the reader's mark
   * yet — it is someone else's, offered. Nothing is written to the shelf until
   * the reader asks: a link that saved itself into the reader's browser would
   * be a page editing their notes on the strength of an address.
   */
  const receive = useCallback((shared: SharedPassage | null) => {
    const api = highlightApi(window as HighlightWindow);
    if (!api) return;
    if (!shared) {
      api.registry.delete(MARK_SHARED);
      setIncoming(null);
      return;
    }
    const at = relocate(searchablePassage(shared), source.current);
    const range = at ? rangeFor(at.start, at.end) : null;
    if (range) api.registry.set(MARK_SHARED, new api.Highlight(range));
    else api.registry.delete(MARK_SHARED);
    setIncoming({ shared, at: range ? at : null });
    if (!range) return;
    const box = range.getBoundingClientRect();
    if (box.top < 72 || box.bottom > window.innerHeight - 72) {
      window.scrollTo({ top: Math.max(0, window.scrollY + box.top - window.innerHeight * 0.38) });
    }
  }, [rangeFor]);

  /** The card is dismissed, and the address along with it: a link that has been
   * answered should not keep asking every time the page is reloaded. */
  const dismissShared = useCallback(() => {
    receive(null);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [receive]);

  /** Write a passage into a link, and show it so it can be copied either way. */
  const openShare = useCallback((passage: Passage) => {
    setShare({ passage, url: passageShareUrl(window.location.href, passage) });
  }, []);

  const copyShareLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus(labels.copied);
    } catch {
      // The link is on the screen in front of them, selected; that is the
      // fallback, and it is why the dialog shows it at all.
      setStatus(labels.copyFailed);
    }
  }, [labels.copied, labels.copyFailed]);

  // Read the marks, index the work and paint. The index is built after mount
  // because it is the rendered article's own text, which only exists then.
  useEffect(() => {
    if (!supported) return;
    index();
    const stored = (() => { try { return parsePassages(window.localStorage.getItem(key)); } catch { return []; } })();
    setPassages(stored);
    paint(stored);
    // A passage shared in a link, read from the fragment: the server is never
    // told about it, because a fragment is not part of a request.
    receive(decodeSharedPassage(window.location.hash));
    const onHashChange = (): void => receive(decodeSharedPassage(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    // Another tab of the same work is the same reader: what they mark there
    // should be here without a reload.
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== key) return;
      const next = parsePassages(event.newValue);
      setPassages(next);
      paint(next);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hashchange", onHashChange);
      const api = highlightApi(window as HighlightWindow);
      api?.registry.delete(MARK);
      api?.registry.delete(MARK_NOTE);
      api?.registry.delete(MARK_SHARED);
    };
  }, [index, key, paint, receive, supported]);

  /**
   * Read whatever is selected right now and decide whether to offer 划线.
   *
   * A reader can finish a drag while React is still flushing passive effects
   * on a cold load: the shelf is already in the DOM, but this listener and the
   * article's text index are attached a beat later. The selection survives its
   * `mouseup`, so the effect below also calls this once when it goes live —
   * an existing selection is then treated exactly like a fresh one.
   */
  const syncSelection = useCallback((): void => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const article = document.getElementById("nw-article");
    if (!selection || !range || range.collapsed || !article) { setToolbar(null); return; }
    if (!article.contains(range.commonAncestorContainer)) { setToolbar(null); return; }

    const pieces: SelectedPiece[] = [];
    for (const point of points.current) {
      if (!range.intersectsNode(point.node)) continue;
      const from = range.startContainer === point.node ? range.startOffset : 0;
      const to = range.endContainer === point.node ? range.endOffset : point.node.data.length;
      pieces.push({ start: point.start, from, to, text: point.node.data.slice(from, to) });
    }
    const verdict = passageAnchorFor(pieces, source.current, PASSAGE_LIMIT);
    if (verdict.kind === "hidden") { setToolbar(null); return; }
    if (verdict.kind === "tooLong") { setStatus(labels.tooLong); setToolbar(null); return; }
    const box = range.getBoundingClientRect();
    setToolbar({ top: box.top, left: box.left + box.width / 2, anchor: verdict.anchor });
  }, [labels.tooLong]);

  useEffect(() => {
    if (!supported) return;
    syncSelection();
    document.addEventListener("mouseup", syncSelection);
    document.addEventListener("touchend", syncSelection);
    return () => {
      document.removeEventListener("mouseup", syncSelection);
      document.removeEventListener("touchend", syncSelection);
    };
  }, [supported, syncSelection]);

  /** Save a mark, or rewrite the note on one that is already there. */
  const save = useCallback((anchor: PassageAnchor, note: string): Passage | undefined => {
    const existing = findPassage(passages, anchor);
    if (!existing && passages.length >= PASSAGES_PER_WORK) {
      setStatus(labels.full);
      return undefined;
    }
    const result = upsertPassage(passages, anchor, note);
    const passage = result.passage;
    if (!passage) {
      setStatus(labels.full);
      return undefined;
    }
    setPassages(result.passages);
    paint(result.passages);
    if (persist(result.passages)) setStatus(labels.saved);
    return passage;
  }, [labels.full, labels.saved, paint, passages, persist]);

  /** Take the shared passage onto the shelf, as a mark made here. */
  const keepShared = useCallback(() => {
    if (!incoming?.at) return;
    // Rebuilt from the text on *this* page, with its own context on both sides,
    // so from this moment it is indistinguishable from a passage marked by hand.
    const saved = save(anchorIn(source.current, incoming.at.start, incoming.at.end), "");
    if (!saved) return;
    setStatus(labels.sharedSaved);
    dismissShared();
  }, [dismissShared, incoming, labels.sharedSaved, save]);

  const forget = useCallback((id: string) => {
    const next = removePassage(passages, id);
    setPassages(next);
    paint(next);
    persist(next);
    setStatus(labels.removed);
  }, [labels.removed, paint, passages, persist]);

  const jumpTo = useCallback((passage: Passage) => {
    const where = relocate(passage, source.current);
    const range = where ? rangeFor(where.start, where.end) : null;
    if (!range) { setStatus(labels.gone); return; }
    const box = range.getBoundingClientRect();
    if (box.top < 72 || box.bottom > window.innerHeight - 72) {
      window.scrollTo({ top: Math.max(0, window.scrollY + box.top - window.innerHeight * 0.38) });
    }
  }, [labels.gone, rangeFor]);

  /** Read one marked passage: the same voice, the same rules, one paragraph. */
  const readPassage = useCallback((passage: Passage) => {
    if (reading === passage.id) {
      speaker.current?.stop();
      speaker.current = null;
      setReading(null);
      return;
    }
    if (relocate(passage, source.current) === null) {
      setStatus(labels.gone);
      return;
    }
    speaker.current?.stop();
    setReading(passage.id);
    speaker.current = speakSequence([passage.text], speechLang(locale), {
      onDone: () => { speaker.current = null; setReading(null); },
      onError: () => { speaker.current = null; setReading(null); },
      // The article's own 朗读 can take the voice back; the shelf must not keep
      // showing 停止 for a passage that is no longer being read.
      onTakeover: () => { speaker.current = null; setReading(null); },
    });
  }, [labels.gone, locale, reading]);

  useEffect(() => () => { speaker.current?.stop(); }, []);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (draft && !node.open) node.showModal();
    if (!draft && node.open) node.close();
  }, [draft]);

  useEffect(() => {
    const node = shareDialog.current;
    if (!node) return;
    if (share && !node.open) node.showModal();
    if (!share && node.open) node.close();
  }, [share]);

  if (!supported) return null;

  const draftLength = draft ? characterCount(draft.note) : 0;

  return (
    <div className="nw-passages" data-passages>
      {incoming ? (
        <div className="nw-passage-card" role="status" data-passage-shared>
          <p className="nw-passage-card-title">{labels.shared}</p>
          <p className="nw-passage-quote-static">{passageExcerpt(incoming.shared.text, 120)}</p>
          <div className="nw-passage-actions">
            {incoming.at ? (
              <button type="button" className="nw-btn nw-pri" onClick={keepShared} data-passage-shared-keep>{labels.sharedSave}</button>
            ) : (
              <span className="nw-m">{labels.sharedGone}</span>
            )}
            <button type="button" className="nw-btn" onClick={dismissShared} data-passage-shared-dismiss>{labels.sharedDismiss}</button>
          </div>
        </div>
      ) : null}

      {toolbar ? (
        <div
          className="nw-passage-tools"
          role="group"
          aria-label={labels.shelf}
          style={{ top: toolbar.top, left: toolbar.left }}
          data-passage-tools
        >
          <button type="button" onClick={() => { save(toolbar.anchor, ""); setToolbar(null); }} data-passage-mark>{labels.mark}</button>
          <button type="button" onClick={() => { setDraft({ anchor: toolbar.anchor, id: null, note: "" }); setToolbar(null); }} data-passage-note>{labels.note}</button>
          <button type="button" onClick={() => setToolbar(null)}>{labels.cancel}</button>
        </div>
      ) : null}

      <details className="nw-passage-shelf" open={passages.length > 0} data-passage-shelf>
        <summary>
          <span className="nw-zh">{labels.shelf}</span> <span className="nw-m" data-passage-count>({passages.length})</span>
        </summary>
        {passages.length === 0 ? (
          <p className="nw-m">{labels.empty}</p>
        ) : (
          <ul className="nw-passage-list">
            {[...passages].reverse().map((passage) => (
              <li key={passage.id} data-passage={passage.id}>
                <button type="button" className="nw-passage-quote" onClick={() => jumpTo(passage)}>{passageExcerpt(passage.text)}</button>
                {passage.note ? <p className="nw-passage-note">{passage.note}</p> : null}
                <span className="nw-passage-actions">
                  <button type="button" onClick={() => setDraft({ anchor: passage, id: passage.id, note: passage.note })}>{passage.note ? labels.edit : labels.note}</button>
                  <button type="button" onClick={() => jumpTo(passage)}>{labels.locate}</button>
                  {canSpeak ? (
                    <button type="button" aria-pressed={reading === passage.id} onClick={() => readPassage(passage)}>
                      {reading === passage.id ? labels.readStop : labels.read}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => openShare(passage)} data-passage-share>{labels.share}</button>
                  <button type="button" onClick={() => forget(passage.id)}>{labels.remove}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <dialog className="nw-passage-dialog" ref={dialog} onClose={() => setDraft(null)} aria-label={labels.note} data-passage-dialog="note">
        {draft ? (
          <form method="dialog" onSubmit={() => {
            if (draft.id) {
              const next = passages.map((passage) => (passage.id === draft.id ? { ...passage, note: draft.note.trim(), updatedAt: Date.now() } : passage));
              setPassages(next);
              paint(next);
              persist(next);
              setStatus(labels.saved);
            } else {
              save(draft.anchor, draft.note);
            }
            setDraft(null);
          }}>
            <p className="nw-passage-quote-static">{passageExcerpt(draft.anchor.text, 120)}</p>
            <textarea
              className="nw-passage-input"
              value={draft.note}
              maxLength={280}
              rows={4}
              placeholder={labels.placeholder}
              aria-label={labels.note}
              data-passage-input
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
            <p className="nw-m" aria-live="polite">{labels.count(draftLength, 280)}</p>
            <div className="nw-passage-actions">
              <button type="submit" className="nw-btn nw-pri" data-passage-save>{labels.save}</button>
              <button type="button" className="nw-btn" onClick={() => setDraft(null)}>{labels.cancel}</button>
            </div>
          </form>
        ) : null}
      </dialog>

      <dialog className="nw-passage-dialog" ref={shareDialog} onClose={() => setShare(null)} aria-label={labels.shareTitle} data-passage-dialog="share">
        {share ? (
          <div>
            <p className="nw-passage-quote-static">{passageExcerpt(share.passage.text, 120)}</p>
            {/* The link is on the screen whether or not this browser will let
                the page copy it, and it is selected the moment it appears. */}
            <input
              className="nw-passage-input"
              readOnly
              value={share.url}
              aria-label={labels.shareTitle}
              data-passage-share-url
              ref={(node) => node?.select()}
            />
            <p className="nw-m">{labels.shareHint}</p>
            <div className="nw-passage-actions">
              <button type="button" className="nw-btn nw-pri" onClick={() => void copyShareLink(share.url)} data-passage-share-copy>{labels.copy}</button>
              <button type="button" className="nw-btn" onClick={() => setShare(null)}>{labels.cancel}</button>
            </div>
          </div>
        ) : null}
      </dialog>

      <span className="nw-sr" role="status" aria-live="polite">{status}</span>
    </div>
  );
}
