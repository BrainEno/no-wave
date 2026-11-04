"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";

/**
 * 关注作者 — the author page's one interaction (#198).
 *
 * The API has served `POST`/`DELETE /api/v1/users/:userId/follow` for a while
 * and no Web surface called it, so following was reachable only by clients that
 * already knew the endpoint existed.
 *
 * Two facts shaped this component more than anything else:
 *
 * 1. **The page is server-rendered without a session.** `loadAuthorPage` calls
 *    the content API with no cookie, so the `isFollowing` baked into the HTML is
 *    `false` for everybody — including a reader who follows the author. The count
 *    is public and correct either way; the boolean has to be fetched from the
 *    browser, with the cookie, before the button can be trusted. Until that
 *    answer arrives the button is disabled, because a button that starts in the
 *    wrong state and corrects itself invites a click that undoes nothing.
 *
 * 2. **Following is a relationship, not a boolean.** `POST` twice is still
 *    followed and `DELETE` twice is still unfollowed. So the component sends the
 *    verb that matches the state it wants, never "the opposite of what I think I
 *    have" — a toggle computed from a stale read is how a retry unfollows
 *    somebody.
 *
 * As with the save control: optimistic with rollback, one write in flight at a
 * time, and a signed-out click is a sign-in prompt rather than an error.
 */

type FollowState = { followerCount: number; isFollowing: boolean };

export function AuthorFollow({ userId, locale }: { userId: string; locale: Locale }) {
  const copy = getUi(locale);
  const ui = copy.author;
  const [state, setState] = useState<FollowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // Guards against a response the reader has already superseded, and against
  // the component unmounting mid-flight.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const query = `?locale=${encodeURIComponent(locale)}`;
    fetch(`/api/authors/${encodeURIComponent(userId)}${query}`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (cancelled) return;
        const payload: unknown = await response.json().catch(() => null);
        const data = readState(payload);
        // A failed *read* leaves the button disabled rather than guessing: the
        // count is decoration, but the pressed state drives a write, and a write
        // based on a guess is how the wrong verb gets sent.
        if (data) setState(data);
      })
      .catch(() => {
        if (!cancelled) setError(ui.followFailed);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId, locale, ui.followFailed]);

  const toggle = useCallback(async () => {
    if (!state || pending) return;
    const current = state;
    const nextFollowing = !current.isFollowing;

    // Optimistic: the press shows before the round trip.
    const optimistic: FollowState = {
      isFollowing: nextFollowing,
      followerCount: Math.max(0, current.followerCount + (nextFollowing ? 1 : -1)),
    };
    setState(optimistic);
    setPending(true);
    setError("");
    setNeedsSignIn(false);

    try {
      const query = `?locale=${encodeURIComponent(locale)}`;
      const response = await fetch(`/api/users/${encodeURIComponent(userId)}/follow${query}`, {
        method: nextFollowing ? "POST" : "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!alive.current) return;

      if (response.status === 401) {
        // Signed out is a normal state on a page anyone can read.
        setState(current);
        setNeedsSignIn(true);
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload));

      // The server's numbers win: another reader may have followed during the
      // round trip, and the API returns the profile it just recomputed.
      const data = readState(payload);
      setState(data ?? optimistic);
    } catch {
      if (!alive.current) return;
      setState(current);
      setError(ui.followFailed);
    } finally {
      if (alive.current) setPending(false);
    }
  }, [state, pending, userId, locale, ui.followFailed]);

  const count = state?.followerCount ?? 0;
  const following = state?.isFollowing ?? false;
  const disabled = loading || pending || state === null;

  return (
    <div className="nw-follow">
      <button
        type="button"
        className={`nw-follow-btn${following ? " nw-follow-on" : ""}`}
        onClick={toggle}
        disabled={disabled}
        aria-pressed={following}
        aria-busy={pending}
        aria-label={
          loading
            ? ui.followLoading
            : following
              ? `${ui.following} ${ui.followerCount(count)}`
              : `${ui.follow} ${ui.followerCount(count)}`
        }
      >
        <span className="nw-follow-mark" aria-hidden="true">{following ? "✓" : "+"}</span>
        <span>{loading ? ui.followLoading : pending ? ui.following : following ? ui.following : ui.follow}</span>
      </button>
      <span className="nw-follow-count">
        {count > 0 ? ui.followerCount(count) : ui.followerNone}
      </span>
      {needsSignIn ? (
        <span className="nw-follow-note">
          {ui.followSignIn}{" "}
          <Link href={`/sign-in?next=${encodeURIComponent(currentPath())}`}>{copy.reader.saveSignInAction}</Link>
        </span>
      ) : null}
      {error ? <span className="nw-follow-note" role="alert">{error}</span> : null}
    </div>
  );
}

/**
 * The state the API sends: a public count and the viewer's own flag.
 *
 * Read defensively rather than cast — a proxy or an older deployment that omits
 * a field must not produce a button claiming `isFollowing: true` because
 * `undefined` happened to be falsy in the wrong place.
 */
function readState(payload: unknown): FollowState | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { followerCount, isFollowing } = data as { followerCount?: unknown; isFollowing?: unknown };
  if (typeof followerCount !== "number" || !Number.isFinite(followerCount) || followerCount < 0) return null;
  if (typeof isFollowing !== "boolean") return null;
  return { followerCount, isFollowing };
}

function readError(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function currentPath(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
}
