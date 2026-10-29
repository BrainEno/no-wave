"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArticleEditor, type AuthoringArticle } from "./article-editor.tsx";

type WorkspaceState = "loading" | "unauthenticated" | "ready" | "error";

function isArticle(value: unknown): value is AuthoringArticle {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AuthoringArticle>;
  return typeof item.id === "string" && typeof item.title === "string" &&
    typeof item.slug === "string" && Array.isArray(item.contentBlocks) &&
    (item.status === "draft" || item.status === "published");
}

function messageOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return "暂时无法载入写作台，请稍后重试。";
}

export function AuthoringWorkspace() {
  const [state, setState] = useState<WorkspaceState>("loading");
  const [articles, setArticles] = useState<AuthoringArticle[]>([]);
  const [selected, setSelected] = useState<AuthoringArticle | null>(null);
  const [newCounter, setNewCounter] = useState(0);
  const [error, setError] = useState("");

  async function reloadArticles() {
    const response = await fetch("/api/authoring/articles", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { setState("unauthenticated"); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("作品列表响应格式不正确。");
    setArticles(data.filter(isArticle));
    setState("ready");
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (response.status === 401) { setState("unauthenticated"); return; }
        if (!response.ok) throw new Error("无法验证登录状态。");
        await reloadArticles();
      } catch (caught) {
        if (active) { setError(caught instanceof Error ? caught.message : "暂时无法载入写作台。"); setState("error"); }
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  async function afterSave(article: AuthoringArticle) {
    setSelected(article);
    setArticles((current) => [article, ...current.filter((item) => item.id !== article.id)].slice(0, 100));
    try { await reloadArticles(); } catch (caught) {
      setError(caught instanceof Error ? caught.message : "作品已保存，但列表刷新失败。");
    }
  }

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: "{}" });
    } finally {
      setSelected(null);
      setState("unauthenticated");
    }
  }

  if (state === "loading") return <p role="status">正在验证登录状态并载入草稿……</p>;
  if (state === "unauthenticated") {
    return <section className="nw-auth-panel"><h1><span className="nw-zh">先登录</span> <i>Sign in</i></h1><p>写作、保存草稿与发布功能需要有效的登录会话。</p><Link className="nw-btn nw-pri" href="/sign-in?next=%2Fwrite">登录或创建账户</Link></section>;
  }
  if (state === "error") return <section><p className="nw-auth-error" role="alert">{error}</p><button className="nw-btn" type="button" onClick={() => { setError(""); setState("loading"); window.location.reload(); }}>重新载入</button></section>;

  return (
    <section className="nw-authoring">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <h1><span className="nw-zh">写作台</span> <i>Authoring</i></h1>
        <button className="nw-btn" type="button" onClick={() => void signOut()}>退出登录</button>
      </div>
      <p className="nw-ep" style={{ marginTop: 18 }}>草稿与发布状态由 API 持久化；关闭页面后，可从作品列表继续编辑。</p>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      <div className="nw-authoring-grid">
        <aside className="nw-authoring-sidebar" aria-label="我的作品">
          <h2>我的作品（{articles.length}）</h2>
          <button className="nw-btn nw-pri" type="button" onClick={() => { setSelected(null); setNewCounter((value) => value + 1); }}>新建作品 +</button>
          {articles.length === 0 ? <p className="nw-m">还没有草稿或已发布作品。</p> : articles.map((article) => (
            <button className="nw-authoring-article" key={article.id} type="button" aria-current={selected?.id === article.id ? "true" : undefined} onClick={() => setSelected(article)}>
              <span>{article.title}</span>
              <small>{article.status === "published" ? "已发布" : "草稿"} · {article.updatedAt ? new Date(article.updatedAt).toLocaleDateString("zh-CN") : article.slug}</small>
            </button>
          ))}
        </aside>
        <div>
          <ArticleEditor key={selected?.id ?? `new-${newCounter}`} article={selected} onSaved={(article) => void afterSave(article)} />
        </div>
      </div>
    </section>
  );
}
