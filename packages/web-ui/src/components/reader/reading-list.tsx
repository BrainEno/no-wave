import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Locale } from "@/lib/content.ts";
import { archivePath } from "@/lib/content.ts";
import { Link } from "@/lib/framework/link.tsx";
import { DEFAULT_SHELF_FILTERS, filterShelf, shelfIdentity, shelfRecordHref, shelfStats, type ShelfFilters, type ShelfRecord, type ShelfState } from "@/lib/reading-shelf.ts";
import { readingShelfCopy, shelfProblemText } from "@/lib/reading-shelf-copy.ts";
import { observePendingFocus } from "@/lib/pending-focus-intent.ts";
import { nativeModalAbove } from "@/lib/overlay-focus.ts";
import type { ShelfWriteResult } from "@/lib/reading-shelf-store.ts";
import { useConfirm } from "@/components/ui/confirm-dialog.tsx";
import { useReadingShelf } from "./reading-shelf-provider.tsx";
import { ReadingShelfTransfer } from "./reading-shelf-transfer.tsx";

const PAGE_SIZE = 20;

export function ReadingListPage({ locale }: { locale: Locale }) {
  const { actions, snapshot, retry, canWrite, busy } = useReadingShelf();
  const copy = readingShelfCopy(locale);
  const [filters, setFilters] = useState<ShelfFilters>({ ...DEFAULT_SHELF_FILTERS });
  const [requestedPage, setRequestedPage] = useState(1);
  const [selection, setSelection] = useState(new Map<string, string>());
  const [bulkState, setBulkState] = useState<ShelfState>("finished");
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const rowsElement = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const { confirm, dialog } = useConfirm();
  const filtered = useMemo(() => filterShelf(snapshot.entries, filters), [snapshot.entries, filters]);
  const counts = useMemo(() => shelfStats(snapshot.entries), [snapshot.entries]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ready = canWrite && !busy;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pendingFocus.current?.(); };
  }, []);

  function changeFilters(change: Partial<ShelfFilters>) {
    setFilters(previous => ({ ...previous, ...change }));
    setRequestedPage(1);
    setSelection(new Map());
  }

  async function perform(initiator: HTMLElement, run: () => Promise<ShelfWriteResult>, message: (count: number) => string) {
    pendingFocus.current?.();
    const intent = observePendingFocus(document, initiator);
    let frame = 0;
    const cancel = () => { window.cancelAnimationFrame(frame); intent.dispose(); };
    pendingFocus.current = cancel;
    const result = await run();
    if (!alive.current) { cancel(); return result; }
    setFailed(!result.ok);
    setFeedback(result.ok ? message(result.applied) : (result.applied > 0 ? copy.partial(result.applied) + " " : "") + shelfProblemText(result.code, locale));
    const repair = (lastChance: boolean) => {
      if (!alive.current || !intent.mayRepair()) { cancel(); return; }
      if (initiator.isConnected && !initiator.matches(":disabled")) { cancel(); return; }
      const heading = resultsHeading.current;
      if (!heading) { cancel(); return; }
      if (nativeModalAbove(heading) && !lastChance) { frame = window.requestAnimationFrame(() => repair(true)); return; }
      if (!nativeModalAbove(heading)) heading.focus({ preventScroll: true });
      cancel();
    };
    frame = window.requestAnimationFrame(() => repair(false));
    return result;
  }

  async function removeOne(record: ShelfRecord, initiator: HTMLElement) {
    const accepted = await confirm({ title: copy.removeTitle, description: `${record.title}\n${copy.removeHint}`, confirmLabel: copy.confirmRemove, cancelLabel: copy.cancel, tone: "danger" });
    if (!accepted || !alive.current) return;
    await perform(initiator, () => actions.remove(shelfIdentity(record), record.revision), () => copy.removed);
    if (!alive.current) return;
    setSelection(previous => { const next = new Map(previous); next.delete(shelfIdentity(record)); return next; });
  }

  async function clearAll(initiator: HTMLElement) {
    const stamp = snapshot.stamp;
    const accepted = await confirm({ title: copy.clearTitle, description: copy.clearHint, confirmLabel: copy.clear, cancelLabel: copy.cancel, tone: "danger" });
    if (!accepted || !alive.current) return;
    const result = await perform(initiator, () => actions.clear(stamp), () => copy.cleared);
    if (!alive.current) return;
    if (result.ok || result.applied > 0) setSelection(new Map());
  }

  function selectedRevisions() {
    return [...selection].map(([identity, revision]) => ({ identity, revision }));
  }

  async function applyBulk(operation: ShelfState | "remove", initiator: HTMLElement) {
    const selected = selectedRevisions();
    if (!selected.length) return;
    if (operation === "remove") {
      const accepted = await confirm({ title: copy.bulkTitle, description: copy.bulkHint(selected.length), confirmLabel: copy.bulkRemove, cancelLabel: copy.cancel, tone: "danger" });
      if (!accepted || !alive.current) return;
    }
    const result = await perform(initiator, () => actions.batch(selected, operation), copy.bulkDone);
    if (!alive.current) return;
    if (result.ok || result.applied > 0) setSelection(new Map());
  }

  function select(record: ShelfRecord, checked: boolean) {
    setSelection(previous => {
      const next = new Map(previous);
      const identity = shelfIdentity(record);
      if (checked) next.set(identity, record.revision);
      else next.delete(identity);
      return next;
    });
  }

  function selectPage() {
    setSelection(previous => {
      const next = new Map(previous);
      for (const record of rows) next.set(shelfIdentity(record), record.revision);
      return next;
    });
  }

  function moveBetweenRows(event: KeyboardEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = [...(rowsElement.current?.querySelectorAll<HTMLAnchorElement>("[data-shelf-title]") ?? [])];
    const at = links.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : Math.max(0, Math.min(links.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    if (!links[next]) return;
    event.preventDefault();
    links[next]!.focus();
  }

  return (
    <main id="top" tabIndex={-1} className="nw-w nw-head nw-reading-list" data-route="reading-list" lang={locale}>
      <header><h1>{copy.title}</h1><p>{copy.intro}</p><p className="nw-m">{copy.privacy}</p></header>
      {snapshot.status === "loading" ? <p role="status">{copy.loading}</p> : null}
      {snapshot.status === "unavailable" ? <p role="alert">{copy.unavailable} <button type="button" onClick={retry}>{copy.retry}</button></p> : null}
      {snapshot.status === "ready" && !canWrite ? <p role="status">{copy.readOnly}</p> : null}
      {snapshot.invalid ? <p role="alert">{copy.invalid(snapshot.invalid)}</p> : null}
      <div className="nw-shelf-filters" role="search" aria-label={copy.query}>
        <label>{copy.query}<input type="search" maxLength={200} value={filters.query} placeholder={copy.searchHint} onChange={event => changeFilters({ query: event.target.value })} /></label>
        <label>{copy.edition}<select value={filters.edition} onChange={event => changeFilters({ edition: event.target.value as ShelfFilters["edition"] })}>
          <option value="all">{copy.allEditions}</option><option value="zh-CN">{copy.chinese}</option><option value="en">{copy.english}</option>
        </select></label>
        <label>{copy.sort}<select value={filters.sort} onChange={event => changeFilters({ sort: event.target.value as ShelfFilters["sort"] })}>
          <option value="recent">{copy.recent}</option><option value="saved">{copy.savedSort}</option><option value="title">{copy.titleSort}</option><option value="progress">{copy.progressSort}</option>
        </select></label>
        <button type="button" onClick={() => changeFilters({ ...DEFAULT_SHELF_FILTERS })}>{copy.reset}</button>
      </div>
      <div className="nw-reading-actions" role="group" aria-label={copy.status}>
        {(["all", "later", "reading", "finished"] as const).map(state => <button type="button" key={state} aria-pressed={filters.state === state} onClick={() => changeFilters({ state })}>{state === "all" ? copy.all : copy[state]} ({state === "all" ? counts.total : counts[state]})</button>)}
      </div>
      <section aria-label={copy.entries}>
        <h2 ref={resultsHeading} tabIndex={-1}>{copy.entries}</h2>
        <p role="status">{copy.total(filtered.length, snapshot.entries.length)}</p>
        <p className="nw-m">{copy.keyboard}</p>
        <div className="nw-shelf-bulk" role="group" aria-label={copy.bulkApply}>
          <button type="button" disabled={!ready || !rows.length} onClick={selectPage}>{copy.selectPage}</button>
          <button type="button" disabled={!selection.size} onClick={() => setSelection(new Map())}>{copy.clearSelection}</button>
          <span>{copy.selected(selection.size)}</span>
          <label>{copy.bulkState}<select value={bulkState} disabled={!ready || !selection.size} onChange={event => setBulkState(event.target.value as ShelfState)}>
            <option value="later">{copy.later}</option><option value="reading">{copy.reading}</option><option value="finished">{copy.finished}</option>
          </select></label>
          <button className="nw-btn" type="button" disabled={!ready || !selection.size} onClick={event => void applyBulk(bulkState, event.currentTarget)}>{copy.bulkApply}</button>
          <button type="button" disabled={!ready || !selection.size} onClick={event => void applyBulk("remove", event.currentTarget)}>{copy.bulkRemove}</button>
        </div>
        {snapshot.status === "ready" && !filtered.length ? <p>{snapshot.entries.length ? copy.noMatches : copy.empty} <Link href={archivePath(locale)}>{copy.browse}</Link></p> : null}
        <ul className="nw-shelf-rows" ref={rowsElement}>
          {rows.map(record => {
            const identity = shelfIdentity(record);
            const editionLabel = record.locale === "en" ? copy.english : copy.chinese;
            return <li key={identity} data-shelf-id={identity}>
              <label className="nw-shelf-select"><input type="checkbox" checked={selection.has(identity)} disabled={!ready} onChange={event => select(record, event.target.checked)} aria-label={`${copy.select}: ${record.title} (${editionLabel})`} /></label>
              <div className="nw-shelf-work"><h3><Link data-shelf-title href={shelfRecordHref(record)} onKeyDown={moveBetweenRows}>{record.title}</Link></h3><p>{record.author} · {editionLabel}</p><p className="nw-m">{record.position ? copy.progress(record.position.percent) : copy.noPosition}</p></div>
              <label>{copy.status}<select value={record.state} disabled={!ready} aria-label={`${copy.status}: ${record.title} (${editionLabel})`} onChange={event => {
                const state = event.target.value as ShelfState;
                void perform(event.currentTarget, () => actions.update(identity, record.revision, { state }), () => copy.stateChanged);
              }}><option value="later">{copy.later}</option><option value="reading">{copy.reading}</option><option value="finished">{copy.finished}</option></select></label>
              <button type="button" disabled={!ready} aria-label={`${copy.remove}: ${record.title} (${editionLabel})`} onClick={event => void removeOne(record, event.currentTarget)}>{copy.remove}</button>
            </li>;
          })}
        </ul>
        {pages > 1 ? <nav className="nw-reading-actions" aria-label={copy.pagination}>
          <button className="nw-btn" type="button" disabled={page <= 1} onClick={() => setRequestedPage(page - 1)}>{copy.previous}</button>
          <span>{copy.page(page, pages)}</span><button className="nw-btn" type="button" disabled={page >= pages} onClick={() => setRequestedPage(page + 1)}>{copy.next}</button>
        </nav> : null}
      </section>
      {feedback ? <p role={failed ? "alert" : "status"}>{feedback}</p> : null}
      <ReadingShelfTransfer locale={locale} />
      <button type="button" className="nw-btn" disabled={!ready || snapshot.entries.length + snapshot.invalid === 0} onClick={event => void clearAll(event.currentTarget)}>{copy.clear}</button>
      {dialog}
    </main>
  );
}
