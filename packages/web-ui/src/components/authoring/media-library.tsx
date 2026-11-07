import { Link } from "@/lib/framework/link.tsx";
import { useCallback, useEffect, useState } from "react";

/**
 * The author's media library (ADR 0022).
 *
 * Every image the author has uploaded, and — the only reason to open this page —
 * which of them nothing uses. An asset is an *orphan* when no work points at it:
 * not a draft that will be published later, not a tombstone that can be
 * restored, just bytes being paid for and shown to nobody.
 *
 * The list is the author's own, and the reference check behind the badge is the
 * API's: it reads every work's content, because knowing that nothing uses an
 * image means looking at everything that could. The delete button is therefore
 * disabled for an asset that is used, and the works that use it are listed
 * instead of a button that would only fail.
 *
 * Nothing here deletes on a schedule. Reclaiming storage is a decision about
 * somebody's work, and a decision is what a person is for.
 *
 * A reference is not always described. The image may be used by another author's
 * unpublished draft, and the owner of the bytes is not the owner of the words:
 * the API counts that use — it is what keeps the image alive — but sends no
 * title, and this page says only what it is allowed to say. `DELETE_ENABLED`
 * below is the switch that holds the delete button back while a fix to the
 * reference check is being verified; nothing else about the page changes when it
 * is turned back on.
 *
 * It is shared UI (`@bot-thk/web-ui`), so it reaches the router only through
 * `@/lib/framework/*` and names no framework of its own.
 */

/**
 * Where an image is used, and — when the page is allowed to say — by what.
 *
 * `kind` is how the card tells the two homes apart: a body and a profile picture
 * are different sentences in Chinese, and an avatar has no title to quote.
 * `redacted` is the answer to "may you name it?": the API counts every use, but
 * it does not hand one author's draft titles to another, so a use it will not
 * name arrives with `redacted: true` and empty fields.
 */
type MediaReference =
  | { kind: "avatar" }
  | {
    kind: "work";
    articleId: string;
    slug: string;
    title: string;
    locale: string;
    state: "draft" | "published" | "deleted";
    redacted: boolean;
  };

/**
 * Whether the delete button is on the page.
 *
 * Off, for now. The reference check behind the orphan badge was found to miss
 * two kinds of use — a cover stored under the API's own `/api/v1/media/…`
 * address, and a profile picture — which made live images look unused and
 * offered them for deletion. That check is fixed in the API; while the fix is
 * being verified the button is the part that stays off, because its mistakes are
 * the only ones on this page that cannot be undone. Flipping this to `true`
 * restores the button with no other change.
 *
 * This is only the page half. The API has its own switch
 * (`MEDIA_DELETE_ENABLED`, default off since #156) and answers 409
 * `MEDIA_DELETE_DISABLED` when it is off — hiding a button here does nothing for
 * a Flutter build or a `curl`, so the server had to be able to refuse on its
 * own. Turning this on before the deployment switch is on shows a button whose
 * press is refused; the API decides, this only decides what is offered.
 */
const DELETE_ENABLED = false;

type MediaItem = {
  id: string;
  src: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
  orphan: boolean;
  referencedBy: MediaReference[];
};

type MediaPage = { items: MediaItem[]; nextCursor: string | null };

type State = "loading" | "ready" | "error" | "unconfigured";

/** The page size the library asks for; the API's default is the same number. */
const PAGE_SIZE = 24;

function isItem(value: unknown): value is MediaItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<MediaItem>;
  return typeof item.id === "string" && typeof item.src === "string" &&
    typeof item.byteSize === "number" && typeof item.width === "number" &&
    typeof item.height === "number" && typeof item.createdAt === "string" &&
    typeof item.orphan === "boolean" && Array.isArray(item.referencedBy);
}

function pageOf(payload: unknown): MediaPage {
  const data = typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : null;
  if (typeof data !== "object" || data === null || !Array.isArray((data as { items?: unknown }).items)) {
    throw new Error("媒体库响应格式不正确。");
  }
  const items = (data as { items: unknown[] }).items
    .filter(isItem)
    // A reference the page cannot read is dropped rather than rendered as
    // `《undefined》`: the count behind the badge is the API's, and a missing
    // sentence costs less than a wrong one.
    .map((item) => ({ ...item, referencedBy: item.referencedBy.filter(isReference) }));
  const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
  return { items, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

/** A size a reader can compare at a glance; the exact byte count is in the title. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function localDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : "未知时间";
}

const STATE_LABEL: Record<"draft" | "published" | "deleted", string> = {
  draft: "草稿",
  published: "已发表",
  deleted: "回收站",
};

/** What an unnamed use is, in the author's language. Nothing else is known. */
const REDACTED_LABEL: Record<"draft" | "published" | "deleted", string> = {
  draft: "其他作者未发布的草稿",
  published: "其他作者的作品",
  deleted: "其他作者回收站里的作品",
};

function isReference(value: unknown): value is MediaReference {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { kind?: unknown };
  if (entry.kind === "avatar") return true;
  return entry.kind === "work" && typeof (value as { state?: unknown }).state === "string";
}

/**
 * One use, in one phrase.
 *
 * An avatar has no title, and a use the API will not name has no title either;
 * both are still counted, so both are still said — just not as `《》`.
 */
function describeReference(entry: MediaReference): string {
  if (entry.kind === "avatar") return "某位作者的头像";
  const label = STATE_LABEL[entry.state] ?? entry.state;
  if (entry.redacted) return REDACTED_LABEL[entry.state] ?? "其他作者的作品";
  return entry.title ? `《${entry.title}》（${label}）` : `${label}作品`;
}

export function MediaLibrary() {
  const [state, setState] = useState<State>("loading");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async (loadCursor: string | null, append: boolean) => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (loadCursor) query.set("cursor", loadCursor);
    try {
      const response = await fetch(`/api/authoring/media?${query.toString()}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 503) {
        // Object storage is not configured for this deployment. An empty library
        // would be a lie that sends somebody looking for images that were never
        // accepted in the first place.
        setState("unconfigured");
        return;
      }
      if (response.status === 401) {
        setState("ready");
        setError("登录状态已失效，请重新登录。");
        return;
      }
      if (!response.ok) {
        throw new Error(errorMessage(await response.json().catch(() => null), "暂时无法载入媒体库，请稍后重试。"));
      }
      const page = pageOf(await response.json());
      setItems((current) => (append ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setState("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法载入媒体库，请稍后重试。");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load(null, false);
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    setError("");
    try {
      await load(cursor, true);
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Delete one unused asset.
   *
   * The confirm names what the button does, because this is the one action on
   * the page that cannot be undone: the object and the row both go.
   *
   * A 409 is not a failure to retry — it is the API disagreeing with the badge,
   * because a work was saved in the meantime. The works it names are shown, and
   * the item is refreshed so the button goes away.
   */
  async function remove(item: MediaItem) {
    if (window.confirm("删除这张图片？图片文件与记录都会移除，且无法复原。") === false) return;
    setRemoving(item.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/authoring/media/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setError("登录状态已失效，请重新登录。");
        return;
      }
      if (response.status === 409) {
        const payload = await response.json().catch(() => null);
        const used = typeof payload === "object" && payload !== null
          ? (payload as { error?: { details?: { referencedBy?: MediaReference[] } } }).error?.details?.referencedBy ?? []
          : [];
        setError(used.length > 0
          ? `这张图片正在被使用，无法删除：${used.filter(isReference).map(describeReference).join("、")}。`
          : "这张图片正在被使用，无法删除。");
        setItems((current) => current.map((entry) => (
          entry.id === item.id ? { ...entry, orphan: false, referencedBy: used } : entry
        )));
        return;
      }
      if (response.status === 404) {
        // Gone already — from here the image is not in the library either way.
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        setNotice("这张图片已经不在媒体库里了。");
        return;
      }
      if (response.status === 503) {
        // The bucket could not be reached. The API's message is in English like
        // every other error it sends, and this one is worth saying in the
        // author's language: nothing was deleted.
        setError("图片存储暂时不可用，这张图片没有被删除。");
        return;
      }
      if (!response.ok) {
        throw new Error(errorMessage(await response.json().catch(() => null), "删除失败，请稍后重试。"));
      }
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice("图片已删除，文件与记录都已移除。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败，请稍后重试。");
    } finally {
      setRemoving(null);
    }
  }

  if (state === "loading") {
    return (
      <section className="nw-media">
        <h1><span className="nw-zh">媒体库</span> <i>Media</i></h1>
        <p className="nw-auth-status" role="status">正在载入媒体库…</p>
      </section>
    );
  }

  if (state === "unconfigured") {
    return (
      <section className="nw-media">
        <h1><span className="nw-zh">媒体库</span> <i>Media</i></h1>
        <p className="nw-auth-error" role="alert">
          这个部署没有配置图片存储（S3 兼容对象存储），上传与媒体库都不可用。配置方法见
          {" "}<code>docs/operations/web-authoring.md</code>。
        </p>
        <p className="nw-m"><Link className="nw-btn" href="/write">回到写作台</Link></p>
      </section>
    );
  }

  const orphans = items.filter((item) => item.orphan).length;

  return (
    <section className="nw-media">
      <div className="nw-media-head">
        <h1><span className="nw-zh">媒体库</span> <i>Media</i></h1>
        <Link className="nw-btn" href="/write">回到写作台</Link>
      </div>
      <p className="nw-ep">
        这里是你上传过的全部图片。「未被引用」表示没有任何作品（含草稿与回收站里的作品）、也没有任何作者头像用到它 ——
        只有这类图片可以删除{DELETE_ENABLED ? "" : "；删除目前暂时停用，等待引用检查的修复验证完成后恢复"}。
      </p>
      <p className="nw-m" role="status">
        共 {items.length} 张，其中 {orphans} 张未被引用。
      </p>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}

      {state === "error" ? (
        <p><button className="nw-btn" type="button" onClick={() => { setError(""); setState("loading"); void load(null, false); }}>重新载入</button></p>
      ) : null}

      {items.length === 0 && state === "ready"
        ? <p className="nw-m">还没有上传过图片。在写作台的编辑器里插入图片后，它会出现在这里。</p>
        : (
          <ul className="nw-media-grid">
            {items.map((item) => (
              <li className={item.orphan ? "nw-media-card nw-media-orphan" : "nw-media-card"} key={item.id}>
                <img className="nw-media-thumb" src={item.src} alt="" width={item.width} height={item.height} loading="lazy" />
                <div className="nw-media-meta">
                  <small>{item.width}×{item.height} · {humanSize(item.byteSize)}</small>
                  <small>{localDate(item.createdAt)}</small>
                </div>
                {item.orphan ? (
                  <>
                    <p className="nw-media-flag" data-state="orphan">未被引用</p>
                    {DELETE_ENABLED
                      ? (
                        <button
                          className="nw-btn"
                          type="button"
                          disabled={removing === item.id}
                          onClick={() => void remove(item)}
                        >
                          {removing === item.id ? "删除中…" : "删除"}
                        </button>
                      )
                      : <p className="nw-media-note">删除暂时停用：等待引用检查的修复验证完成。</p>}
                  </>
                ) : (
                  <p className="nw-media-flag" data-state="used">
                    正在被使用：{item.referencedBy.length > 0
                      ? item.referencedBy.map(describeReference).join("、")
                      : "已被引用的图片"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

      {cursor ? (
        <p className="nw-media-more">
          <button className="nw-btn" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "载入中…" : "载入更多"}
          </button>
        </p>
      ) : null}
    </section>
  );
}
