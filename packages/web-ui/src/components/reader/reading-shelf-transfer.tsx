import { useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "@/lib/content.ts";
import { parseShelfBackup, planShelfImport, serializeShelfBackup, SHELF_BACKUP_BYTES, type ShelfImportMode } from "@/lib/reading-shelf-backup.ts";
import { readingShelfCopy, shelfProblemText } from "@/lib/reading-shelf-copy.ts";
import { shelfIdentity, type ShelfRecord } from "@/lib/reading-shelf.ts";
import { useReadingShelf } from "./reading-shelf-provider.tsx";

export function ReadingShelfTransfer({ locale }: { locale: Locale }) {
  const { store, actions, snapshot, canWrite, busy: writing } = useReadingShelf();
  const copy = readingShelfCopy(locale);
  const [incoming, setIncoming] = useState<ShelfRecord[] | null>(null);
  const [mode, setMode] = useState<ShelfImportMode>("keep");
  const [previewStamp, setPreviewStamp] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const fileSequence = useRef({ value: 0 });
  const downloads = useRef(new Map<string, number>());
  const plan = useMemo(() => incoming ? planShelfImport(snapshot.entries, incoming, mode, snapshot.invalid) : null, [incoming, mode, snapshot.entries, snapshot.invalid]);
  const stale = incoming !== null && snapshot.stamp !== previewStamp;
  const ready = snapshot.status === "ready";

  useEffect(() => {
    const urls = downloads.current;
    const sequence = fileSequence.current;
    return () => {
      sequence.value++;
      for (const [url, timer] of urls) { window.clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    };
  }, []);

  async function readFile(file: File | undefined) {
    const sequence = ++fileSequence.current.value;
    setIncoming(null);
    setFeedback("");
    setFailed(false);
    setBusy(false);
    if (!file) return;
    if (file.size > SHELF_BACKUP_BYTES) {
      setFeedback(shelfProblemText("size", locale));
      setFailed(true);
      return;
    }
    setBusy(true);
    try {
      const source = await file.text();
      if (sequence !== fileSequence.current.value) return;
      const result = parseShelfBackup(source);
      if (!result.ok) { setFeedback(shelfProblemText(result.code, locale)); setFailed(true); return; }
      setIncoming(result.entries);
      setPreviewStamp(store.getSnapshot().stamp);
      setMode("keep");
    } catch {
      if (sequence === fileSequence.current.value) { setFeedback(copy.importReadFailed); setFailed(true); }
    } finally {
      if (sequence === fileSequence.current.value) setBusy(false);
    }
  }

  function exportBackup() {
    setFeedback("");
    setFailed(false);
    let url: string | null = null;
    try {
      const current = store.getSnapshot();
      if (current.status !== "ready") throw new Error("Local storage not ready");
      const contents = serializeShelfBackup(current.entries, Date.now());
      url = URL.createObjectURL(new Blob([contents], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "no-wave-reading-list.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const downloaded = url;
      const timer = window.setTimeout(() => { URL.revokeObjectURL(downloaded); downloads.current.delete(downloaded); }, 30_000);
      downloads.current.set(downloaded, timer);
      setFeedback(copy.exported);
    } catch {
      if (url) URL.revokeObjectURL(url);
      setFeedback(copy.exportFailed);
      setFailed(true);
    }
  }

  async function applyPreview() {
    if (!incoming || !plan?.ok || stale || !canWrite || writing) return;
    const sequence = fileSequence.current.value;
    const result = await actions.importRecords(incoming, mode, previewStamp);
    if (sequence !== fileSequence.current.value) return;
    setFailed(!result.ok);
    if (result.ok) {
      setIncoming(null);
      setFeedback(copy.imported(result.applied));
    } else {
      setFeedback((result.applied > 0 ? copy.partial(result.applied) + " " : "") + shelfProblemText(result.code, locale));
    }
  }

  function discard() {
    fileSequence.current.value++;
    setIncoming(null);
    setBusy(false);
    setFeedback("");
  }

  return (
    <section className="nw-shelf-transfer" aria-label={copy.transfer}>
      <h2>{copy.transfer}</h2>
      <p>{copy.importHint}</p>
      <div className="nw-reading-actions">
        <button className="nw-btn" type="button" disabled={!ready || snapshot.entries.length === 0} onClick={exportBackup}>{copy.export}</button>
        <label>{copy.import}<input type="file" accept="application/json,.json" disabled={!ready} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void readFile(file);
        }} /></label>
      </div>
      {busy ? <p role="status">{copy.loading}</p> : null}
      {incoming ? (
        <div className="nw-shelf-preview" aria-label={copy.preview} role="region">
          <h3>{copy.preview}</h3>
          <label>{copy.importMode}<select value={mode} onChange={event => {
            setMode(event.target.value as ShelfImportMode);
            setPreviewStamp(snapshot.stamp);
            setFeedback("");
          }}><option value="keep">{copy.keep}</option><option value="replace">{copy.replace}</option></select></label>
          {plan?.ok ? <p>{copy.previewCounts(plan.added, plan.replaced, plan.kept)}</p> : <p role="alert">{shelfProblemText(plan?.code ?? "entry", locale)}</p>}
          <ul>{incoming.map(entry => <li key={shelfIdentity(entry)}>{entry.title} · {entry.author} · {entry.locale === "en" ? copy.english : copy.chinese}</li>)}</ul>
          {stale ? <p role="status">{copy.stalePreview} <button type="button" onClick={() => { setPreviewStamp(snapshot.stamp); setFeedback(""); }}>{copy.preview}</button></p> : null}
          <div className="nw-reading-actions">
            <button className="nw-btn" type="button" disabled={!canWrite || writing || !plan?.ok || stale} onClick={() => void applyPreview()}>{copy.apply}</button>
            <button type="button" onClick={discard}>{copy.discard}</button>
          </div>
        </div>
      ) : null}
      {feedback ? <p role={failed ? "alert" : "status"}>{feedback}</p> : null}
    </section>
  );
}
