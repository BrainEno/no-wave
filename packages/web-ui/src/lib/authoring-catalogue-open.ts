import { AUTHORING_EXPECTED_ACTOR_HEADER, isRecord, parseRetryAfterSeconds } from "@bot-thk/web-http";
import { apiErrorCode } from "./api-error.ts";
import { readCataloguePage, type CatalogueEntry, type CatalogueOpenIntent } from "./authoring-catalogue.ts";

export type CatalogueEditableArticle = Omit<CatalogueEntry, "deletedAt"> & {
  revision: string; contentBlocks: unknown[]; contentBlocksVersion: number; publishedAt: string | null;
};

export class CatalogueReadError extends Error {
  readonly kind: "account-changed" | "unauthenticated" | "missing" | "limited";
  readonly retryAt: number;
  constructor(kind: CatalogueReadError["kind"], message: string, retryAt = 0) {
    super(message); this.name = "CatalogueReadError"; this.kind = kind; this.retryAt = retryAt;
  }
}

/** Detail reads never choose a document by themselves: the workspace supplies its live leave-token predicate. */
export class CatalogueDocumentReader {
  private version = 0;
  private abort: AbortController | null = null;
  private fetcher: (url: string, init: RequestInit) => Promise<Response>;
  private retryAt = 0;
  constructor(fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
    this.fetcher = fetcher;
  }
  cancel() { this.version++; this.abort?.abort(); }

  async read(intent: CatalogueOpenIntent, stillCurrent: () => boolean): Promise<CatalogueEditableArticle | null> {
    this.cancel();
    const version = this.version;
    const current = () => version === this.version && stillCurrent();
    if (!current()) return null;
    if (Date.now() < this.retryAt) throw new CatalogueReadError("limited", "仍在请求等待期，请稍后手动重新读取目录所选版本。", this.retryAt);
    this.abort = new AbortController();
    try {
      const response = await this.fetcher(`/api/authoring/catalogue/${encodeURIComponent(intent.id)}?locale=${encodeURIComponent(intent.locale)}`, {
        credentials: "same-origin", cache: "no-store", signal: this.abort.signal,
        headers: { accept: "application/json", [AUTHORING_EXPECTED_ACTOR_HEADER]: encodeURIComponent(intent.actor) },
      });
      if (!current()) return null;
      const payload: unknown = await response.json().catch(() => null);
      if (!current()) return null;
      if (!response.ok) {
        if (apiErrorCode(payload) === "ACCOUNT_CHANGED") throw new CatalogueReadError("account-changed", "目录链接属于另一登录账户，编辑区未改变。请返回目录确认当前账户。");
        if (response.status === 401) throw new CatalogueReadError("unauthenticated", "登录已失效，未打开作品。请在新标签页重新登录原账户后重试。");
        if (response.status === 404) throw new CatalogueReadError("missing", "所选语言版本不可编辑，可能已删除、已移动或不属于当前账户；没有回退到其他语言。");
        if (response.status === 429) {
          const seconds = parseRetryAfterSeconds(response.headers.get("retry-after")) ?? 1;
          this.retryAt = Date.now() + seconds * 1000;
          throw new CatalogueReadError("limited", `请求受限，请等待 ${seconds} 秒后手动重试。`, this.retryAt);
        }
        throw new Error("暂时无法打开目录作品，当前编辑区未改变，请手动重试。");
      }
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      if (!data || data.id !== intent.id || data.locale !== intent.locale || data.authorId !== intent.actor ||
          typeof data.revision !== "string" || !/^(0|[1-9]\d{0,18})$/.test(data.revision) || BigInt(data.revision) > 9223372036854775807n ||
          !Array.isArray(data.contentBlocks) || !Number.isSafeInteger(data.contentBlocksVersion) || Number(data.contentBlocksVersion) < 0 ||
          data.publishedAt !== null && (typeof data.publishedAt !== "string" || !Number.isFinite(Date.parse(data.publishedAt)))) throw new Error("作品详情无法准确确认身份、语言或修订，编辑区未改变。");
      const entry = readCataloguePage({ items: [{ ...data, deletedAt: null }], total: 1, works: 1, facets: [], nextCursor: null }).items[0]!;
      const { deletedAt: _deletedAt, ...metadata } = entry;
      return { ...metadata, revision: data.revision, contentBlocks: data.contentBlocks, contentBlocksVersion: Number(data.contentBlocksVersion), publishedAt: data.publishedAt };
    } catch (error) {
      if (!current()) return null;
      throw error instanceof Error ? error : new Error("打开作品失败，编辑区未改变。");
    }
  }
}
