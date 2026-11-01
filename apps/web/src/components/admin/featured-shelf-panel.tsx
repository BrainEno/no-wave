"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

/**
 * The featured shelf, arranged.
 *
 * The page render only knows that a session *might* exist — the token cookies
 * are scoped below `/`, so a private page cannot read them and must not. Who the
 * visitor is, and whether they may curate at all, comes from
 * `GET /api/authoring/session`; the API answers that question once and the panel
 * believes it. An account that is not an editor gets an explanation rather than
 * a disabled button: the controls are simply not rendered.
 *
 * The arrangement is edited locally and sent whole. Two editors moving different
 * works cannot be told apart from one editor re-ordering three, so there is no
 * "move this one up" request — only "this is the shelf, in this order". That is
 * also why the ceiling lives here: the screen stops offering more slots before
 * the API has to refuse them.
 *
 * Shared by the Next.js page and the React Router prototype route: it imports
 * only `next/link`, which the prototype shims.
 */

/** Mirrors `MAX_FEATURED_ARTICLES` upstream; the API remains the authority. */
const MAX_FEATURED = 20;

type ShelfWork = { id: string; title: string; authorName: string };
type ApiErrorPayload = { error?: { message?: unknown } };

type Phase = "checking" | "ready" | "signed-out" | "not-editor" | "error";

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data: unknown }).data
    : null;
}

function messageOf(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

/**
 * The only fields the screen needs, read defensively: an unreadable row is
 * dropped rather than rendered as "undefined" in an editor's hands.
 */
function toShelfWork(value: unknown): ShelfWork | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; title?: unknown; author?: { displayName?: unknown; username?: unknown } | null };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  const author = candidate.author;
  const authorName = author && typeof author === "object"
    ? (typeof author.displayName === "string" ? author.displayName : typeof author.username === "string" ? author.username : "")
    : "";
  return { id: candidate.id, title: typeof candidate.title === "string" ? candidate.title : "（无题）", authorName };
}

function toShelfWorks(payload: unknown): ShelfWork[] {
  const data = dataOf(payload);
  if (!Array.isArray(data)) return [];
  return data.map(toShelfWork).filter((work): work is ShelfWork => work !== null);
}

/** The arrangement as it stands, which is what gets sent and compared. */
function idsOf(works: readonly ShelfWork[]): string {
  return JSON.stringify(works.map((work) => work.id));
}

export function FeaturedShelfPanel() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [works, setWorks] = useState<ShelfWork[]>([]);
  /** What the API holds, kept whole so "discard" can restore titles, not just ids. */
  const [saved, setSaved] = useState<ShelfWork[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShelfWork[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<null | "save" | "search">(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (session.status === 401) { setPhase("signed-out"); return; }
        if (!session.ok) throw new Error("无法确认登录状态。");
        // `isEditor` is the assembled fact, so the panel never has to know how
        // editors are minted — only whether this account is one.
        const account = dataOf(await session.json().catch(() => null));
        const isEditor = typeof account === "object" && account !== null &&
          (account as { isEditor?: unknown }).isEditor === true;
        if (!isEditor) { setPhase("not-editor"); return; }

        const shelf = await fetch("/api/authoring/featured", { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (!shelf.ok) throw new Error(messageOf(await shelf.json().catch(() => null), "精选暂时无法载入。"));
        const loaded = toShelfWorks(await shelf.json());
        setWorks(loaded);
        setSaved(loaded);
        setPhase("ready");
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "精选暂时无法载入。");
          setPhase("error");
        }
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  const dirty = idsOf(works) !== idsOf(saved);

  async function save() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/authoring/featured", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleIds: works.map((work) => work.id) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) { setPhase("signed-out"); return; }
      if (response.status === 403) throw new Error("这个账号没有编辑权限，改动没有保存。");
      if (!response.ok) throw new Error(messageOf(payload, "保存失败，精选没有改动。"));
      // The answer is the shelf as the API now holds it, so the screen and the
      // front page cannot disagree the moment after a save.
      const stored = toShelfWorks(payload);
      setWorks(stored);
      setSaved(stored);
      setNotice(stored.length === 0 ? "已保存：精选现在是空的。" : `已保存：${stored.length} 篇。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，精选没有改动。");
    } finally {
      setBusy(null);
    }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("search");
    setError("");
    try {
      const response = await fetch(`/api/authoring/featured/candidates?q=${encodeURIComponent(query)}`, {
        credentials: "same-origin", cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) { setPhase("signed-out"); return; }
      if (!response.ok) throw new Error(messageOf(payload, "暂时无法搜索已发布的作品。"));
      setResults(toShelfWorks(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法搜索已发布的作品。");
    } finally {
      setBusy(null);
    }
  }

  function move(index: number, delta: number) {
    setNotice("");
    setWorks((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function add(work: ShelfWork) {
    setNotice("");
    setWorks((current) => {
      if (current.length >= MAX_FEATURED) return current;
      if (current.some((existing) => existing.id === work.id)) return current;
      return [...current, work];
    });
  }

  if (phase === "checking") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-featured-checking">
        <h1 id="nw-featured-checking"><span className="nw-zh">精选</span> <i>Featured</i></h1>
        <p className="nw-auth-status" role="status" style={{ marginTop: 24 }}>正在确认登录状态，请稍候……</p>
      </section>
    );
  }

  if (phase === "signed-out") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-featured-out">
        <h1 id="nw-featured-out"><span className="nw-zh">尚未登录</span> <i>Signed out</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>这个会话已经结束，正在前往登录页……</p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in?next=%2Fadmin%2Ffeatured">前往登录</Link>
        </div>
      </section>
    );
  }

  if (phase === "not-editor") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-featured-denied">
        <h1 id="nw-featured-denied"><span className="nw-zh">精选</span> <i>Featured</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          精选由编辑挑选。这个账号还没有编辑权限，所以这里没有可操作的内容 —— 不是页面没加载好。
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn" href="/write">回到写作台</Link>
        </div>
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-featured-error">
        <h1 id="nw-featured-error"><span className="nw-zh">精选暂时无法载入</span> <i>Unavailable</i></h1>
        <p className="nw-auth-error" role="alert" style={{ marginTop: 24 }}>{error}</p>
        <div className="nw-auth-switch">
          <Link className="nw-btn" href="/write">回到写作台</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-featured-title">
      <h1 id="nw-featured-title"><span className="nw-zh">精选</span> <i>Featured</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        首页「精选」按下面的顺序展示，最多 {MAX_FEATURED} 篇。改动在这里排好，点保存才会生效；
        只有已发布的作品能上精选，一篇被撤下的作品会先离开列表，重新发表后回到原来的位置。
      </p>

      {notice ? <p className="nw-auth-status" role="status" style={{ marginTop: 24 }}>{notice}</p> : null}
      {error ? <p className="nw-auth-error" role="alert" style={{ marginTop: 24 }}>{error}</p> : null}

      <ol className="nw-curate-list" style={{ marginTop: 32, padding: 0, listStyle: "none" }}>
        {works.map((work, index) => (
          <li key={work.id} className="nw-curate-row">
            <span className="nw-m nw-curate-index">{index + 1}</span>
            <span className="nw-curate-title">{work.title}</span>
            <span className="nw-m">{work.authorName}</span>
            <span className="nw-curate-actions">
              <button type="button" className="nw-btn" aria-label={`把《${work.title}》上移`}
                disabled={index === 0 || busy !== null} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="nw-btn" aria-label={`把《${work.title}》下移`}
                disabled={index === works.length - 1 || busy !== null} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="nw-btn" aria-label={`把《${work.title}》移出精选`}
                disabled={busy !== null}
                onClick={() => { setNotice(""); setWorks((current) => current.filter((_, at) => at !== index)); }}>移除</button>
            </span>
          </li>
        ))}
        {works.length === 0
          ? <li className="nw-m" style={{ padding: "16px 0", borderTop: "1px solid var(--ink)" }}>精选还是空的。</li>
          : null}
      </ol>

      <div className="nw-auth-switch">
        <button type="button" className="nw-btn nw-pri" disabled={!dirty || busy !== null} onClick={() => void save()}>
          {busy === "save" ? "正在保存……" : "保存顺序"}
        </button>
        <button type="button" className="nw-btn" disabled={!dirty || busy !== null}
          onClick={() => { setNotice(""); setError(""); setWorks([...saved]); }}>
          放弃改动
        </button>
        <span className="nw-m" role="status">{dirty ? "有未保存的改动。" : "已是最新。"}</span>
      </div>

      <h2 style={{ marginTop: 48, fontSize: 24 }}><span className="nw-zh">加入作品</span></h2>
      <form className="nw-auth-switch" onSubmit={(event) => void search(event)}>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索已发布的作品" aria-label="搜索已发布的作品"
          style={{ minHeight: 48, padding: "0 12px", minWidth: 260, border: "1px solid var(--ink)", background: "none" }} />
        <button type="submit" className="nw-btn" disabled={busy !== null}>
          {busy === "search" ? "正在搜索……" : "搜索"}
        </button>
      </form>
      <ul style={{ marginTop: 16, padding: 0, listStyle: "none" }}>
        {results.map((work) => {
          const already = works.some((existing) => existing.id === work.id);
          return (
            <li key={work.id} className="nw-curate-row">
              <span className="nw-curate-title">{work.title}</span>
              <span className="nw-m">{work.authorName}</span>
              <span className="nw-curate-actions">
                <button type="button" className="nw-btn" disabled={already || works.length >= MAX_FEATURED || busy !== null}
                  onClick={() => add(work)}>
                  {already ? "已在精选" : "加入"}
                </button>
              </span>
            </li>
          );
        })}
        {results.length === 0 && busy !== "search"
          ? <li className="nw-m" style={{ padding: "16px 0", borderTop: "1px solid var(--ink)" }}>
            搜索已发布的作品，把它们加入精选。
          </li>
          : null}
      </ul>
    </section>
  );
}
