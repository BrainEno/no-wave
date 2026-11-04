"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { articlePath, type Locale, type WorkType } from "@/lib/content.ts";
import { dateLabel } from "@/lib/format.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { EmptyState, SectionHeading, TypeChip } from "@/components/ui/parts.tsx";

/**
 * 关注流 — the read side of following (#198).
 *
 * `GET /api/v1/me/feed` has been served for as long as the follow endpoint has.
 * Without a page reading it, following an author only lets a reader walk into
 * that profile and look: the graph is write-only, and the follow button in the
 * previous part would have been a control with no consequence.
 *
 * The page shell is server-rendered, but **the list is not**: the feed is
 * per-viewer and the loader cannot see the access token (it is `HttpOnly` and
 * scoped below `/`). So the shell decides only whether the visitor has a usable
 * session, and the list arrives from `/api/feed` with the browser's own cookie.
 *
 * Three states look similar and must not be collapsed:
 *
 *   - **401** — this reader is signed out. Show a sign-in link. An empty list
 *     here would say "nobody you follow published anything", which is a claim
 *     about their graph rather than about their session.
 *   - **empty list** — signed in, and either they follow nobody or nobody they
 *     follow has published. Say so, and point at the author directory.
 *   - **failure** — the read broke. Say that, and offer to try again; do not
 *     present a broken read as an empty feed.
 */

type FeedItem = {
  slug: string;
  title: string;
  authorId: string;
  authorName: string;
  publishedAt: string;
  workType: WorkType | null;
};

type FeedState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; items: FeedItem[]; more: boolean }
  | { kind: "failed" };

const PAGE_SIZE = 20;

export function FeedView({ locale }: { locale: Locale }) {
  const ui = getUi(locale).feed;
  const [state, setState] = useState<FeedState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  // Guards against a response for a request the reader has already replaced.
  const generation = useRef(0);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      const mine = ++generation.current;
      if (append) setLoadingMore(true);
      else setState({ kind: "loading" });

      const query = `?locale=${encodeURIComponent(locale)}&limit=${PAGE_SIZE}&offset=${nextOffset}`;
      try {
        const response = await fetch(`/api/feed${query}`, {
          headers: { accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (mine !== generation.current) return;

        if (response.status === 401) {
          // A normal state for a page that requires a session.
          setState({ kind: "signed-out" });
          return;
        }
        if (!response.ok) {
          setState({ kind: "failed" });
          return;
        }

        const payload: unknown = await response.json().catch(() => null);
        if (mine !== generation.current) return;
        const page = readItems(payload, locale);
        if (page === null) {
          setState({ kind: "failed" });
          return;
        }

        setOffset(nextOffset);
        setState((previous) => {
          const items = append && previous.kind === "ready" ? [...previous.items, ...page] : page;
          return { kind: "ready", items, more: page.length === PAGE_SIZE };
        });
      } catch {
        if (mine === generation.current) setState({ kind: "failed" });
      } finally {
        if (mine === generation.current) setLoadingMore(false);
      }
    },
    [locale],
  );

  useEffect(() => {
    void load(0, false);
    return () => {
      // A late response for a page nobody is looking at must not set state.
      generation.current += 1;
    };
  }, [load]);

  if (state.kind === "loading") {
    return (
      <main lang={locale} className="nw-w">
        <SectionHeading zh={ui.eyebrow} latin="Following" />
        <p className="nw-m nw-feed-note">{ui.loading}</p>
      </main>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <main lang={locale} className="nw-w">
        <SectionHeading zh={ui.eyebrow} latin="Following" />
        <EmptyState
          title={ui.signIn}
          body={ui.intro}
          href={`/sign-in?next=${encodeURIComponent("/feed")}`}
          action={getUi(locale).reader.saveSignInAction}
        />
      </main>
    );
  }

  if (state.kind === "failed") {
    return (
      <main lang={locale} className="nw-w">
        <SectionHeading zh={ui.eyebrow} latin="Following" />
        <div className="nw-feed-note" role="alert">
          <p>{ui.failed}</p>
          <button type="button" className="nw-feed-retry" onClick={() => void load(0, false)}>
            {ui.retry}
          </button>
        </div>
      </main>
    );
  }

  if (state.items.length === 0) {
    return (
      <main lang={locale} className="nw-w">
        <SectionHeading zh={ui.eyebrow} latin="Following" />
        <EmptyState
          title={ui.empty}
          body={ui.emptyHint}
          href={authorsIndexPath(locale)}
          action={ui.browse}
        />
      </main>
    );
  }

  return (
    <main lang={locale} className="nw-w">
      <SectionHeading
        zh={ui.eyebrow}
        latin="Following"
        aside={<span className="nw-m">{ui.count(state.items.length)}</span>}
      />
      <p className="nw-m nw-feed-intro">{ui.intro}</p>
      <div>
        {state.items.map((item) => (
          <Link key={item.slug} className="nw-cr" href={articlePath(item.slug, locale)}>
            <span className="nw-m">{dateLabel(item.publishedAt, locale)}</span>
            <span className="nw-zh">{item.title}</span>
            <span className="nw-m">
              {item.workType ? <TypeChip type={item.workType} locale={locale} /> : null}{" "}
              {item.authorId ? (
                <span className="nw-feed-author">{item.authorName}</span>
              ) : (
                item.authorName
              )}
            </span>
          </Link>
        ))}
      </div>
      {state.more ? (
        <div className="nw-feed-more">
          <button
            type="button"
            className="nw-feed-retry"
            disabled={loadingMore}
            onClick={() => void load(offset + PAGE_SIZE, true)}
          >
            {loadingMore ? ui.loading : ui.more}
          </button>
        </div>
      ) : (
        <p className="nw-m nw-feed-intro">{ui.end}</p>
      )}
    </main>
  );
}

/**
 * Read the feed payload into the few fields this page shows.
 *
 * The API sends full article projections; a list only needs the title, when it
 * was published and who wrote it. A record that is missing a slug or a title is
 * dropped rather than rendered as a blank row that links nowhere — the same
 * treatment `mapArticle` gives a malformed article elsewhere.
 */
function readItems(payload: unknown, locale: Locale): FeedItem[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const items: FeedItem[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.slug !== "string" || typeof record.title !== "string") continue;
    const author = typeof record.author === "object" && record.author !== null
      ? (record.author as Record<string, unknown>)
      : {};
    const workType = record.workType;
    items.push({
      slug: record.slug,
      title: record.title,
      authorId: typeof author.userId === "string" ? author.userId : "",
      authorName: typeof author.displayName === "string" ? author.displayName : "",
      publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : "",
      workType: isWorkType(workType) ? workType : null,
    });
  }
  // A page whose every entry was malformed is a broken read, not an empty feed.
  if (data.length > 0 && items.length === 0) return null;
  void locale;
  return items;
}

/**
 * The nine types the reader surface knows. Kept as a list rather than a cast so
 * an unknown value from a newer API renders as no chip, instead of crashing the
 * whole list on `workTypeLabels[value]`.
 */
const WORK_TYPES: readonly string[] = Object.freeze([
  "novel", "short_story", "poetry", "essay", "criticism",
  "literary_criticism", "nonfiction", "serial", "other",
]);

/** The author directory, not a profile: `/authors` and `/en/authors`. */
function authorsIndexPath(locale: Locale): string {
  return locale === "zh-CN" ? "/authors" : `/${locale}/authors`;
}

function isWorkType(value: unknown): value is WorkType {
  return typeof value === "string" && WORK_TYPES.includes(value);
}
