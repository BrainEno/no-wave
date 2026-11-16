import { useEffect, useRef, useState } from "react";
import type { ArticleView } from "@/lib/content.ts";
import { Link } from "@/lib/framework/link.tsx";
import { readingShelfCopy, shelfProblemText } from "@/lib/reading-shelf-copy.ts";
import { readingListPath, shelfIdentity, shelfMetadataChanged, shelfMetadataFor, type ShelfMetadata, type ShelfState } from "@/lib/reading-shelf.ts";
import type { ShelfWriteResult } from "@/lib/reading-shelf-store.ts";
import { useReadingPosition } from "@/lib/use-reading-position.ts";
import { useReadingShelf } from "./reading-shelf-provider.tsx";

export function ArticleReadingList({ article }: { article: ArticleView }) {
  const metadata = shelfMetadataFor(article);
  return metadata ? <ArticleReadingEntry key={shelfIdentity(metadata)} metadata={metadata} sourceRevision={article.updatedAt ?? article.publishedAt} /> : null;
}

function ArticleReadingEntry({ metadata, sourceRevision }: { metadata: ShelfMetadata; sourceRevision: string }) {
  const { actions, snapshot, retry, canWrite, busy } = useReadingShelf();
  const identity = shelfIdentity(metadata);
  const record = snapshot.entries.find(entry => shelfIdentity(entry) === identity) ?? null;
  const copy = readingShelfCopy(metadata.locale);
  const position = useReadingPosition(identity, record, sourceRevision, metadata.locale);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const usable = canWrite && !busy;
  const report = async (pending: Promise<ShelfWriteResult>, success: string) => {
    const result = await pending;
    if (!alive.current) return false;
    setFailed(!result.ok);
    setFeedback(result.ok ? success : shelfProblemText(result.code, metadata.locale));
    return result.ok;
  };

  return (
    <section className="nw-reading-entry" aria-label={copy.title}>
      <div className="nw-reading-actions">
        <button className="nw-btn" type="button" disabled={!usable || record !== null} onClick={() => void report(actions.save(metadata), copy.saved)}>{record ? copy.savedAlready : copy.save}</button>
        <Link href={readingListPath(metadata.locale)}>{copy.open} →</Link>
        {record?.position ? <button className="nw-btn" type="button" onClick={event => { setFeedback(""); position.resume(event.currentTarget); }}>{copy.resume}</button> : null}
      </div>
      {snapshot.status === "loading" ? <p className="nw-m">{copy.loading}</p> : null}
      {snapshot.status === "unavailable" ? <p role="alert">{copy.unavailable} <button type="button" onClick={retry}>{copy.retry}</button></p> : null}
      {snapshot.status === "ready" && !canWrite ? <p role="status">{copy.readOnly}</p> : null}
      {record ? (
        <div className="nw-reading-options">
          <label>{copy.status}<select disabled={!usable} value={record.state} onChange={event => void report(actions.update(identity, record.revision, { state: event.target.value as ShelfState }), copy.stateChanged)}>
            <option value="later">{copy.later}</option><option value="reading">{copy.reading}</option><option value="finished">{copy.finished}</option>
          </select></label>
          <label className="nw-reading-check"><input type="checkbox" checked={record.tracking !== null} disabled={!usable} onChange={event => {
            const enabled = event.target.checked;
            void report(actions.update(identity, record.revision, { tracking: enabled }), enabled ? copy.trackingOn : copy.trackingOff);
          }} />{copy.remember}</label>
          <p className="nw-m">{copy.rememberHint}</p>
          {record.position ? <p className="nw-m">{copy.progress(record.position.percent)} <button type="button" disabled={!usable} onClick={() => void report(actions.update(identity, record.revision, { resetPosition: true }), copy.positionReset)}>{copy.resetPosition}</button></p> : null}
          {shelfMetadataChanged(record, metadata) ? <button type="button" disabled={!usable} onClick={() => void report(actions.update(identity, record.revision, { metadata }), copy.metadataUpdated)}>{copy.refreshMetadata}</button> : null}
        </div>
      ) : null}
      {feedback ? <p role={failed ? "alert" : "status"}>{feedback}</p> : null}
      {position.feedback ? <p role={position.failed ? "alert" : "status"}>{position.feedback}</p> : null}
    </section>
  );
}
