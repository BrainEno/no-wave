"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import {
  followButtonLabel,
  likeButtonLabel,
  likeStateAfterWrite,
  nextLikeIntent,
  parseLikeState,
  signInToEngageMessage,
  type LikeState,
} from "@/lib/engagement.ts";

/**
 * 阅读页文末的两个读者动作（issue #168）：收藏这篇作品、关注这位作者。
 *
 * 服务端早就有了这两件事，浏览器这一侧一直没有入口——页面能读，读完却什么都
 * 做不了。两个按钮都是客户端组件，因为它们改的是「我」的状态，而页面本身是
 * 服务端渲染给所有人的。
 *
 * 三条共同规则：
 *
 * - **401 不是失败**，是「请先登录」。读者点一下就知道要登录，而不是看到一个
 *   红字错误；提示里带一条回本页的登录链接。
 * - **失败不谎报成功**：按钮回到原来的文案并显示原因，绝不在服务端拒绝之后
 *   假装已收藏。
 * - **写请求带不缓存、同源**：与页面其他写请求一致，代理才有 cookie。
 */

function readError(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return null;
}

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : null;
}

/**
 * 「收藏」按钮。
 *
 * 初始状态由服务端页面给出（读者已登录时它知道 `likedByViewer`），所以按钮在
 * 水合之前就是对的，不会先闪一下「未收藏」再纠正。
 */
export function ArticleSaveButton({ slug, locale, initial }: { slug: string; locale: Locale; initial?: LikeState | null }) {
  const [state, setState] = useState<LikeState>(initial ?? parseLikeState(null));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);

  /**
   * 补上真实状态。
   *
   * 文章页是给所有人渲染的同一份 HTML，所以它不读 cookie，也就不知道这位访客
   * 是否已经收藏过。按钮先按「未收藏」出现是诚实的——但对一位两周前就收藏过的
   * 读者，一个永远显示「收藏 · 0」的按钮同样是在撒谎。挂载后读一次真实状态，
   * 读不到就保持原样：一个查不到的计数不值得让页面出错。
   */
  useEffect(() => {
    if (initial) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/articles/${encodeURIComponent(slug)}/like?locale=${encodeURIComponent(locale)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload: unknown = await response.json().catch(() => null);
        if (active) setState((current) => likeStateAfterWrite(current, dataOf(payload)));
      } catch {
        // Keep the state the page rendered with.
      }
    })();
    return () => { active = false; };
  }, [slug, locale, initial]);

  const write = useCallback(async (liked: boolean) => {
    setPending(true);
    setNotice("");
    setNeedsSignIn(false);
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(slug)}/like?locale=${encodeURIComponent(locale)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ liked }),
      });
      if (response.status === 401) {
        setNeedsSignIn(true);
        setNotice(signInToEngageMessage(locale));
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(readError(payload) ?? (locale === "en" ? "Could not save this work." : "收藏失败，请稍后重试。"));
        return;
      }
      setState((current) => likeStateAfterWrite(current, dataOf(payload)));
    } catch {
      setNotice(locale === "en" ? "Could not reach the service." : "无法连接到服务，请检查网络。");
    } finally {
      setPending(false);
    }
  }, [slug, locale]);

  return (
    <div className="nw-engage">
      <button
        className={state.likedByViewer ? "nw-btn nw-sec" : "nw-btn"}
        type="button"
        disabled={pending}
        aria-pressed={state.likedByViewer}
        onClick={() => {
          const intent = nextLikeIntent(state, pending);
          if (intent) void write(intent.liked);
        }}
      >
        {likeButtonLabel(state, pending, locale)}
      </button>
      {notice ? (
        <p className="nw-engage-note" role="status">
          {notice}{" "}
          {needsSignIn ? <Link className="nw-engage-link" href={"/sign-in?next=" + encodeURIComponent(`/articles/${slug}`)}>{locale === "en" ? "Sign in" : "前往登录"} →</Link> : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 阅读页文末的关注按钮，紧挨着「关于作者」。
 *
 * 自己关注自己是一个服务端会拒绝的请求；页面因此不显示按钮，而不是显示一个
 * 点了会出错的按钮。`viewerIsAuthor` 由服务端算出来，客户端不猜。
 */
export function AuthorFollowButton({ authorId, locale, initialFollowing, viewerIsAuthor = false }: {
  authorId: string;
  locale: Locale;
  initialFollowing: boolean;
  viewerIsAuthor?: boolean;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);

  if (viewerIsAuthor) return null;

  async function submit() {
    const target = !following;
    setPending(true);
    setNotice("");
    setNeedsSignIn(false);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(authorId)}/follow?locale=${encodeURIComponent(locale)}`, {
        method: target ? "POST" : "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setNeedsSignIn(true);
        setNotice(signInToEngageMessage(locale));
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(readError(payload) ?? (locale === "en" ? "Could not change your subscription." : "关注状态更新失败，请稍后重试。"));
        return;
      }
      // The API answers with the author's own profile; `isFollowing` is the
      // server's answer, not the one this button was hoping for.
      const data = dataOf(payload);
      setFollowing(typeof data === "object" && data !== null && (data as { isFollowing?: unknown }).isFollowing === true);
    } catch {
      setNotice(locale === "en" ? "Could not reach the service." : "无法连接到服务，请检查网络。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="nw-engage">
      <button
        className={following ? "nw-btn nw-sec" : "nw-btn"}
        type="button"
        disabled={pending}
        aria-pressed={following}
        onClick={() => void submit()}
      >
        {followButtonLabel(following, pending, locale)}
      </button>
      {notice ? (
        <p className="nw-engage-note" role="status">
          {notice}{" "}
          {needsSignIn ? <Link className="nw-engage-link" href={"/sign-in?next=" + encodeURIComponent(`/authors/${authorId}`)}>{locale === "en" ? "Sign in" : "前往登录"} →</Link> : null}
        </p>
      ) : null}
    </div>
  );
}
