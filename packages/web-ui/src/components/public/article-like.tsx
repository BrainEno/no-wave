"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";

/**
 * 收藏 — saving a work, the one interaction the reading page was missing (#198).
 *
 * The API has served `GET`/`PUT /api/v1/articles/:slug/like` for a while and no
 * Web surface called it, so the capability existed only for clients that already
 * knew about it.
 *
 * Three behaviours are worth stating, because each one is a way this could look
 * fine and be wrong:
 *
 * - **Optimistic with rollback.** The count and the pressed state change on
 *   click, not after the round trip — a save that waits for the network reads as
 *   broken on the connection where it matters most. If the request fails, both
 *   revert to what they were, so the button never claims a save that did not
 *   happen.
 * - **Signed out is a prompt, not an error.** The API answers `401`; that is a
 *   normal state on a page anyone can read, so it becomes a sign-in link rather
 *   than a red message.
 * - **One request at a time.** A second click while a write is in flight is
 *   dropped. Without that, a double click could send "save" and "unsave" and the
 *   answer to the slower one would win — the server would end up with a state
 *   the reader never asked for.
 */

type LikeState = { likeCount: number; likedByViewer: boolean };

export function ArticleLike({ slug, locale }: { slug: string; locale: Locale }) {
  const ui = getUi(locale).reader;
  const [state, setState] = useState<LikeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // Guards against a response from a request the reader has already superseded,
  // and against the component unmounting mid-flight.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/articles/${encodeURIComponent(slug)}/like?locale=${encodeURIComponent(locale)}`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (cancelled) return;
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(readError(payload));
        const data = readState(payload);
        if (!data) throw new Error(ui.saveFailed);
        setState(data);
      })
      .catch(() => {
        // A failed *read* is not the reader's problem to fix and does not block
        // them: the count is decoration on a feature that still works, so the
        // button stays usable and simply has no number.
        if (!cancelled) setState((current) => current ?? { likeCount: 0, likedByViewer: false });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug, locale, ui.saveFailed]);

  const toggle = useCallback(async () => {
    if (pending) return;
    const current = state;
    if (!current) return;
    const nextLiked = !current.likedByViewer;
    // Optimistic: the count moves with the press, in the same direction, so the
    // number and the label never disagree for a frame.
    const optimistic: LikeState = {
      likedByViewer: nextLiked,
      likeCount: Math.max(0, current.likeCount + (nextLiked ? 1 : -1)),
    };
    setState(optimistic);
    setPending(true);
    setError("");
    setNeedsSignIn(false);
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(slug)}/like?locale=${encodeURIComponent(locale)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ liked: nextLiked }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!alive.current) return;
      if (response.status === 401) {
        setState(current);
        setNeedsSignIn(true);
        return;
      }
      if (!response.ok) throw new Error(readError(payload));
      // Trust the server's numbers over the optimistic guess: another reader may
      // have saved it in the meantime.
      const data = readState(payload);
      setState(data ?? optimistic);
    } catch {
      if (!alive.current) return;
      setState(current);
      setError(ui.saveFailed);
    } finally {
      if (alive.current) setPending(false);
    }
  }, [pending, state, slug, locale, ui.saveFailed]);

  const liked = state?.likedByViewer ?? false;
  const count = state?.likeCount ?? 0;

  return (
    <div className="nw-like">
      <button
        type="button"
        className={liked ? "nw-like-btn nw-like-on" : "nw-like-btn"}
        onClick={() => void toggle()}
        disabled={pending || loading}
        aria-pressed={liked}
        aria-label={liked ? ui.savedState : ui.save}
      >
        <span aria-hidden="true" className="nw-like-mark">{liked ? "●" : "○"}</span>
        <span>{loading ? ui.saveLoading : liked ? ui.savedState : ui.save}</span>
      </button>
      <p className="nw-like-count" role="status">
        {count === 0 ? ui.saveNone : ui.saveCount(count)}
      </p>
      {needsSignIn ? (
        <p className="nw-like-note" role="status">
          {ui.saveSignIn}{" "}
          <Link href={`/sign-in?next=${encodeURIComponent(`/articles/${slug}`)}`}>{ui.saveSignInAction}</Link>
        </p>
      ) : null}
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** The shape `GET`/`PUT /articles/:slug/like` answers with, read defensively. */
function readState(payload: unknown): LikeState | null {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as { likeCount?: unknown; likedByViewer?: unknown };
  if (typeof record.likeCount !== "number" || typeof record.likedByViewer !== "boolean") return null;
  return { likeCount: record.likeCount, likedByViewer: record.likedByViewer };
}

function readError(payload: unknown, fallback = "收藏状态没能保存，请稍后重试。"): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}
